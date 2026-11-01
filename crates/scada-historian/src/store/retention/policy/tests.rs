use super::*;
use crate::store::{
    query::QueryControl,
    recovery::{FenceSource, RetentionFence, StoreRecoveryState},
    retention::{
        clock_guard::{
            assess_retention, ClockSample, GuardState, InvalidInput, RetentionAction, SuspendReason,
        },
        coordinator::{CoordinatorInput, CoordinatorIntent, CoordinatorOutcome, NoWriteReason},
        jobs::{JobRequest, JobStepRequest},
    },
    test_support::*,
    MAX_SAFE,
};
use std::time::Duration;
mod integration;

fn policy(retain_for_ms: u64) -> RetentionClockPolicy {
    RetentionClockPolicy {
        policy_id: "elapsed-policy".into(),
        revision: 1,
        cutoff_rule: CutoffRule::Elapsed { retain_for_ms },
        tolerance_ms: 10,
        max_observation_gap_ms: 1000,
        max_cutoff_advance_ms: 500,
        initial_cutoff_ceiling_ms: Some(1500),
    }
}
fn sample(wall: i64, mono: u64) -> ClockSample {
    ClockSample {
        clock_epoch: "clock".into(),
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
        applied_retention_policy: None,
    }
}
fn prime(policy: &RetentionClockPolicy, s: &ClockSample) -> GuardState {
    let first = assess_retention(policy, &GuardState::Unarmed, s, None, &initial()).unwrap();
    assert_eq!(first.action, RetentionAction::WaitForClock);
    first.next_state
}
fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(10)).unwrap()
}

#[test]
fn elapsed_milliseconds_are_exact_and_describe_the_reference_and_policy() {
    let p = policy(86_400_000);
    let reference = 1_798_764_321_123;
    assert_eq!(
        derive_cutoff(&p, reference).unwrap(),
        DerivedCutoff {
            policy_id: "elapsed-policy".into(),
            revision: 1,
            reference_wall_ms: reference,
            retain_for_ms: 86_400_000,
            cutoff_ms: reference - 86_400_000,
        }
    );
    assert_eq!(derive_cutoff(&policy(1), 0).unwrap().cutoff_ms, -1);
    assert_eq!(derive_cutoff(&policy(1000), -500).unwrap().cutoff_ms, -1500);
}

#[test]
fn safe_endpoints_and_duration_limits_are_checked_without_saturation() {
    let max = MAX_SAFE as i64;
    assert_eq!(derive_cutoff(&policy(MAX_SAFE), max).unwrap().cutoff_ms, 0);
    assert_eq!(derive_cutoff(&policy(MAX_SAFE), 0).unwrap().cutoff_ms, -max);
    assert_eq!(derive_cutoff(&policy(1), -max + 1).unwrap().cutoff_ms, -max);
    assert_eq!(
        derive_cutoff(&policy(1), -max),
        Err(CutoffError::OutOfRange)
    );
    assert_eq!(
        derive_cutoff(&policy(MAX_SAFE), -max),
        Err(CutoffError::OutOfRange)
    );
    for duration in [0, MAX_SAFE + 1, u64::MAX] {
        assert_eq!(
            derive_cutoff(&policy(duration), 2000),
            Err(CutoffError::InvalidPolicy)
        );
    }
    for reference in [i64::MIN, i64::MAX, max + 1, -max - 1] {
        assert_eq!(
            derive_cutoff(&policy(1), reference),
            Err(CutoffError::InvalidReferenceTime)
        );
    }
}

#[test]
fn calculation_rejects_invalid_policies_and_never_invents_an_elapsed_default() {
    let mut p = policy(1000);
    p.cutoff_rule = CutoffRule::ExplicitCandidate;
    assert_eq!(derive_cutoff(&p, 2000), Err(CutoffError::NotElapsed));
    let mut p = policy(1000);
    p.revision = 0;
    assert_eq!(derive_cutoff(&p, 2000), Err(CutoffError::InvalidPolicy));
    let mut p = policy(1000);
    p.max_observation_gap_ms = 0;
    assert_eq!(derive_cutoff(&p, 2000), Err(CutoffError::InvalidPolicy));
}

