use super::*;
use crate::store::{test_support::*, StoreError};
use std::time::Duration;
mod failures;

fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(10)).unwrap()
}
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
fn setup(times: &[i64]) -> (TempStore, SqliteStore) {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("recording")).unwrap();
    for (index, time) in times.iter().enumerate() {
        store
            .append_tick(tick("recording", index as u64 + 1, *time))
            .unwrap();
    }
    store.close_session("recording").unwrap();
    (directory, store)
}
fn begin() -> JobRequest {
    JobRequest {
        job_id: "job".into(),
        cutoff_ms: 1000,
        expected_cutoff_ms: None,
    }
}
fn step(number: u64, max_ticks: u32) -> JobStepRequest {
    JobStepRequest {
        job_id: "job".into(),
        step: number,
        max_ticks,
    }
}
fn input(state: GuardState, mono: u64, intent: CoordinatorIntent) -> CoordinatorInput {
    CoordinatorInput {
        policy: policy(),
        guard_state: state,
        sample: sample(2000 + mono as i64, mono),
        candidate_cutoff_ms: 1000,
        intent,
    }
}
fn prime(store: &mut SqliteStore) -> GuardState {
    let report = store.coordinate_retention_once(
        &input(GuardState::Unarmed, 0, CoordinatorIntent::Observe),
        &control(),
    );
    assert_eq!(report.outcome.unwrap(), CoordinatorOutcome::Observed);
    assert!(matches!(report.next_state, GuardState::Primed { .. }));
    report.next_state
}
fn no_write(report: &CoordinatorReport, reason: NoWriteReason) {
    assert!(
        matches!(report.outcome, Ok(CoordinatorOutcome::NoWrite { reason: actual }) if actual == reason),
        "{report:?}"
    );
}

#[test]
fn observe_is_read_only_even_when_a_stable_clock_proposes_a_job() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let directory = TempStore::new();
    let mut store = directory.create();
    // All modifying SQL is denied; discovery and assessment still succeed.
    store
        .connection
        .authorizer(Some(|c: AuthContext<'_>| {
            if matches!(
                c.action,
                AuthAction::Insert { .. } | AuthAction::Update { .. } | AuthAction::Delete { .. }
            ) {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }))
        .unwrap();
    let state = prime(&mut store);
    let report =
        store.coordinate_retention_once(&input(state, 100, CoordinatorIntent::Observe), &control());
    assert_eq!(report.outcome.unwrap(), CoordinatorOutcome::Observed);
    assert!(matches!(
        report.assessment.unwrap().action,
        RetentionAction::ProposeJob { .. }
    ));
    assert_eq!(counter(&store), 0);
    assert!(store.connection.is_autocommit());
}

#[test]
fn begin_requires_stable_clock_and_never_also_performs_a_step() {
    let (_directory, mut store) = setup(&[500, 500]);
    let before = counter(&store);
    let first = store.coordinate_retention_once(
        &input(GuardState::Unarmed, 0, CoordinatorIntent::Begin(begin())),
        &control(),
    );
    no_write(&first, NoWriteReason::NotProposed);
    assert_eq!(counter(&store), before);
    let report = store.coordinate_retention_once(
        &input(first.next_state, 100, CoordinatorIntent::Begin(begin())),
        &control(),
    );
    assert!(matches!(report.outcome, Ok(CoordinatorOutcome::Begun(_))));
    assert_eq!(report.recovery.unwrap().snapshot_commit, before as u64);
    assert_eq!(counter(&store), before + 1);
    assert_eq!(count(&store, "observations"), 4);
    let again = store.coordinate_retention_once(
        &input(report.next_state, 200, CoordinatorIntent::Begin(begin())),
        &control(),
    );
    no_write(&again, NoWriteReason::NotProposed);
    assert_eq!(
        again.assessment.unwrap().action,
        RetentionAction::ExistingJob {
            job_id: "job".into()
        }
    );
    assert_eq!(counter(&store), before + 1);
}

