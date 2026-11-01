use super::*;
use crate::store::{
    recovery::{ActiveJobRecovery, StepRecovery},
    retention::jobs::{JobState, JobStatus, JobStepReceipt, JobStepRequest},
    MAX_SAFE,
};

fn active() -> StoreRecoveryState {
    StoreRecoveryState {
        snapshot_commit: 5,
        active_job: Some(ActiveJobRecovery {
            status: JobStatus {
                job_id: "job".into(),
                cutoff_ms: 1000,
                state: JobState::Active,
                next_step: Some(2),
                deleted_ticks: 1,
                deleted_observations: 2,
                begin_commit: 4,
                completion_commit: None,
                policy_applied_revision: None,
            },
            last_step: Some(StepRecovery {
                request: JobStepRequest {
                    job_id: "job".into(),
                    step: 1,
                    max_ticks: 1,
                },
                receipt: JobStepReceipt {
                    job_id: "job".into(),
                    step: 1,
                    commit_version: 5,
                    deleted_ticks: 1,
                    deleted_observations: 2,
                    completed: false,
                },
            }),
        }),
        ..initial()
    }
}

#[test]
fn active_job_has_action_priority_but_cannot_hide_a_clock_anomaly() {
    let p = policy();
    let state = primed(&p, sample(2000, 0));
    let result = assess_retention(&p, &state, &sample(9000, 100), Some(8000), &active()).unwrap();
    assert_eq!(
        result.action,
        RetentionAction::ExistingJob {
            job_id: "job".into()
        }
    );
    assert_eq!(
        result.next_state,
        GuardState::Suspended {
            reason: SuspendReason::ClockDriftExceeded
        }
    );
    assert_eq!(stable(&p, 1000, &active()).action, result.action);
}

#[test]
fn invalid_policies_and_stored_states_return_errors_without_mutating_inputs() {
    let p = policy();
    let policies = [
        RetentionClockPolicy {
            policy_id: "bad id".into(),
            ..p.clone()
        },
        RetentionClockPolicy {
            revision: 0,
            ..p.clone()
        },
        RetentionClockPolicy {
            revision: MAX_SAFE + 1,
            ..p.clone()
        },
        RetentionClockPolicy {
            max_observation_gap_ms: 0,
            ..p.clone()
        },
        RetentionClockPolicy {
            max_observation_gap_ms: MAX_SAFE + 1,
            ..p.clone()
        },
        RetentionClockPolicy {
            tolerance_ms: 1001,
            ..p.clone()
        },
        RetentionClockPolicy {
            max_cutoff_advance_ms: 0,
            ..p.clone()
        },
        RetentionClockPolicy {
            max_cutoff_advance_ms: MAX_SAFE + 1,
            ..p.clone()
        },
        RetentionClockPolicy {
            initial_cutoff_ceiling_ms: Some(i64::MIN),
            ..p.clone()
        },
    ];
    for invalid in policies {
        assert_eq!(
            assess_retention(
                &invalid,
                &GuardState::Unarmed,
                &sample(2100, 100),
                Some(1000),
                &initial()
            ),
            Err(InvalidInput::Policy)
        );
    }
    let state = GuardState::Tracking {
        policy_snapshot: p.clone(),
        last_sample: ClockSample {
            trusted: false,
            ..sample(2000, 0)
        },
    };
    let before = state.clone();
    assert_eq!(
        assess_retention(&p, &state, &sample(2100, 100), Some(1000), &initial()),
        Err(InvalidInput::GuardState)
    );
    assert_eq!(state, before);
    let state = GuardState::Primed {
        policy_snapshot: p.clone(),
        last_sample: sample(i64::MIN, 0),
    };
    assert_eq!(
        assess_retention(&p, &state, &sample(2100, 100), Some(1000), &initial()),
        Err(InvalidInput::GuardState)
    );
}

#[test]
fn unsafe_candidate_errors_but_malformed_new_sample_latches_a_stop() {
    let p = policy();
    let state = primed(&p, sample(2000, 0));
    for cutoff in [
        i64::MIN,
        i64::MAX,
        MAX_SAFE as i64 + 1,
        -(MAX_SAFE as i64) - 1,
    ] {
        assert_eq!(
            assess_retention(&p, &state, &sample(2100, 100), Some(cutoff), &initial()),
            Err(InvalidInput::Cutoff)
        );
    }
    assert_suspended(
        assess_retention(&p, &state, &sample(i64::MIN, 100), Some(1000), &initial()).unwrap(),
        SuspendReason::MalformedClockSample,
    );
    assert_suspended(
        assess_retention(
            &p,
            &GuardState::Unarmed,
            &ClockSample {
                trusted: false,
                ..sample(2000, 0)
            },
            Some(1000),
            &initial(),
        )
        .unwrap(),
        SuspendReason::UntrustedClock,
    );
}

