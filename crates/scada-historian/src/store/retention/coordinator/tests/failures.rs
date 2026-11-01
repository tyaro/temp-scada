use super::*;
use crate::store::{
    query::QueryError,
    retention::{clock_guard::SuspendReason, TrimRequest},
};

#[test]
fn discovery_failure_has_no_assessment_or_write_and_retains_the_input_state() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let state = prime(&mut store);
    for kind in 0..6 {
        let mut c = control();
        match kind {
            0 => c.cancellation.cancel(),
            1 => c.deadline = std::time::Instant::now(),
            2 => c.limits.max_vm_steps = 1000,
            3 => c.limits.max_decoded_rows = 1,
            4 => c.limits.max_output_bytes = 1,
            _ => c.limits.max_vm_steps = 0,
        }
        let report = store.coordinate_retention_once(
            &input(state.clone(), 100, CoordinatorIntent::Begin(begin())),
            &c,
        );
        assert!(matches!(
            report.outcome,
            Err(CoordinatorError::Store(StoreError::Control(_)))
        ));
        assert_eq!(report.next_state, state);
        assert!(report.recovery.is_none() && report.assessment.is_none());
        assert!(!report.rearm_required);
        assert_eq!(counter(&store), 0);
        assert!(store.connection.is_autocommit());
        assert!(!store.needs_reopen);
    }
    store.needs_reopen = true;
    let report = store.coordinate_retention_once(
        &input(state.clone(), 100, CoordinatorIntent::Begin(begin())),
        &control(),
    );
    assert!(matches!(
        report.outcome,
        Err(CoordinatorError::Store(StoreError::NeedsReopen))
    ));
    assert_eq!(report.next_state, state);
    assert!(report.assessment.is_none());
}

#[test]
fn invalid_assessment_requires_rearm_and_never_executes_even_explicit_continuation() {
    let (_directory, mut store) = setup(&[500, 500]);
    let state = prime(&mut store);
    store.begin_retention_job(begin(), &control()).unwrap();
    let before = counter(&store);
    for kind in 0..3 {
        let mut request = input(
            state.clone(),
            100,
            CoordinatorIntent::ContinueExisting(step(1, 1)),
        );
        let expected = match kind {
            0 => {
                request.policy.revision = 0;
                InvalidInput::Policy
            }
            1 => {
                request.candidate_cutoff_ms = Some(i64::MAX);
                InvalidInput::Cutoff
            }
            _ => {
                request.guard_state = GuardState::Tracking {
                    policy_snapshot: policy(),
                    last_sample: ClockSample {
                        trusted: false,
                        ..sample(2000, 0)
                    },
                };
                InvalidInput::GuardState
            }
        };
        let report = store.coordinate_retention_once(&request, &control());
        assert!(
            matches!(report.outcome, Err(CoordinatorError::Assessment(actual)) if actual == expected)
        );
        assert!(report.rearm_required);
        assert_eq!(report.next_state, request.guard_state);
        assert!(report.assessment.is_none());
        assert!(report.recovery.unwrap().active_job.is_some());
        assert_eq!(counter(&store), before);
        assert_eq!(count(&store, "observations"), 4);
    }
}

#[test]
fn post_assessment_cancellation_returns_tracking_or_latched_suspension_with_the_error() {
    let (_directory, mut store) = setup(&[500, 500]);
    let state = prime(&mut store);
    let c = control();
    let before = counter(&store);
    let report = store.coordinate_with_hook(
        &input(state.clone(), 100, CoordinatorIntent::Begin(begin())),
        &c,
        &mut |_| {
            c.cancellation.cancel();
            Ok(())
        },
    );
    assert!(matches!(
        report.outcome,
        Err(CoordinatorError::Store(StoreError::Control(
            QueryError::Cancelled
        )))
    ));
    assert!(matches!(report.next_state, GuardState::Tracking { .. }));
    assert!(report.assessment.is_some() && report.recovery.is_some());
    assert_eq!(counter(&store), before);

    store.begin_retention_job(begin(), &control()).unwrap();
    let c = control();
    let before = counter(&store);
    let mut request = input(state, 100, CoordinatorIntent::ContinueExisting(step(1, 1)));
    request.sample.wall_time_ms = 9000;
    let report = store.coordinate_with_hook(&request, &c, &mut |_| {
        c.cancellation.cancel();
        Ok(())
    });
    assert!(matches!(
        report.outcome,
        Err(CoordinatorError::Store(StoreError::Control(
            QueryError::Cancelled
        )))
    ));
    assert_eq!(
        report.next_state,
        GuardState::Suspended {
            reason: SuspendReason::ClockDriftExceeded
        }
    );
    assert_eq!(report.assessment.unwrap().next_state, report.next_state);
    assert!(report.recovery.unwrap().active_job.is_some());
    assert_eq!(counter(&store), before);
    assert_eq!(count(&store, "observations"), 4);
    assert!(store.connection.is_autocommit());
    assert!(!store.needs_reopen);
}

