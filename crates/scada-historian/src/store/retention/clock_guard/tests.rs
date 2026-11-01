use super::*;
use crate::store::recovery::{FenceSource, RetentionFence};
mod integration;
mod invalid;
fn policy() -> RetentionClockPolicy {
    RetentionClockPolicy {
        policy_id: "policy".into(),
        revision: 1,
        tolerance_ms: 10,
        max_observation_gap_ms: 1000,
        max_cutoff_advance_ms: 500,
        initial_cutoff_ceiling_ms: Some(1500),
    }
}
fn sample(wall: i64, mono: u64) -> ClockSample {
    ClockSample {
        clock_epoch: "epoch".into(),
        wall_time_ms: wall,
        monotonic_ms: mono,
        trusted: true,
    }
}
fn initial() -> StoreRecoveryState {
    StoreRecoveryState {
        snapshot_commit: 0,
        retention_fence: RetentionFence {
            cutoff_ms: None,
            revision_commit: 0,
            source: FenceSource::Initial,
        },
        active_session_id: None,
        active_job: None,
    }
}
fn primed(p: &RetentionClockPolicy, s: ClockSample) -> GuardState {
    assess_retention(p, &GuardState::Unarmed, &s, 1000, &initial())
        .unwrap()
        .next_state
}
fn fenced(cutoff: i64) -> StoreRecoveryState {
    StoreRecoveryState {
        snapshot_commit: 3,
        retention_fence: RetentionFence {
            cutoff_ms: Some(cutoff),
            revision_commit: 3,
            source: FenceSource::SingleTrim {
                request_id: "trim".into(),
            },
        },
        ..initial()
    }
}
fn stable(p: &RetentionClockPolicy, cutoff: i64, recovery: &StoreRecoveryState) -> Assessment {
    assess_retention(
        p,
        &primed(p, sample(2000, 0)),
        &sample(2100, 100),
        cutoff,
        recovery,
    )
    .unwrap()
}
fn assert_suspended(result: Assessment, reason: SuspendReason) {
    assert_eq!(result.next_state, GuardState::Suspended { reason });
    assert_eq!(result.action, RetentionAction::WaitForClock);
}
#[test]
fn first_sample_only_primes_then_a_stable_sample_proposes_without_mutation() {
    let p = policy();
    let state = GuardState::Unarmed;
    let context = initial();
    let first = assess_retention(&p, &state, &sample(2000, 0), 1000, &context).unwrap();
    assert_eq!(first.action, RetentionAction::WaitForClock);
    assert!(matches!(first.next_state, GuardState::Primed { .. }));
    assert_eq!(state, GuardState::Unarmed);
    let next = assess_retention(&p, &first.next_state, &sample(2100, 100), 1000, &context).unwrap();
    assert!(matches!(next.next_state, GuardState::Tracking { .. }));
    assert_eq!(
        next.action,
        RetentionAction::ProposeJob {
            cutoff_ms: 1000,
            expected_cutoff_ms: None,
            snapshot_commit: 0,
            policy_id: "policy".into(),
            revision: 1
        }
    );
    assert_eq!(context, initial());
}

#[test]
fn duplicate_samples_cannot_warm_up_or_repeat_a_proposal() {
    let p = policy();
    let state = primed(&p, sample(2000, 0));
    let duplicate = assess_retention(&p, &state, &sample(2000, 0), 1000, &initial()).unwrap();
    assert_eq!(duplicate.next_state, state);
    assert_eq!(duplicate.action, RetentionAction::WaitForClock);
    let tracking = stable(&p, 1000, &initial()).next_state;
    let duplicate = assess_retention(&p, &tracking, &sample(2100, 100), 1000, &initial()).unwrap();
    assert_eq!(duplicate.next_state, tracking);
    assert_eq!(duplicate.action, RetentionAction::WaitForClock);
}

#[test]
fn each_clock_anomaly_suspends_instead_of_proposing() {
    let p = policy();
    let state = primed(&p, sample(2000, 100));
    let cases = [
        (
            ClockSample {
                trusted: false,
                ..sample(2100, 200)
            },
            SuspendReason::UntrustedClock,
        ),
        (
            ClockSample {
                clock_epoch: "new".into(),
                ..sample(2100, 200)
            },
            SuspendReason::ClockEpochChanged,
        ),
        (sample(1999, 200), SuspendReason::WallClockRegressed),
        (sample(2100, 99), SuspendReason::MonotonicClockRegressed),
        (
            sample(2100, 100),
            SuspendReason::MonotonicClockDiscontinuity,
        ),
        (sample(3001, 1101), SuspendReason::ObservationGap),
        (sample(2111, 200), SuspendReason::ClockDriftExceeded),
        (sample(i64::MAX, 200), SuspendReason::MalformedClockSample),
        (
            ClockSample {
                clock_epoch: "bad epoch".into(),
                ..sample(2100, 200)
            },
            SuspendReason::MalformedClockSample,
        ),
    ];
    for (s, reason) in cases {
        assert_suspended(
            assess_retention(&p, &state, &s, 1000, &initial()).unwrap(),
            reason,
        );
    }
}

