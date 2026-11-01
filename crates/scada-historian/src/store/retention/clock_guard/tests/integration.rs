use super::*;
use crate::store::{
    query::QueryControl,
    retention::{
        jobs::{JobRequest, JobStepRequest},
        TrimRequest,
    },
    test_support::*,
    StoreError,
};
use std::time::Duration;
fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(10)).unwrap()
}
fn proposal_request(action: RetentionAction) -> JobRequest {
    let RetentionAction::ProposeJob {
        cutoff_ms,
        expected_cutoff_ms,
        ..
    } = action
    else {
        panic!("proposal required")
    };
    // Only the explicit caller supplies a stable ID and executes the request.
    JobRequest {
        job_id: "explicit-job".into(),
        cutoff_ms,
        expected_cutoff_ms,
    }
}

#[test]
fn pure_assessment_does_not_write_and_explicit_job_is_discovered_through_partial_and_complete() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("recording")).unwrap();
    store.append_tick(tick("recording", 1, 500)).unwrap();
    store.append_tick(tick("recording", 2, 500)).unwrap();
    store.close_session("recording").unwrap();
    let recovery = store.recovery_state(&control()).unwrap();
    let before = counter(&store);
    let p = policy();
    let assessed = stable(&p, 1000, &recovery);
    assert_eq!(counter(&store), before);
    assert_eq!(count(&store, "observations"), 4);
    assert_eq!(store.recovery_state(&control()).unwrap(), recovery);
    let request = proposal_request(assessed.action);
    store
        .begin_retention_job(request.clone(), &control())
        .unwrap();
    for step in 1..=2 {
        let recovery = store.recovery_state(&control()).unwrap();
        let action = stable(&p, 1500, &recovery).action;
        assert_eq!(
            action,
            RetentionAction::ExistingJob {
                job_id: request.job_id.clone()
            }
        );
        let result = store
            .step_retention_job(
                JobStepRequest {
                    job_id: request.job_id.clone(),
                    step,
                    max_ticks: 1,
                },
                &control(),
            )
            .unwrap();
        assert_eq!(result.completed, step == 2);
    }
    let recovery = store.recovery_state(&control()).unwrap();
    assert!(recovery.active_job.is_none());
    assert!(matches!(
        recovery.retention_fence.source,
        FenceSource::CompletedJob { .. }
    ));
    assert_eq!(
        stable(&p, 1000, &recovery).action,
        RetentionAction::NoAdvance
    );
}

#[test]
fn recording_requires_explicit_close_and_fresh_recovery_before_a_proposal() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("recording")).unwrap();
    let recovery = store.recovery_state(&control()).unwrap();
    let before = counter(&store);
    assert_eq!(
        stable(&policy(), 1000, &recovery).action,
        RetentionAction::WaitForRecordingStop {
            session_id: "recording".into()
        }
    );
    assert_eq!(counter(&store), before);
    assert_eq!(store.recovery_state(&control()).unwrap(), recovery);
    store.close_session("recording").unwrap();
    let fresh = store.recovery_state(&control()).unwrap();
    assert!(matches!(
        stable(&policy(), 1000, &fresh).action,
        RetentionAction::ProposeJob { .. }
    ));
}

#[test]
fn stale_proposal_is_rejected_after_the_retention_fence_changes() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let recovery = store.recovery_state(&control()).unwrap();
    let request = proposal_request(stable(&policy(), 1000, &recovery).action);
    store
        .trim(
            TrimRequest {
                request_id: "intervening".into(),
                cutoff_ms: 500,
                expected_cutoff_ms: None,
            },
            &control(),
        )
        .unwrap();
    let before = counter(&store);
    assert!(matches!(
        store.begin_retention_job(request, &control()),
        Err(StoreError::Conflict)
    ));
    assert_eq!(counter(&store), before);
    let fresh = store.recovery_state(&control()).unwrap();
    assert!(matches!(
        stable(&policy(), 1000, &fresh).action,
        RetentionAction::ProposeJob {
            expected_cutoff_ms: Some(500),
            ..
        }
    ));
}

#[test]
fn stale_proposal_cannot_bypass_a_new_recording_or_competing_job() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let request = proposal_request(
        stable(&policy(), 1000, &store.recovery_state(&control()).unwrap()).action,
    );
    store.begin_session(spec("new-recording")).unwrap();
    let before = counter(&store);
    assert!(matches!(
        store.begin_retention_job(request.clone(), &control()),
        Err(StoreError::Busy)
    ));
    assert_eq!(counter(&store), before);
    store.close_session("new-recording").unwrap();
    store
        .begin_retention_job(
            JobRequest {
                job_id: "competing".into(),
                ..request.clone()
            },
            &control(),
        )
        .unwrap();
    let before = counter(&store);
    assert!(matches!(
        store.begin_retention_job(request, &control()),
        Err(StoreError::Busy)
    ));
    assert_eq!(counter(&store), before);
    assert_eq!(
        stable(&policy(), 1000, &store.recovery_state(&control()).unwrap()).action,
        RetentionAction::ExistingJob {
            job_id: "competing".into()
        }
    );
}