#[test]
fn contradictory_recovery_sources_and_active_sessions_are_rejected() {
    let mut cases = Vec::new();
    let mut r = initial();
    r.snapshot_commit = u64::MAX;
    cases.push(r);
    let mut r = initial();
    r.retention_fence.cutoff_ms = Some(0);
    cases.push(r);
    let mut r = fenced(0);
    r.snapshot_commit = 2;
    cases.push(r);
    let mut r = fenced(0);
    r.retention_fence.cutoff_ms = Some(i64::MAX);
    cases.push(r);
    let mut r = fenced(0);
    r.retention_fence.source = FenceSource::SingleTrim {
        request_id: "bad id".into(),
    };
    cases.push(r);
    let mut r = fenced(0);
    r.retention_fence.revision_commit = 0;
    cases.push(r);
    let mut r = initial();
    r.active_session_id = Some("session".into());
    cases.push(r);
    let mut r = initial();
    r.snapshot_commit = 1;
    r.active_session_id = Some("bad id".into());
    cases.push(r);
    let mut r = active();
    r.active_session_id = Some("session".into());
    cases.push(r);
    for r in cases {
        assert_invalid_recovery(&r);
    }
}

fn assert_invalid_recovery(r: &StoreRecoveryState) {
    let before = r.clone();
    assert_eq!(
        assess_retention(
            &policy(),
            &GuardState::Unarmed,
            &sample(2000, 0),
            Some(1000),
            r
        ),
        Err(InvalidInput::RecoveryState)
    );
    assert_eq!(r, &before);
}

#[test]
fn contradictory_active_job_receipts_and_counters_are_rejected() {
    let changes: &[fn(&mut ActiveJobRecovery)] = &[
        |a| a.status.state = JobState::Complete,
        |a| a.status.job_id = "bad id".into(),
        |a| a.status.cutoff_ms = i64::MAX,
        |a| a.status.completion_commit = Some(5),
        |a| a.status.begin_commit = 0,
        |a| a.status.begin_commit = 6,
        |a| a.status.deleted_ticks = MAX_SAFE + 1,
        |a| a.status.deleted_observations = 0,
        |a| a.status.deleted_observations = 9,
        |a| a.status.next_step = None,
        |a| a.last_step = None,
        |a| a.last_step.as_mut().unwrap().request.job_id = "other".into(),
        |a| a.last_step.as_mut().unwrap().receipt.job_id = "other".into(),
        |a| a.last_step.as_mut().unwrap().request.step = 0,
        |a| a.last_step.as_mut().unwrap().receipt.step = 2,
        |a| a.last_step.as_mut().unwrap().request.max_ticks = 0,
        |a| a.last_step.as_mut().unwrap().request.max_ticks = 1025,
        |a| a.last_step.as_mut().unwrap().receipt.completed = true,
        |a| a.last_step.as_mut().unwrap().receipt.commit_version = 4,
        |a| a.last_step.as_mut().unwrap().receipt.commit_version = 6,
        |a| a.last_step.as_mut().unwrap().receipt.deleted_ticks = 0,
        |a| a.last_step.as_mut().unwrap().receipt.deleted_ticks = 2,
        |a| a.last_step.as_mut().unwrap().receipt.deleted_observations = 0,
        |a| a.last_step.as_mut().unwrap().receipt.deleted_observations = 9,
        |a| {
            a.status.next_step = Some(3);
            let s = a.last_step.as_mut().unwrap();
            s.request.step = 2;
            s.receipt.step = 2;
        },
    ];
    for change in changes {
        let mut r = active();
        change(r.active_job.as_mut().unwrap());
        assert_invalid_recovery(&r);
    }
    let mut r = active();
    r.retention_fence = fenced(1000).retention_fence;
    assert_invalid_recovery(&r);
    let mut r = active();
    r.retention_fence = fenced(0).retention_fence;
    r.retention_fence.source = FenceSource::CompletedJob {
        job_id: "job".into(),
    };
    assert_invalid_recovery(&r);
}

#[test]
fn job_totals_must_explain_both_the_latest_and_every_prior_step() {
    let mut r = active();
    let a = r.active_job.as_mut().unwrap();
    a.status.deleted_ticks = 2;
    a.status.deleted_observations = 4;
    assert_invalid_recovery(&r); // Step one must equal its totals.

    let mut r = active();
    r.snapshot_commit = 6;
    let a = r.active_job.as_mut().unwrap();
    a.status.next_step = Some(3);
    a.status.deleted_ticks = 2;
    a.status.deleted_observations = 4;
    let last = a.last_step.as_mut().unwrap();
    last.request.step = 2;
    last.receipt.step = 2;
    last.receipt.commit_version = 6;
    assert_eq!(
        stable(&policy(), 1000, &r).action,
        RetentionAction::ExistingJob {
            job_id: "job".into()
        }
    );
    let valid = r.clone();
    // Both latest tick count and cumulative totals are valid on their own, but
    // this combination leaves zero ticks for the first step.
    let a = r.active_job.as_mut().unwrap();
    a.last_step.as_mut().unwrap().request.max_ticks = 2;
    a.last_step.as_mut().unwrap().receipt.deleted_ticks = 2;
    assert_invalid_recovery(&r);
    for observations in [2, 11] {
        let mut r = valid.clone();
        r.active_job.as_mut().unwrap().status.deleted_observations = observations;
        assert_invalid_recovery(&r); // Prior single tick requires 1..=8 members.
    }
    let mut r = valid;
    let a = r.active_job.as_mut().unwrap();
    a.status.deleted_ticks = 1026;
    a.status.deleted_observations = 1027;
    assert_invalid_recovery(&r); // A single prior step cannot remove 1025 ticks.
}