#[test]
fn policy_snapshot_detects_revision_and_same_revision_content_changes() {
    let p = policy();
    let state = primed(&p, sample(2000, 0));
    for changed in [
        RetentionClockPolicy {
            revision: 2,
            ..p.clone()
        },
        RetentionClockPolicy {
            tolerance_ms: 11,
            ..p.clone()
        },
        RetentionClockPolicy {
            policy_id: "replacement".into(),
            ..p.clone()
        },
    ] {
        assert_suspended(
            assess_retention(&changed, &state, &sample(2100, 100), 1000, &initial()).unwrap(),
            SuspendReason::PolicyChanged,
        );
    }
}

#[test]
fn forward_jump_stays_latched_until_explicit_rearm_and_two_new_samples() {
    let p = policy();
    let state = primed(&p, sample(2000, 0));
    let jumped = assess_retention(&p, &state, &sample(9000, 100), 1000, &initial()).unwrap();
    assert_suspended(jumped.clone(), SuspendReason::ClockDriftExceeded);
    let later =
        assess_retention(&p, &jumped.next_state, &sample(9100, 200), 1000, &initial()).unwrap();
    assert_eq!(later, jumped);
    let untrusted = ClockSample {
        trusted: false,
        ..sample(9200, 300)
    };
    assert_eq!(
        assess_retention(&p, &later.next_state, &untrusted, 1000, &initial()).unwrap(),
        jumped
    );
    let restarted = assess_retention(
        &p,
        &later.next_state.rearm(),
        &sample(9100, 200),
        1000,
        &initial(),
    )
    .unwrap();
    assert_eq!(restarted.action, RetentionAction::WaitForClock);
    let warmed = assess_retention(
        &p,
        &restarted.next_state,
        &sample(9200, 300),
        1000,
        &initial(),
    )
    .unwrap();
    assert!(matches!(warmed.action, RetentionAction::ProposeJob { .. }));
}

#[test]
fn tolerance_and_observation_gap_are_inclusive_and_checked_in_both_directions() {
    let p = policy();
    let state = primed(&p, sample(2000, 0));
    for (wall, mono) in [(2090, 100), (2110, 100), (3000, 1000)] {
        assert!(matches!(
            assess_retention(&p, &state, &sample(wall, mono), 1000, &initial())
                .unwrap()
                .action,
            RetentionAction::ProposeJob { .. }
        ));
    }
    assert_suspended(
        assess_retention(&p, &state, &sample(2089, 100), 1000, &initial()).unwrap(),
        SuspendReason::ClockDriftExceeded,
    );
    let exact = RetentionClockPolicy {
        tolerance_ms: 0,
        ..p.clone()
    };
    assert!(matches!(
        stable(&exact, 1000, &initial()).action,
        RetentionAction::ProposeJob { .. }
    ));
    let stalled_wall = RetentionClockPolicy {
        tolerance_ms: 100,
        ..p
    };
    let state = primed(&stalled_wall, sample(2000, 0));
    assert!(matches!(
        assess_retention(&stalled_wall, &state, &sample(2000, 100), 1000, &initial())
            .unwrap()
            .next_state,
        GuardState::Tracking { .. }
    ));
}

#[test]
fn full_u64_monotonic_range_is_valid_but_wrap_is_regression() {
    let p = policy();
    let state = primed(&p, sample(2000, u64::MAX - 100));
    let valid = assess_retention(&p, &state, &sample(2100, u64::MAX), 1000, &initial()).unwrap();
    assert!(matches!(valid.action, RetentionAction::ProposeJob { .. }));
    assert_suspended(
        assess_retention(&p, &valid.next_state, &sample(2101, 0), 1000, &initial()).unwrap(),
        SuspendReason::MonotonicClockRegressed,
    );
    assert_suspended(
        assess_retention(
            &p,
            &primed(&p, sample(2000, 0)),
            &sample(2100, u64::MAX),
            1000,
            &initial(),
        )
        .unwrap(),
        SuspendReason::ObservationGap,
    );
}