#[test]
fn duplicate_sample_cannot_execute_an_earlier_observed_proposal() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let primed = prime(&mut store);
    let observed = store
        .coordinate_retention_once(&input(primed, 100, CoordinatorIntent::Observe), &control());
    let duplicate = store.coordinate_retention_once(
        &input(observed.next_state, 100, CoordinatorIntent::Begin(begin())),
        &control(),
    );
    no_write(&duplicate, NoWriteReason::NotProposed);
    assert_eq!(
        duplicate.assessment.unwrap().action,
        RetentionAction::WaitForClock
    );
    assert_eq!(counter(&store), 0);
}

#[test]
fn begin_payload_must_match_the_current_cutoff_and_fence_exactly() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let state = prime(&mut store);
    for request in [
        JobRequest {
            cutoff_ms: 1001,
            ..begin()
        },
        JobRequest {
            expected_cutoff_ms: Some(0),
            ..begin()
        },
    ] {
        let report = store.coordinate_retention_once(
            &input(state.clone(), 100, CoordinatorIntent::Begin(request)),
            &control(),
        );
        no_write(&report, NoWriteReason::BeginRequestMismatch);
    }
    assert_eq!(counter(&store), 0);
}

#[test]
fn deferred_suspended_and_recording_states_do_not_begin_or_close_a_session() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let state = prime(&mut store);
    let mut future = input(state.clone(), 100, CoordinatorIntent::Begin(begin()));
    future.candidate_cutoff_ms = 2101;
    future.intent = CoordinatorIntent::Begin(JobRequest {
        cutoff_ms: 2101,
        ..begin()
    });
    let future = store.coordinate_retention_once(&future, &control());
    no_write(&future, NoWriteReason::NotProposed);
    assert!(matches!(
        future.assessment.unwrap().action,
        RetentionAction::Deferred { .. }
    ));
    let mut jump = input(state.clone(), 100, CoordinatorIntent::Begin(begin()));
    jump.sample.wall_time_ms = 9000;
    let jumped = store.coordinate_retention_once(&jump, &control());
    no_write(&jumped, NoWriteReason::NotProposed);
    assert!(matches!(jumped.next_state, GuardState::Suspended { .. }));
    let later = store.coordinate_retention_once(
        &input(jumped.next_state, 200, CoordinatorIntent::Begin(begin())),
        &control(),
    );
    no_write(&later, NoWriteReason::NotProposed);
    assert_eq!(counter(&store), 0);
    store.begin_session(spec("active")).unwrap();
    let before = counter(&store);
    let report = store.coordinate_retention_once(
        &input(state, 100, CoordinatorIntent::Begin(begin())),
        &control(),
    );
    no_write(&report, NoWriteReason::NotProposed);
    assert_eq!(
        report.assessment.unwrap().action,
        RetentionAction::WaitForRecordingStop {
            session_id: "active".into()
        }
    );
    assert_eq!(counter(&store), before);
    assert_eq!(
        store.recovery_state(&control()).unwrap().active_session_id,
        Some("active".into())
    );
}

#[test]
fn continue_requires_a_matching_active_job_and_executes_only_the_explicit_step() {
    let (_directory, mut store) = setup(&[500, 500, 500]);
    let state = prime(&mut store);
    let missing = store.coordinate_retention_once(
        &input(
            state.clone(),
            100,
            CoordinatorIntent::ContinueExisting(step(1, 1)),
        ),
        &control(),
    );
    no_write(&missing, NoWriteReason::NoActiveJob);
    store.begin_retention_job(begin(), &control()).unwrap();
    let before = counter(&store);
    let wrong = store.coordinate_retention_once(
        &input(
            state.clone(),
            100,
            CoordinatorIntent::ContinueExisting(JobStepRequest {
                job_id: "other".into(),
                ..step(1, 1)
            }),
        ),
        &control(),
    );
    no_write(&wrong, NoWriteReason::DifferentActiveJob);
    assert_eq!(counter(&store), before);
    let report = store.coordinate_retention_once(
        &input(state, 100, CoordinatorIntent::ContinueExisting(step(1, 1))),
        &control(),
    );
    assert!(matches!(
        report.outcome,
        Ok(CoordinatorOutcome::Stepped(JobStepReceipt {
            deleted_ticks: 1,
            completed: false,
            ..
        }))
    ));
    assert_eq!(counter(&store), before + 1);
    assert_eq!(count(&store, "observations"), 4);
    assert_eq!(
        store
            .recovery_state(&control())
            .unwrap()
            .active_job
            .unwrap()
            .status
            .next_step,
        Some(2)
    );
}

