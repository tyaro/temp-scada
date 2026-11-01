use super::*;
use crate::store::test_support::*;
use std::time::Duration;
fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(10)).unwrap()
}
#[test]
fn initial_and_active_recording_are_observed_without_writes() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let initial = store.recovery_state(&control()).unwrap();
    assert_eq!(initial.snapshot_commit, 0);
    assert_eq!(initial.retention_fence.source, FenceSource::Initial);
    assert!(initial.active_job.is_none());
    assert!(initial.active_session_id.is_none());
    store.begin_session(spec("a")).unwrap();
    store.append_tick(tick("a", 1, 1000)).unwrap();
    let before = counter(&store);
    let state = store.recovery_state(&control()).unwrap();
    assert_eq!(state.active_session_id, Some("a".into()));
    assert_eq!(counter(&store), before);
    assert!(store.connection.is_autocommit());
    drop(store);
    let mut store = directory.open();
    let before = counter(&store);
    assert!(store
        .recovery_state(&control())
        .unwrap()
        .active_session_id
        .is_none());
    assert_eq!(counter(&store), before);
}

use crate::store::retention::{
    jobs::{JobRequest, JobState},
    TrimRequest,
};
fn request() -> JobRequest {
    JobRequest {
        job_id: "lost-job-id".into(),
        cutoff_ms: 2000,
        expected_cutoff_ms: None,
    }
}
fn step(number: u64, max_ticks: u32) -> JobStepRequest {
    JobStepRequest {
        job_id: "lost-job-id".into(),
        step: number,
        max_ticks,
    }
}
fn setup(times: impl IntoIterator<Item = i64>) -> (TempStore, SqliteStore) {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    for (n, time) in times.into_iter().enumerate() {
        store.append_tick(tick("a", n as u64 + 1, time)).unwrap();
    }
    store.close_session("a").unwrap();
    (directory, store)
}

#[test]
fn reopened_host_discovers_a_job_before_any_step_without_knowing_its_id() {
    let (directory, mut store) = setup([1000, 1000, 1000]);
    let begin = store.begin_retention_job(request(), &control()).unwrap();
    drop(store);
    let mut store = directory.open();
    let before = counter(&store);
    let state = store.recovery_state(&control()).unwrap();
    let active = state.active_job.unwrap();
    assert_eq!(active.status.job_id, begin.job_id);
    assert_eq!(active.status.next_step, Some(1));
    assert_eq!(active.last_step, None);
    assert_eq!(state.retention_fence.source, FenceSource::Initial);
    assert_eq!(counter(&store), before);
    assert_eq!(count(&store, "observations"), 6);
    let receipt = store
        .step_retention_job(
            JobStepRequest {
                job_id: active.status.job_id,
                step: active.status.next_step.unwrap(),
                max_ticks: 1,
            },
            &control(),
        )
        .unwrap();
    assert!(!receipt.completed);
}

#[test]
fn pending_same_timestamp_restores_the_exact_last_request_and_receipt() {
    let (directory, mut store) = setup([1000, 1000, 1000]);
    store.begin_retention_job(request(), &control()).unwrap();
    let expected = store.step_retention_job(step(1, 2), &control()).unwrap();
    assert!(!expected.completed);
    drop(store);
    let mut store = directory.open();
    let before = counter(&store);
    let state = store.recovery_state(&control()).unwrap();
    let active = state.active_job.unwrap();
    assert_eq!(active.status.next_step, Some(2));
    let last = active.last_step.unwrap();
    assert_eq!(last.request, step(1, 2));
    assert_eq!(last.receipt, expected);
    assert_eq!(
        store.step_retention_job(last.request, &control()).unwrap(),
        last.receipt
    );
    assert_eq!(counter(&store), before);
    assert_eq!(count(&store, "observations"), 2);
    let completed = store
        .step_retention_job(
            JobStepRequest {
                job_id: active.status.job_id.clone(),
                step: active.status.next_step.unwrap(),
                max_ticks: 2,
            },
            &control(),
        )
        .unwrap();
    assert!(completed.completed);
    let state = store.recovery_state(&control()).unwrap();
    assert!(state.active_job.is_none());
    assert_eq!(
        state.retention_fence.source,
        FenceSource::CompletedJob {
            job_id: active.status.job_id
        }
    );
    assert_eq!(
        state.retention_fence.revision_commit,
        completed.commit_version
    );
}