#[test]
fn safe_wall_endpoints_and_wide_differences_do_not_overflow() {
    let max = crate::store::MAX_SAFE as i64;
    let p = RetentionClockPolicy {
        initial_cutoff_ceiling_ms: Some(max),
        ..policy()
    };
    for (wall, cutoff) in [(-max, -max), (max - 100, max)] {
        let state = primed(&p, sample(wall, 0));
        let result =
            assess_retention(&p, &state, &sample(wall + 100, 100), cutoff, &initial()).unwrap();
        assert!(matches!(result.action, RetentionAction::ProposeJob { .. }));
    }
    let state = primed(&p, sample(-max, 0));
    assert_suspended(
        assess_retention(&p, &state, &sample(max, 100), 1000, &initial()).unwrap(),
        SuspendReason::ClockDriftExceeded,
    );
    let state = primed(&p, sample(max - 100, 0));
    let result = assess_retention(&p, &state, &sample(max, 100), max, &fenced(-max)).unwrap();
    assert_eq!(
        result.action,
        RetentionAction::Deferred {
            reason: DeferredReason::CutoffAdvanceLimit
        }
    );
}

#[test]
fn first_cutoff_requires_an_explicit_ceiling_and_checks_future_first() {
    let p = policy();
    assert!(matches!(
        stable(&p, 1500, &initial()).action,
        RetentionAction::ProposeJob { .. }
    ));
    assert_eq!(
        stable(&p, 1501, &initial()).action,
        RetentionAction::Deferred {
            reason: DeferredReason::InitialCutoffLimit
        }
    );
    let unauthorized = RetentionClockPolicy {
        initial_cutoff_ceiling_ms: None,
        ..p
    };
    assert_eq!(
        stable(&unauthorized, 1000, &initial()).action,
        RetentionAction::Deferred {
            reason: DeferredReason::InitialCutoffNotAuthorized
        }
    );
    assert_eq!(
        stable(&unauthorized, 2101, &initial()).action,
        RetentionAction::Deferred {
            reason: DeferredReason::CutoffBeyondClock
        }
    );
}

#[test]
fn cutoff_fence_never_regresses_and_advance_limit_is_inclusive() {
    let p = policy();
    for cutoff in [-1, 0, 1000] {
        assert_eq!(
            stable(&p, cutoff, &fenced(1000)).action,
            RetentionAction::NoAdvance
        );
    }
    assert!(matches!(
        stable(&p, 1500, &fenced(1000)).action,
        RetentionAction::ProposeJob {
            expected_cutoff_ms: Some(1000),
            snapshot_commit: 3,
            ..
        }
    ));
    assert_eq!(
        stable(&p, 1501, &fenced(1000)).action,
        RetentionAction::Deferred {
            reason: DeferredReason::CutoffAdvanceLimit
        }
    );
    assert!(matches!(
        stable(&p, -500, &fenced(-1000)).action,
        RetentionAction::ProposeJob { .. }
    ));
}

#[test]
fn valid_clock_baseline_advances_during_defer_no_advance_and_stop_wait() {
    let p = policy();
    let recording = StoreRecoveryState {
        snapshot_commit: 1,
        active_session_id: Some("recording".into()),
        ..initial()
    };
    let cases = [
        (
            2101,
            initial(),
            RetentionAction::Deferred {
                reason: DeferredReason::CutoffBeyondClock,
            },
        ),
        (1000, fenced(1000), RetentionAction::NoAdvance),
        (
            1000,
            recording,
            RetentionAction::WaitForRecordingStop {
                session_id: "recording".into(),
            },
        ),
    ];
    for (cutoff, recovery, action) in cases {
        let result = stable(&p, cutoff, &recovery);
        assert_eq!(result.action, action);
        assert_eq!(
            result.next_state,
            GuardState::Tracking {
                policy_snapshot: p.clone(),
                last_sample: sample(2100, 100)
            }
        );
    }
}

#[test]
fn invalid_candidate_is_not_a_request_to_stop_the_active_recording() {
    let recovery = StoreRecoveryState {
        snapshot_commit: 1,
        active_session_id: Some("recording".into()),
        ..initial()
    };
    assert_eq!(
        stable(&policy(), 2101, &recovery).action,
        RetentionAction::Deferred {
            reason: DeferredReason::CutoffBeyondClock
        }
    );
}