#[test]
fn partial_reply_loss_replays_the_same_step_without_advancing_or_changing_its_size() {
    let (directory, mut store) = setup(&[500, 500, 500]);
    store.begin_retention_job(begin(), &control()).unwrap();
    let original = store.step_retention_job(step(1, 1), &control()).unwrap();
    drop(store); // Host lost the reply and all volatile guard state.
    let mut store = directory.open();
    let before = counter(&store);
    let report = store.coordinate_retention_once(
        &input(
            GuardState::Unarmed,
            0,
            CoordinatorIntent::ContinueExisting(step(1, 1)),
        ),
        &control(),
    );
    assert_eq!(
        report.outcome.unwrap(),
        CoordinatorOutcome::Stepped(original)
    );
    assert_eq!(counter(&store), before);
    assert_eq!(count(&store, "observations"), 4);
    let retry = store.coordinate_retention_once(
        &input(
            report.next_state.clone(),
            100,
            CoordinatorIntent::ContinueExisting(step(1, 2)),
        ),
        &control(),
    );
    assert!(matches!(
        retry.outcome,
        Err(CoordinatorError::Store(StoreError::Conflict))
    ));
    assert!(retry.assessment.is_some());
    let ahead = store.coordinate_retention_once(
        &input(
            report.next_state,
            100,
            CoordinatorIntent::ContinueExisting(step(3, 1)),
        ),
        &control(),
    );
    assert!(matches!(
        ahead.outcome,
        Err(CoordinatorError::Store(StoreError::Sequence {
            expected: 2
        }))
    ));
    assert_eq!(counter(&store), before);
}

#[test]
fn completion_is_discovered_without_replaying_or_starting_another_job() {
    let (_directory, mut store) = setup(&[500]);
    store.begin_retention_job(begin(), &control()).unwrap();
    let receipt = store.step_retention_job(step(1, 1), &control()).unwrap();
    assert!(receipt.completed);
    let before = counter(&store);
    let state = prime(&mut store);
    let done = store.coordinate_retention_once(
        &input(
            state.clone(),
            100,
            CoordinatorIntent::ContinueExisting(step(1, 1)),
        ),
        &control(),
    );
    no_write(&done, NoWriteReason::NoActiveJob);
    let again = store.coordinate_retention_once(
        &input(state, 100, CoordinatorIntent::Begin(begin())),
        &control(),
    );
    no_write(&again, NoWriteReason::NotProposed);
    assert_eq!(again.assessment.unwrap().action, RetentionAction::NoAdvance);
    // Exact final receipt retrieval remains an explicit use of the job API.
    assert_eq!(
        store.step_retention_job(step(1, 1), &control()).unwrap(),
        receipt
    );
    assert_eq!(counter(&store), before);
}

#[test]
fn explicit_continuation_keeps_clock_suspension_and_does_not_rearm() {
    let (_directory, mut store) = setup(&[500, 500]);
    let state = prime(&mut store);
    store.begin_retention_job(begin(), &control()).unwrap();
    let mut request = input(state, 100, CoordinatorIntent::ContinueExisting(step(1, 1)));
    request.sample.wall_time_ms = i64::MAX;
    let report = store.coordinate_retention_once(&request, &control());
    assert!(matches!(
        report.next_state,
        GuardState::Suspended {
            reason: super::super::clock_guard::SuspendReason::MalformedClockSample
        }
    ));
    assert!(!report.rearm_required); // Clock stop, not an invalid API contract.
    assert!(matches!(report.outcome, Ok(CoordinatorOutcome::Stepped(_))));
    let old = report.next_state.clone();
    let observed = store.coordinate_retention_once(
        &input(report.next_state, 200, CoordinatorIntent::Observe),
        &control(),
    );
    assert_eq!(observed.next_state, old);
    assert_eq!(count(&store, "observations"), 2);
}
