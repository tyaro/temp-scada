use super::*;
use crate::store::retention::{
    clock_guard::DeferredReason, coordinator::CoordinatorError, TrimRequest,
};

fn input(
    policy: &RetentionClockPolicy,
    state: GuardState,
    wall: i64,
    mono: u64,
    intent: CoordinatorIntent,
) -> CoordinatorInput {
    CoordinatorInput {
        policy: policy.clone(),
        guard_state: state,
        sample: sample(wall, mono),
        candidate_cutoff_ms: None,
        intent,
    }
}
fn begin(cutoff_ms: i64) -> JobRequest {
    JobRequest {
        job_id: "elapsed-job".into(),
        cutoff_ms,
        expected_cutoff_ms: None,
    }
}

#[test]
fn duration_drives_explicit_job_creation_and_exclusive_raw_deletion_boundary() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("recording")).unwrap();
    store.append_tick(tick("recording", 1, 1099)).unwrap();
    store.append_tick(tick("recording", 2, 1100)).unwrap();
    store.append_tick(tick("recording", 3, 1101)).unwrap();
    let p = policy(1000);
    apply_test_policy(&mut store, p.clone());
    let first = store.coordinate_retention_once(
        &input(&p, GuardState::Unarmed, 1800, 0, CoordinatorIntent::Observe),
        &control(),
    );
    assert_eq!(first.outcome.unwrap(), CoordinatorOutcome::Observed);
    let before = counter(&store);
    let waiting = store.coordinate_retention_once(
        &input(
            &p,
            first.next_state,
            1900,
            100,
            CoordinatorIntent::Begin(begin(900)),
        ),
        &control(),
    );
    assert_eq!(
        waiting.outcome.unwrap(),
        CoordinatorOutcome::NoWrite {
            reason: NoWriteReason::NotProposed
        }
    );
    assert!(matches!(
        waiting.assessment.unwrap().action,
        RetentionAction::WaitForRecordingStop { .. }
    ));
    assert_eq!(counter(&store), before);
    store.close_session("recording").unwrap();
    // A fresh sample derives 1000. An older 900 request cannot be relabeled.
    let stale = store.coordinate_retention_once(
        &input(
            &p,
            waiting.next_state,
            2000,
            200,
            CoordinatorIntent::Begin(begin(900)),
        ),
        &control(),
    );
    assert_eq!(
        stale.outcome.unwrap(),
        CoordinatorOutcome::NoWrite {
            reason: NoWriteReason::BeginRequestMismatch
        }
    );
    // Keep the updated state and use another fresh sample to derive 1100.
    let accepted = store.coordinate_retention_once(
        &input(
            &p,
            stale.next_state,
            2100,
            300,
            CoordinatorIntent::Begin(begin(1100)),
        ),
        &control(),
    );
    assert!(matches!(accepted.outcome, Ok(CoordinatorOutcome::Begun(_))));
    assert_eq!(count(&store, "observations"), 6); // Begin alone never deletes.
    let stepped = store.coordinate_retention_once(
        &input(
            &p,
            accepted.next_state,
            2200,
            400,
            CoordinatorIntent::ContinueExisting(JobStepRequest {
                job_id: "elapsed-job".into(),
                step: 1,
                max_ticks: 1,
            }),
        ),
        &control(),
    );
    assert!(
        matches!(stepped.outcome, Ok(CoordinatorOutcome::Stepped(ref r)) if r.completed && r.deleted_ticks == 1)
    );
    assert_eq!(count(&store, "observations"), 4);
    let remaining: i64 = store
        .connection
        .query_row(
            "SELECT DISTINCT sample_time_ms FROM observations",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(remaining, 1100);
    let query = serde_json::json!({"version":1,"kind":"query","requestId":"duration-boundary","seriesIds":["number","bool"],"fromMs":1099,"toMs":1102,"mode":"raw","maxPointsPerSeries":4});
    let result = store
        .reader()
        .unwrap()
        .query_raw(&query, &control())
        .unwrap();
    for series in result["series"].as_array().unwrap() {
        assert_eq!(
            series["raw"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["sampleTimeMs"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![1100, 1101]
        );
        assert_eq!(
            series["coverage"],
            serde_json::json!([
                {"fromMs":1099,"toMs":1100,"reason":"expired"},
                {"fromMs":1100,"toMs":1102,"reason":"unknownCoverage"}
            ])
        );
    }
    assert_eq!(
        store
            .recovery_state(&control())
            .unwrap()
            .retention_fence
            .cutoff_ms,
        Some(1100)
    );
}

#[test]
fn coordinator_rejects_mode_bypass_and_reports_input_repair_without_writes() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let p = policy(1000);
    let state = prime(&p, &sample(2000, 0));
    let mut request = input(
        &p,
        state.clone(),
        2100,
        100,
        CoordinatorIntent::Begin(begin(1100)),
    );
    request.candidate_cutoff_ms = Some(1100);
    let report = store.coordinate_retention_once(&request, &control());
    assert!(matches!(
        report.outcome,
        Err(CoordinatorError::Assessment(InvalidInput::Cutoff))
    ));
    assert!(report.rearm_required);
    assert_eq!(report.next_state, state);
    assert_eq!(counter(&store), 0);
}

#[test]
fn derived_candidates_still_obey_fence_advance_and_initial_authorization_limits() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store
        .trim(
            TrimRequest {
                request_id: "fence".into(),
                cutoff_ms: 1000,
                expected_cutoff_ms: None,
            },
            &control(),
        )
        .unwrap();
    let p = policy(1000);
    for (wall, expected) in [
        (2000, RetentionAction::NoAdvance),
        (
            2500,
            RetentionAction::ProposeJob {
                cutoff_ms: 1500,
                expected_cutoff_ms: Some(1000),
                snapshot_commit: 1,
                policy_id: p.policy_id.clone(),
                revision: 1,
            },
        ),
        (
            2501,
            RetentionAction::Deferred {
                reason: DeferredReason::CutoffAdvanceLimit,
            },
        ),
    ] {
        let state = prime(&p, &sample(wall - 100, 0));
        let report = store.coordinate_retention_once(
            &input(&p, state, wall, 100, CoordinatorIntent::Observe),
            &control(),
        );
        assert_eq!(report.assessment.unwrap().action, expected);
    }
    assert_eq!(counter(&store), 1);
    let fresh = TempStore::new();
    let mut store = fresh.create();
    let mut unauthorized = p;
    unauthorized.initial_cutoff_ceiling_ms = None;
    let state = prime(&unauthorized, &sample(2000, 0));
    let report = store.coordinate_retention_once(
        &input(
            &unauthorized,
            state,
            2100,
            100,
            CoordinatorIntent::Begin(begin(1100)),
        ),
        &control(),
    );
    assert_eq!(
        report.assessment.unwrap().action,
        RetentionAction::Deferred {
            reason: DeferredReason::InitialCutoffNotAuthorized
        }
    );
    assert_eq!(counter(&store), 0);
}