#[test]
fn fence_origin_tracks_trim_job_and_a_later_trim() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store
        .trim(
            TrimRequest {
                request_id: "first".into(),
                cutoff_ms: 100,
                expected_cutoff_ms: None,
            },
            &control(),
        )
        .unwrap();
    assert_eq!(
        store
            .recovery_state(&control())
            .unwrap()
            .retention_fence
            .source,
        FenceSource::SingleTrim {
            request_id: "first".into()
        }
    );
    store.begin_session(spec("a")).unwrap();
    store.append_tick(tick("a", 1, 1000)).unwrap();
    store.append_tick(tick("a", 2, 2500)).unwrap();
    store.close_session("a").unwrap();
    let mut job = request();
    job.expected_cutoff_ms = Some(100);
    store.begin_retention_job(job, &control()).unwrap();
    assert_eq!(
        store
            .recovery_state(&control())
            .unwrap()
            .retention_fence
            .source,
        FenceSource::SingleTrim {
            request_id: "first".into()
        }
    );
    store.step_retention_job(step(1, 1), &control()).unwrap();
    assert_eq!(
        store
            .recovery_state(&control())
            .unwrap()
            .retention_fence
            .source,
        FenceSource::CompletedJob {
            job_id: "lost-job-id".into()
        }
    );
    store
        .trim(
            TrimRequest {
                request_id: "last".into(),
                cutoff_ms: 3000,
                expected_cutoff_ms: Some(2000),
            },
            &control(),
        )
        .unwrap();
    let state = store.recovery_state(&control()).unwrap();
    assert_eq!(
        state.retention_fence.source,
        FenceSource::SingleTrim {
            request_id: "last".into()
        }
    );
    assert_eq!(state.retention_fence.cutoff_ms, Some(3000));
}

#[test]
fn stale_next_step_observations_never_silently_advance_more_deletions() {
    let (_directory, mut store) = setup([1000, 1200, 1400]);
    store.begin_retention_job(request(), &control()).unwrap();
    let stale = store
        .recovery_state(&control())
        .unwrap()
        .active_job
        .unwrap();
    let observed = JobStepRequest {
        job_id: stale.status.job_id,
        step: stale.status.next_step.unwrap(),
        max_ticks: 1,
    };
    let first = store
        .step_retention_job(observed.clone(), &control())
        .unwrap();
    let before = counter(&store);
    assert_eq!(
        store
            .step_retention_job(observed.clone(), &control())
            .unwrap(),
        first
    );
    let mut changed = observed;
    changed.max_ticks = 2;
    assert!(matches!(
        store.step_retention_job(changed, &control()),
        Err(StoreError::Conflict)
    ));
    assert_eq!(counter(&store), before);
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
fn recovery_pins_fence_and_source_with_the_first_commit_read() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut other = Connection::open(&store.database_path).unwrap();
    let payload = serde_json::to_string(&TrimRequest {
        request_id: "external".into(),
        cutoff_ms: 100,
        expected_cutoff_ms: None,
    })
    .unwrap();
    let old=store.recovery_with_hook(&control(),&mut || {
  let tx=other.transaction()?;tx.execute("UPDATE store_meta SET last_commit=last_commit+1",[])?;tx.execute("INSERT INTO retention_operations VALUES('external',?1,100,(SELECT last_commit FROM store_meta),0,0)",[&payload])?;tx.execute("UPDATE retention_state SET cutoff_ms=100,revision_commit=(SELECT last_commit FROM store_meta)",[])?;tx.commit()?;Ok(())
 }).unwrap();
    assert_eq!(old.snapshot_commit, 0);
    assert_eq!(old.retention_fence.source, FenceSource::Initial);
    let new = store.recovery_state(&control()).unwrap();
    assert_eq!(new.snapshot_commit, 1);
    assert_eq!(
        new.retention_fence.source,
        FenceSource::SingleTrim {
            request_id: "external".into()
        }
    );
    assert_eq!(new.retention_fence.cutoff_ms, Some(100));
}

#[test]
fn reads_are_possible_with_all_logical_writes_denied() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let (_directory, mut store) = setup([1000, 1000]);
    store.begin_retention_job(request(), &control()).unwrap();
    store.step_retention_job(step(1, 1), &control()).unwrap();
    let before = counter(&store);
    store
        .connection
        .authorizer(Some(|c: AuthContext<'_>| match c.action {
            AuthAction::Insert { .. } | AuthAction::Update { .. } | AuthAction::Delete { .. } => {
                Authorization::Deny
            }
            _ => Authorization::Allow,
        }))
        .unwrap();
    let state = store.recovery_state(&control()).unwrap();
    assert_eq!(state.active_job.unwrap().status.deleted_ticks, 1);
    assert_eq!(counter(&store), before);
    assert_eq!(count(&store, "observations"), 2);
}

