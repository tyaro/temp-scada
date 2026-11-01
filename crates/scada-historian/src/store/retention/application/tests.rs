use super::*;
use crate::store::{retention::policy::CutoffRule, test_support::*};
use std::time::Duration;
mod failures;
fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(10)).unwrap()
}
fn policy(revision: u64, duration: u64) -> RetentionClockPolicy {
    RetentionClockPolicy {
        policy_id: "policy".into(),
        revision,
        cutoff_rule: CutoffRule::Elapsed {
            retain_for_ms: duration,
        },
        tolerance_ms: 10,
        max_observation_gap_ms: 1000,
        max_cutoff_advance_ms: 500,
        initial_cutoff_ceiling_ms: Some(2000),
    }
}
fn request(store: &mut SqliteStore, id: &str, p: RetentionClockPolicy) -> PolicyApplyRequest {
    let prepared = store
        .preview_retention_policy_application(
            &PolicyPreparationRequest {
                proposed_policy: p.clone(),
                reference_wall_ms: 3000,
            },
            &control(),
        )
        .unwrap();
    PolicyApplyRequest {
        request_id: id.into(),
        expected_applied_revision: prepared.expected_applied_revision,
        expected_preview_snapshot_commit: prepared.snapshot_commit,
        proposed_policy: p,
        reference_wall_ms: 3000,
    }
}
#[test]
fn apply_is_atomic_discovered_after_reopen_and_retry_keeps_the_original_preview() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    store.append_tick(tick("a", 1, 1000)).unwrap();
    store.close_session("a").unwrap();
    let r = request(&mut store, "apply", policy(1, 1000));
    let before = counter(&store);
    let receipt = store.apply_retention_policy(&r, &control()).unwrap();
    assert_eq!(receipt.applied_revision, 1);
    assert_eq!(receipt.commit_version, before as u64 + 1);
    assert_eq!(receipt.preview.proposed.targets.observations, 2);
    assert_eq!(count(&store, "observations"), 2);
    assert!(store
        .recovery_state(&control())
        .unwrap()
        .active_job
        .is_none());
    drop(store);
    let mut store = directory.open();
    assert_eq!(
        store
            .recovery_state(&control())
            .unwrap()
            .applied_retention_policy
            .unwrap()
            .policy,
        r.proposed_policy
    );
    assert_eq!(
        store.apply_retention_policy(&r, &control()).unwrap(),
        receipt
    );
    assert_eq!(counter(&store), before + 1);
}

#[test]
fn actual_applied_comparison_cas_and_immutable_definition_are_distinct_from_caller_preview() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let first = request(&mut store, "first", policy(1, 2000));
    let r1 = store.apply_retention_policy(&first, &control()).unwrap();
    let next = request(&mut store, "next", policy(2, 1000));
    let prepared = store
        .preview_retention_policy_application(
            &PolicyPreparationRequest {
                proposed_policy: next.proposed_policy.clone(),
                reference_wall_ms: 3000,
            },
            &control(),
        )
        .unwrap();
    assert_eq!(prepared.expected_applied_revision, Some(1));
    assert_eq!(
        prepared.preview.comparison.unwrap().policy,
        first.proposed_policy
    );
    let mut stale = next.clone();
    stale.expected_applied_revision = None;
    assert!(matches!(
        store.apply_retention_policy(&stale, &control()),
        Err(StoreError::Conflict)
    ));
    let r2 = store.apply_retention_policy(&next, &control()).unwrap();
    assert_eq!(r2.applied_revision, 2);
    assert_eq!(
        store.apply_retention_policy(&first, &control()).unwrap(),
        r1
    );
    assert_eq!(
        store
            .recovery_state(&control())
            .unwrap()
            .applied_retention_policy
            .unwrap()
            .policy,
        next.proposed_policy
    );
    let before = counter(&store);
    let mut changed = first.clone();
    changed.reference_wall_ms += 1;
    assert!(matches!(
        store.apply_retention_policy(&changed, &control()),
        Err(StoreError::Conflict)
    ));
    let wrong = request(&mut store, "altered-definition", policy(1, 1500));
    assert!(matches!(
        store.apply_retention_policy(&wrong, &control()),
        Err(StoreError::Conflict)
    ));
    assert_eq!(counter(&store), before);
    let restore = request(&mut store, "restore", first.proposed_policy);
    assert_eq!(
        store
            .apply_retention_policy(&restore, &control())
            .unwrap()
            .applied_revision,
        3
    );
    let same = request(&mut store, "same", restore.proposed_policy);
    assert_eq!(
        store
            .apply_retention_policy(&same, &control())
            .unwrap()
            .applied_revision,
        4
    );
}