#[test]
fn elapsed_guard_uses_the_current_sample_and_cannot_accept_an_external_candidate() {
    let p = policy(1000);
    let state = prime(&p, &sample(2000, 0));
    assert_eq!(
        assess_retention(&p, &state, &sample(2100, 100), Some(1100), &initial()),
        Err(InvalidInput::Cutoff)
    );
    assert_eq!(
        assess_retention(&p, &state, &sample(2100, 100), Some(1), &initial()),
        Err(InvalidInput::Cutoff)
    );
    let next = assess_retention(&p, &state, &sample(2100, 100), None, &initial()).unwrap();
    assert_eq!(
        next.action,
        RetentionAction::ProposeJob {
            cutoff_ms: 1100,
            expected_cutoff_ms: None,
            snapshot_commit: 0,
            policy_id: p.policy_id.clone(),
            revision: 1
        }
    );
    let mut explicit = p;
    explicit.cutoff_rule = CutoffRule::ExplicitCandidate;
    assert_eq!(
        assess_retention(
            &explicit,
            &GuardState::Unarmed,
            &sample(2000, 0),
            None,
            &initial()
        ),
        Err(InvalidInput::Cutoff)
    );
}

#[test]
fn duration_and_rule_changes_are_detected_even_when_id_and_revision_are_unchanged() {
    let p = policy(1000);
    let state = prime(&p, &sample(2000, 0));
    let before = state.clone();
    let shortened =
        assess_retention(&policy(500), &state, &sample(2100, 100), None, &initial()).unwrap();
    assert_eq!(
        shortened.next_state,
        GuardState::Suspended {
            reason: SuspendReason::PolicyChanged
        }
    );
    assert_eq!(shortened.action, RetentionAction::WaitForClock);
    let extended =
        assess_retention(&policy(1500), &state, &sample(2100, 100), None, &initial()).unwrap();
    assert_eq!(extended.next_state, shortened.next_state);
    let mut explicit = p;
    explicit.cutoff_rule = CutoffRule::ExplicitCandidate;
    let changed = assess_retention(
        &explicit,
        &state,
        &sample(2100, 100),
        Some(1100),
        &initial(),
    )
    .unwrap();
    assert_eq!(changed.next_state, shortened.next_state);
    assert_eq!(state, before);
}

#[test]
fn cutoff_computation_failure_latches_until_explicit_rearm_and_new_warmup() {
    let max = MAX_SAFE as i64;
    let p = policy(1000);
    let state = prime(&p, &sample(-max, 0));
    let failed = assess_retention(&p, &state, &sample(-max + 100, 100), None, &initial()).unwrap();
    assert_eq!(
        failed.next_state,
        GuardState::Suspended {
            reason: SuspendReason::CutoffComputationFailed
        }
    );
    assert_eq!(failed.action, RetentionAction::WaitForClock);
    let later =
        assess_retention(&p, &failed.next_state, &sample(2100, 200), None, &initial()).unwrap();
    assert_eq!(later, failed);
    let first = assess_retention(
        &p,
        &failed.next_state.rearm(),
        &sample(2000, 0),
        None,
        &initial(),
    )
    .unwrap();
    assert_eq!(first.action, RetentionAction::WaitForClock);
    let valid =
        assess_retention(&p, &first.next_state, &sample(2100, 100), None, &initial()).unwrap();
    assert!(matches!(
        valid.action,
        RetentionAction::ProposeJob {
            cutoff_ms: 1100,
            ..
        }
    ));
}

#[test]
fn bad_clock_samples_keep_the_clock_reason_instead_of_becoming_calculation_errors() {
    let p = policy(1000);
    let state = prime(&p, &sample(2000, 0));
    for (s, reason) in [
        (sample(i64::MIN, 100), SuspendReason::MalformedClockSample),
        (
            ClockSample {
                trusted: false,
                ..sample(-(MAX_SAFE as i64), 100)
            },
            SuspendReason::UntrustedClock,
        ),
        (sample(9000, 100), SuspendReason::ClockDriftExceeded),
    ] {
        let assessed = assess_retention(&p, &state, &s, None, &initial()).unwrap();
        assert_eq!(assessed.next_state, GuardState::Suspended { reason });
        assert_eq!(assessed.action, RetentionAction::WaitForClock);
    }
}