#[test]
fn missing_singletons_or_malformed_trim_origin_are_not_normal_initial_state() {
    for corruption in ["DELETE FROM store_meta","DELETE FROM retention_state","UPDATE retention_operations SET payload_json='{}'","PRAGMA ignore_check_constraints=ON; UPDATE retention_operations SET deleted_ticks=1025,deleted_observations=1025"] {
 let directory=TempStore::new();let mut store=directory.create();store.trim(TrimRequest{request_id:"trim".into(),cutoff_ms:100,expected_cutoff_ms:None},&control()).unwrap();store.connection.execute_batch(corruption).unwrap();assert!(matches!(store.recovery_state(&control()),Err(StoreError::CorruptData)),"{corruption}");assert!(store.connection.is_autocommit());
 }
}

#[test]
fn duplicate_candidates_and_recording_retention_overlap_are_rejected() {
    for corruption in ["DROP INDEX one_active_retention_job; INSERT INTO retention_jobs SELECT 'second',payload_json,cutoff_ms,expected_cutoff_ms,state,begin_commit+1,last_step,deleted_ticks,deleted_observations,completion_commit,policy_applied_revision FROM retention_jobs", "UPDATE sessions SET state='active',end_commit=NULL"] {
 let (_directory,mut store)=setup([1000]);store.begin_retention_job(request(),&control()).unwrap();store.connection.execute_batch(corruption).unwrap();assert!(matches!(store.recovery_state(&control()),Err(StoreError::CorruptData)),"{corruption}");
 }
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    let text = serde_json::to_string(&spec("b")).unwrap();
    store
        .connection
        .execute_batch("DROP INDEX one_active_session")
        .unwrap();
    store
        .connection
        .execute(
            "INSERT INTO sessions VALUES('b','active',?1,0,1,NULL)",
            [text],
        )
        .unwrap();
    assert!(matches!(
        store.recovery_state(&control()),
        Err(StoreError::CorruptData)
    ));
}

#[test]
fn applied_origin_ties_missing_final_steps_and_rolled_back_heads_are_corrupt() {
    let (directory, mut store) = setup([1000, 1200, 1400]);
    store.begin_retention_job(request(), &control()).unwrap();
    store.step_retention_job(step(1, 1), &control()).unwrap();
    store.step_retention_job(step(2, 1), &control()).unwrap();
    store
        .connection
        .execute("UPDATE retention_jobs SET last_step=1", [])
        .unwrap();
    assert!(matches!(
        store.recovery_state(&control()),
        Err(StoreError::CorruptData)
    ));
    drop(store);
    drop(directory);
    for duplicate in [false, true] {
        let (_directory, mut store) = setup([1000]);
        store.begin_retention_job(request(), &control()).unwrap();
        let last = store.step_retention_job(step(1, 1), &control()).unwrap();
        if duplicate {
            let payload = serde_json::to_string(&TrimRequest {
                request_id: "tie".into(),
                cutoff_ms: 2000,
                expected_cutoff_ms: None,
            })
            .unwrap();
            store
                .connection
                .execute(
                    "INSERT INTO retention_operations VALUES('tie',?1,2000,?2,0,0)",
                    rusqlite::params![payload, last.commit_version as i64],
                )
                .unwrap();
        } else {
            store
                .connection
                .execute_batch("PRAGMA foreign_keys=OFF; DELETE FROM retention_job_steps")
                .unwrap();
        }
        assert!(matches!(
            store.recovery_state(&control()),
            Err(StoreError::CorruptData)
        ));
    }
}

#[test]
fn active_session_sequence_and_receipt_header_are_validated() {
    for corruption in [
        "UPDATE sessions SET last_sequence=0",
        "UPDATE commits SET payload_json='{}'",
        "UPDATE sessions SET spec_json='{}'",
    ] {
        let directory = TempStore::new();
        let mut store = directory.create();
        store.begin_session(spec("a")).unwrap();
        store.append_tick(tick("a", 1, 1000)).unwrap();
        store.connection.execute_batch(corruption).unwrap();
        assert!(
            matches!(
                store.recovery_state(&control()),
                Err(StoreError::CorruptData)
            ),
            "{corruption}"
        );
    }
}