#[test]
fn preview_snapshot_conflict_requires_repreparation_and_active_recording_is_not_closed() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("active")).unwrap();
    let stale = request(&mut store, "stale", policy(1, 1000));
    store.append_tick(tick("active", 1, 1000)).unwrap();
    assert!(matches!(
        store.apply_retention_policy(&stale, &control()),
        Err(StoreError::Conflict)
    ));
    assert!(store
        .recovery_state(&control())
        .unwrap()
        .applied_retention_policy
        .is_none());
    let fresh = request(&mut store, "fresh", policy(1, 1000));
    let receipt = store.apply_retention_policy(&fresh, &control()).unwrap();
    assert_eq!(receipt.preview.proposed.targets.observations, 2);
    assert_eq!(
        store.recovery_state(&control()).unwrap().active_session_id,
        Some("active".into())
    );
    assert_eq!(count(&store, "observations"), 2);
    store.append_tick(tick("active", 2, 1000)).unwrap();
    assert_eq!(
        store.apply_retention_policy(&fresh, &control()).unwrap(),
        receipt
    );
}

#[test]
fn active_job_blocks_new_application_but_receipt_replay_survives_raw_deletion_and_later_policy() {
    use crate::store::retention::jobs::{JobRequest, JobStepRequest};
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    store.append_tick(tick("a", 1, 1000)).unwrap();
    store.close_session("a").unwrap();
    let first = request(&mut store, "first", policy(1, 1500));
    let receipt = store.apply_retention_policy(&first, &control()).unwrap();
    store
        .begin_retention_job(
            JobRequest {
                job_id: "job".into(),
                cutoff_ms: 2000,
                expected_cutoff_ms: None,
            },
            &control(),
        )
        .unwrap();
    let next = request(&mut store, "next", policy(2, 1000));
    assert!(matches!(
        store.apply_retention_policy(&next, &control()),
        Err(StoreError::Busy)
    ));
    assert_eq!(
        store.apply_retention_policy(&first, &control()).unwrap(),
        receipt
    );
    store
        .step_retention_job(
            JobStepRequest {
                job_id: "job".into(),
                step: 1,
                max_ticks: 1,
            },
            &control(),
        )
        .unwrap();
    let next = request(&mut store, "next", policy(2, 1000));
    store.apply_retention_policy(&next, &control()).unwrap();
    assert_eq!(count(&store, "observations"), 0);
    assert_eq!(
        store.apply_retention_policy(&first, &control()).unwrap(),
        receipt
    );
    assert_eq!(receipt.preview.proposed.targets.observations, 2); // Historical preview survives deletion.
    assert_eq!(
        store
            .recovery_state(&control())
            .unwrap()
            .applied_retention_policy
            .unwrap()
            .applied_revision,
        2
    );
}

#[test]
fn coordinator_new_job_requires_current_full_applied_policy_and_persists_its_generation() {
    use crate::store::retention::{
        clock_guard::{ClockSample, GuardState},
        coordinator::{CoordinatorInput, CoordinatorIntent, CoordinatorOutcome, NoWriteReason},
        jobs::JobRequest,
    };
    let directory = TempStore::new();
    let mut store = directory.create();
    let p = policy(1, 1000);
    let input = |state, wall, mono, p: RetentionClockPolicy| CoordinatorInput {
        policy: p,
        guard_state: state,
        sample: ClockSample {
            clock_epoch: "clock".into(),
            wall_time_ms: wall,
            monotonic_ms: mono,
            trusted: true,
        },
        candidate_cutoff_ms: None,
        intent: CoordinatorIntent::Begin(JobRequest {
            job_id: "bound".into(),
            cutoff_ms: wall - 1000,
            expected_cutoff_ms: None,
        }),
    };
    let first = store
        .coordinate_retention_once(&input(GuardState::Unarmed, 2000, 0, p.clone()), &control());
    let denied =
        store.coordinate_retention_once(&input(first.next_state, 2100, 100, p.clone()), &control());
    assert_eq!(
        denied.outcome.unwrap(),
        CoordinatorOutcome::NoWrite {
            reason: NoWriteReason::PolicyNotApplied
        }
    );
    let applied = request(&mut store, "apply", p.clone());
    store.apply_retention_policy(&applied, &control()).unwrap();
    let other = policy(2, 1000);
    let first = store.coordinate_retention_once(
        &input(GuardState::Unarmed, 2000, 0, other.clone()),
        &control(),
    );
    let denied =
        store.coordinate_retention_once(&input(first.next_state, 2100, 100, other), &control());
    assert_eq!(
        denied.outcome.unwrap(),
        CoordinatorOutcome::NoWrite {
            reason: NoWriteReason::AppliedPolicyMismatch
        }
    );
    let first = store
        .coordinate_retention_once(&input(GuardState::Unarmed, 2000, 0, p.clone()), &control());
    let begun = store.coordinate_retention_once(&input(first.next_state, 2100, 100, p), &control());
    assert!(matches!(begun.outcome, Ok(CoordinatorOutcome::Begun(_))));
    let state = store.recovery_state(&control()).unwrap();
    assert_eq!(
        state.active_job.unwrap().status.policy_applied_revision,
        Some(1)
    );
    drop(store);
    let mut store = directory.open();
    assert_eq!(
        store
            .recovery_state(&control())
            .unwrap()
            .active_job
            .unwrap()
            .status
            .policy_applied_revision,
        Some(1)
    );
}