#[test]
fn intervening_fence_recording_or_job_still_uses_the_store_conflict_gates() {
    for kind in 0..3 {
        let directory = TempStore::new();
        let mut store = directory.create();
        let state = prime(&mut store);
        let report = store.coordinate_with_hook(
            &input(state, 100, CoordinatorIntent::Begin(begin())),
            &control(),
            &mut |store| {
                match kind {
                    0 => {
                        store.trim(
                            TrimRequest {
                                request_id: "intervening".into(),
                                cutoff_ms: 500,
                                expected_cutoff_ms: None,
                            },
                            &control(),
                        )?;
                    }
                    1 => {
                        store.begin_session(spec("intervening"))?;
                    }
                    _ => {
                        store.begin_retention_job(
                            JobRequest {
                                job_id: "intervening".into(),
                                ..begin()
                            },
                            &control(),
                        )?;
                    }
                }
                Ok(())
            },
        );
        assert!(matches!(report.next_state, GuardState::Tracking { .. }));
        assert!(matches!(
            report.assessment.unwrap().action,
            RetentionAction::ProposeJob { .. }
        ));
        // The report describes the pre-operation discovery, not the later write.
        assert_eq!(report.recovery.unwrap().snapshot_commit, 0);
        match kind {
            0 => assert!(matches!(
                report.outcome,
                Err(CoordinatorError::Store(StoreError::Conflict))
            )),
            _ => assert!(matches!(
                report.outcome,
                Err(CoordinatorError::Store(StoreError::Busy))
            )),
        }
        assert_eq!(counter(&store), 1); // Only the injected competing operation.
        assert!(!store.needs_reopen);
    }
}

#[test]
fn invalid_job_parameters_remain_store_errors_with_the_assessment_attached() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let state = prime(&mut store);
    let bad_begin = store.coordinate_retention_once(
        &input(
            state.clone(),
            100,
            CoordinatorIntent::Begin(JobRequest {
                job_id: "bad id".into(),
                ..begin()
            }),
        ),
        &control(),
    );
    assert!(matches!(
        bad_begin.outcome,
        Err(CoordinatorError::Store(StoreError::Invalid(_)))
    ));
    assert!(bad_begin.assessment.is_some());
    assert_eq!(counter(&store), 0);
    store.begin_retention_job(begin(), &control()).unwrap();
    for request in [step(0, 1), step(1, 0), step(1, 1025)] {
        let report = store.coordinate_retention_once(
            &input(
                state.clone(),
                100,
                CoordinatorIntent::ContinueExisting(request),
            ),
            &control(),
        );
        assert!(matches!(
            report.outcome,
            Err(CoordinatorError::Store(StoreError::Invalid(_)))
        ));
        assert!(report.assessment.is_some());
        assert_eq!(counter(&store), 1);
    }
}

#[test]
fn sql_failure_keeps_the_new_state_and_poison_is_not_cleared_by_the_coordinator() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let directory = TempStore::new();
    let mut store = directory.create();
    let state = prime(&mut store);
    store
        .connection
        .authorizer(Some(|c: AuthContext<'_>| {
            if matches!(
                c.action,
                AuthAction::Insert {
                    table_name: "retention_jobs"
                }
            ) {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }))
        .unwrap();
    let report = store.coordinate_retention_once(
        &input(state, 100, CoordinatorIntent::Begin(begin())),
        &control(),
    );
    assert!(matches!(
        report.outcome,
        Err(CoordinatorError::Store(StoreError::Sqlite(_)))
    ));
    assert!(matches!(report.next_state, GuardState::Tracking { .. }));
    assert!(report.assessment.is_some() && report.recovery.is_some());
    assert!(store.needs_reopen);
    assert_eq!(counter(&store), 0);
    let denied = store.coordinate_retention_once(
        &input(report.next_state, 200, CoordinatorIntent::Observe),
        &control(),
    );
    assert!(matches!(
        denied.outcome,
        Err(CoordinatorError::Store(StoreError::NeedsReopen))
    ));
    drop(store);
    let mut store = directory.open();
    assert_eq!(
        prime(&mut store),
        GuardState::Primed {
            policy_snapshot: policy(),
            last_sample: sample(2000, 0)
        }
    );
}

#[test]
fn real_full_during_explicit_step_preserves_the_clock_stop_and_atomic_job_progress() {
    let (directory, mut store) = setup(&[500, 500]);
    let state = prime(&mut store);
    store.begin_retention_job(begin(), &control()).unwrap();
    store.connection.execute_batch("CREATE TABLE coordinator_pressure(value BLOB); CREATE TEMP TRIGGER full_coordinator_step AFTER DELETE ON observations BEGIN INSERT INTO coordinator_pressure VALUES(zeroblob(1048576)); END;").unwrap();
    let maximum: i64 = store
        .connection
        .query_row("PRAGMA max_page_count", [], |r| r.get(0))
        .unwrap();
    let pages: i64 = store
        .connection
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .unwrap();
    store
        .connection
        .pragma_update(None, "max_page_count", pages)
        .unwrap();
    let before = counter(&store);
    let mut request = input(state, 100, CoordinatorIntent::ContinueExisting(step(1, 1)));
    request.sample.trusted = false;
    let report = store.coordinate_retention_once(&request, &control());
    assert!(
        matches!(&report.outcome, Err(CoordinatorError::Store(StoreError::Sqlite(e))) if e.sqlite_error_code() == Some(rusqlite::ErrorCode::DiskFull)),
        "{report:?}"
    );
    assert_eq!(
        report.next_state,
        GuardState::Suspended {
            reason: SuspendReason::UntrustedClock
        }
    );
    assert!(report.assessment.is_some());
    assert!(store.needs_reopen);
    assert!(store.connection.is_autocommit());
    assert_eq!(counter(&store), before);
    assert_eq!(count(&store, "observations"), 4);
    store
        .connection
        .pragma_update(None, "max_page_count", maximum)
        .unwrap();
    drop(store);
    let mut store = directory.open();
    let state = store.recovery_state(&control()).unwrap();
    assert_eq!(state.active_job.unwrap().status.next_step, Some(1));
    let retried = store.coordinate_retention_once(
        &input(
            report.next_state,
            200,
            CoordinatorIntent::ContinueExisting(step(1, 1)),
        ),
        &control(),
    );
    assert!(matches!(
        retried.outcome,
        Ok(CoordinatorOutcome::Stepped(_))
    ));
    assert!(matches!(retried.next_state, GuardState::Suspended { .. }));
    assert_eq!(count(&store, "observations"), 2);
}