#[test]
fn controls_cleanup_and_read_failures_preserve_the_existing_poison_contract() {
    use crate::store::query::QueryError;
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let directory = TempStore::new();
    let mut store = directory.create();
    let before = counter(&store);
    for kind in 0..5 {
        let mut c = control();
        match kind {
            0 => c.cancellation.cancel(),
            1 => c.deadline = std::time::Instant::now(),
            2 => c.limits.max_vm_steps = 1000,
            3 => c.limits.max_decoded_rows = 1,
            _ => c.limits.max_output_bytes = 1,
        }
        assert!(matches!(
            store.recovery_state(&c),
            Err(StoreError::Control(_))
        ));
        assert!(store.connection.is_autocommit());
        assert!(!store.needs_reopen);
        assert_eq!(counter(&store), before);
    }
    let c = control();
    assert!(matches!(
        store.recovery_with_hook(&c, &mut || {
            c.cancellation.cancel();
            Ok(())
        }),
        Err(StoreError::Control(QueryError::Cancelled))
    ));
    assert!(store.connection.is_autocommit());
    assert!(store.recovery_state(&control()).is_ok());
    store
        .connection
        .authorizer(Some(|c: AuthContext<'_>| {
            if matches!(
                c.action,
                AuthAction::Read {
                    table_name: "store_meta",
                    ..
                }
            ) {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }))
        .unwrap();
    assert!(matches!(
        store.recovery_state(&control()),
        Err(StoreError::Sqlite(_))
    ));
    assert!(store.needs_reopen);
    assert!(matches!(
        store.recovery_state(&control()),
        Err(StoreError::NeedsReopen)
    ));
    drop(store);
    let mut store = directory.open();
    assert!(store.recovery_state(&control()).is_ok());
}

#[test]
fn panic_cleanup_and_failed_rollback_keep_writer_ownership_and_poison() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
    for deny in [false, true] {
        let directory = TempStore::new();
        let mut store = directory.create();
        if deny {
            store
                .connection
                .authorizer(Some(|c: AuthContext<'_>| {
                    if matches!(
                        c.action,
                        AuthAction::Transaction {
                            operation: TransactionOperation::Rollback
                        }
                    ) {
                        Authorization::Deny
                    } else {
                        Authorization::Allow
                    }
                }))
                .unwrap();
        }
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = store.recovery_with_hook(&control(), &mut || panic!("fault unwind"));
        }));
        assert!(panic.is_err());
        assert_eq!(store.needs_reopen, deny);
        if !deny {
            assert!(store.connection.is_autocommit());
            assert!(store.recovery_state(&control()).is_ok());
        } else {
            assert!(matches!(
                store.recovery_state(&control()),
                Err(StoreError::NeedsReopen)
            ));
        }
        drop(store);
        let mut store = directory.open();
        assert!(store.recovery_state(&control()).is_ok());
    }
}

#[test]
fn process_restarts_discover_progress_and_completion_without_a_saved_job_id() {
    for phase in ["begin", "partial", "complete"] {
        let (directory, store) = setup([1000, 1000, 1000]);
        drop(store);
        let exit = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store::recovery::tests::recovery_process_worker",
                "--nocapture",
            ])
            .env("SCADA_RECOVERY_TEST_PATH", &directory.0)
            .env("SCADA_RECOVERY_TEST_PHASE", phase)
            .status()
            .unwrap();
        assert_eq!(exit.code(), Some(89));
        let mut store = directory.open();
        let before = counter(&store);
        let state = store.recovery_state(&control()).unwrap();
        assert_eq!(counter(&store), before);
        if phase == "complete" {
            assert!(state.active_job.is_none());
            assert_eq!(
                state.retention_fence.source,
                FenceSource::CompletedJob {
                    job_id: "lost-job-id".into()
                }
            );
        } else {
            let active = state.active_job.unwrap();
            assert_eq!(active.status.state, JobState::Active);
            assert_eq!(active.status.job_id, "lost-job-id");
            if let Some(last) = active.last_step {
                assert_eq!(
                    store.step_retention_job(last.request, &control()).unwrap(),
                    last.receipt
                );
                assert_eq!(counter(&store), before);
            }
            for _ in 0..3 {
                let Some(active) = store.recovery_state(&control()).unwrap().active_job else {
                    break;
                };
                store
                    .step_retention_job(
                        JobStepRequest {
                            job_id: active.status.job_id,
                            step: active.status.next_step.unwrap(),
                            max_ticks: 2,
                        },
                        &control(),
                    )
                    .unwrap();
            }
            assert!(store
                .recovery_state(&control())
                .unwrap()
                .active_job
                .is_none());
        }
    }
}

#[test]
fn recovery_process_worker() {
    let Ok(path) = std::env::var("SCADA_RECOVERY_TEST_PATH") else {
        return;
    };
    let phase = std::env::var("SCADA_RECOVERY_TEST_PHASE").unwrap();
    let mut store = reopen_unowned(path, &identity()).unwrap();
    store.begin_retention_job(request(), &control()).unwrap();
    if phase == "partial" {
        store.step_retention_job(step(1, 1), &control()).unwrap();
    } else if phase == "complete" {
        assert!(
            store
                .step_retention_job(step(1, 3), &control())
                .unwrap()
                .completed
        );
    }
    std::process::exit(89);
}