#[test]
fn malformed_clock_and_cutoff_underflow_are_returned_as_latched_report_states() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let p = policy(1000);
    let state = prime(&p, &sample(2000, 0));
    let malformed = store.coordinate_retention_once(
        &input(
            &p,
            state,
            i64::MIN,
            100,
            CoordinatorIntent::Begin(begin(1100)),
        ),
        &control(),
    );
    assert_eq!(
        malformed.next_state,
        GuardState::Suspended {
            reason: SuspendReason::MalformedClockSample
        }
    );
    assert_eq!(
        malformed.outcome.unwrap(),
        CoordinatorOutcome::NoWrite {
            reason: NoWriteReason::NotProposed
        }
    );
    let max = MAX_SAFE as i64;
    let state = prime(&p, &sample(-max, 0));
    let failed = store.coordinate_retention_once(
        &input(
            &p,
            state,
            -max + 100,
            100,
            CoordinatorIntent::Begin(begin(-max)),
        ),
        &control(),
    );
    assert_eq!(
        failed.next_state,
        GuardState::Suspended {
            reason: SuspendReason::CutoffComputationFailed
        }
    );
    assert!(!failed.rearm_required);
    assert!(failed.assessment.is_some());
    assert_eq!(counter(&store), 0);
}

#[test]
fn existing_job_keeps_its_cutoff_and_allows_only_the_explicit_step_when_new_cutoff_cannot_be_derived(
) {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("recording")).unwrap();
    store.append_tick(tick("recording", 1, 500)).unwrap();
    store.append_tick(tick("recording", 2, 500)).unwrap();
    store.close_session("recording").unwrap();
    store.begin_retention_job(begin(1100), &control()).unwrap();
    let p = policy(1000);
    let max = MAX_SAFE as i64;
    let state = prime(&p, &sample(-max, 0));
    let report = store.coordinate_retention_once(
        &input(
            &p,
            state,
            -max + 100,
            100,
            CoordinatorIntent::ContinueExisting(JobStepRequest {
                job_id: "elapsed-job".into(),
                step: 1,
                max_ticks: 1,
            }),
        ),
        &control(),
    );
    assert!(matches!(report.next_state, GuardState::Tracking { .. }));
    assert_eq!(
        report.assessment.unwrap().action,
        RetentionAction::ExistingJob {
            job_id: "elapsed-job".into()
        }
    );
    assert!(
        matches!(report.outcome, Ok(CoordinatorOutcome::Stepped(ref r)) if !r.completed && r.deleted_ticks == 1)
    );
    let job = store
        .recovery_state(&control())
        .unwrap()
        .active_job
        .unwrap();
    assert_eq!(job.status.cutoff_ms, 1100);
    assert_eq!(job.status.next_step, Some(2));
}
