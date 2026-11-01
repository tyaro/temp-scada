use super::*;
use crate::store::test_support::*;
use std::time::Duration;

fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(10)).unwrap()
}
fn request(id: &str, cutoff: i64, expected: Option<i64>) -> TrimRequest {
    TrimRequest {
        request_id: id.into(),
        cutoff_ms: cutoff,
        expected_cutoff_ms: expected,
    }
}

#[test]
fn trim_is_atomic_and_retries_never_restore_observations() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    let first = tick("a", 1, 1000);
    let receipt = store.append_tick(first.clone()).unwrap();
    store.append_tick(tick("a", 2, 2000)).unwrap();
    assert!(matches!(
        store.trim(request("trim", 2000, None), &control()),
        Err(StoreError::Busy)
    ));
    store.close_session("a").unwrap();
    let trim = store.trim(request("trim", 2000, None), &control()).unwrap();
    assert_eq!(trim.deleted_ticks, 1);
    assert_eq!(trim.deleted_observations, 2);
    assert_eq!(count(&store, "observations"), 2);
    assert_eq!(count(&store, "commits"), 2);
    assert_eq!(store.append_tick(first.clone()).unwrap(), receipt);
    assert_eq!(
        store.trim(request("trim", 2000, None), &control()).unwrap(),
        trim
    );
    assert_eq!(count(&store, "observations"), 2);
    store.begin_session(spec("b")).unwrap();
    assert!(matches!(
        store.append_tick(tick("b", 1, 1999)),
        Err(StoreError::RetentionCutoff)
    ));
    assert_eq!(
        store
            .session_status("b")
            .unwrap()
            .unwrap()
            .committed_through,
        0
    );
    store.append_tick(tick("b", 1, 2000)).unwrap();
    drop(store);
    let mut store = directory.open();
    assert_eq!(store.append_tick(first).unwrap(), receipt);
    assert_eq!(
        store.trim(request("trim", 2000, None), &control()).unwrap(),
        trim
    );
}

fn rows(store: &SqliteStore, table: &str) -> i64 {
    assert!(["retention_operations", "expired_samples"].contains(&table));
    store
        .connection
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn cutoff_cas_empty_trim_and_request_identity_are_stable() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let first = store.trim(request("one", -100, None), &control()).unwrap();
    assert_eq!(first.deleted_ticks, 0);
    assert_eq!(rows(&store, "expired_samples"), 0);
    let baseline = counter(&store);
    for bad in [
        request("one", -99, None),
        request("two", -100, Some(-100)),
        request("two", -101, Some(-100)),
        request("two", 0, None),
    ] {
        assert!(matches!(
            store.trim(bad, &control()),
            Err(StoreError::Conflict)
        ));
        assert_eq!(counter(&store), baseline);
    }
    for bad in [
        request("bad id", 0, Some(-100)),
        request("two", MAX_SAFE as i64 + 1, Some(-100)),
    ] {
        assert!(matches!(
            store.trim(bad, &control()),
            Err(StoreError::Invalid(_))
        ));
    }
    store
        .trim(request("two", 0, Some(-100)), &control())
        .unwrap();
    store.begin_session(spec("active")).unwrap();
    assert_eq!(
        store.trim(request("one", -100, None), &control()).unwrap(),
        first
    );
}

#[test]
fn duplicate_timestamps_and_null_members_are_removed_as_complete_ticks() {
    let directory = TempStore::new();
    let mut store = directory.create();
    for s in ["a", "b"] {
        store.begin_session(spec(s)).unwrap();
        for sequence in 1..=2 {
            let mut t = tick(s, sequence, 1000);
            t.observations[0].value = None;
            t.observations[0].quality = Some(super::super::Quality::Bad);
            t.observations[0].reason = Some(super::super::Reason::Bad);
            store.append_tick(t).unwrap();
        }
        store.close_session(s).unwrap();
    }
    let result = store.trim(request("trim", 1001, None), &control()).unwrap();
    assert_eq!((result.deleted_ticks, result.deleted_observations), (4, 8));
    assert_eq!(rows(&store, "expired_samples"), 2);
    let deleted_records: i64 = store
        .connection
        .query_row(
            "SELECT deleted_records FROM expired_samples WHERE series_id='number'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(deleted_records, 4);
    assert_eq!(count(&store, "observations"), 0);
}

#[test]
fn safe_time_edges_and_future_samples_do_not_derive_the_cutoff() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    let mut low = tick("a", 1, -(MAX_SAFE as i64));
    for observation in &mut low.observations {
        observation.source_time_ms = Some(-(MAX_SAFE as i64));
    }
    store.append_tick(low).unwrap();
    let mut high = tick("a", 2, MAX_SAFE as i64);
    high.ingested_at_ms = MAX_SAFE as i64;
    store.append_tick(high).unwrap();
    store.close_session("a").unwrap();
    assert_eq!(
        store
            .trim(request("low", -(MAX_SAFE as i64), None), &control())
            .unwrap()
            .deleted_ticks,
        0
    );
    let result = store
        .trim(
            request("high", MAX_SAFE as i64, Some(-(MAX_SAFE as i64))),
            &control(),
        )
        .unwrap();
    assert_eq!(result.deleted_ticks, 1);
    assert_eq!(count(&store, "observations"), 2);
    let time: i64 = store
        .connection
        .query_row(
            "SELECT sample_time_ms FROM expired_samples LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(time, -(MAX_SAFE as i64));
}

#[test]
fn candidate_tick_cap_rejects_the_entire_operation_and_allows_a_smaller_cutoff() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut one = spec("a");
    one.members.truncate(1);
    store.begin_session(one).unwrap();
    for sequence in 1..=1025 {
        let mut t = tick("a", sequence, sequence as i64);
        t.observations.truncate(1);
        store.append_tick(t).unwrap();
    }
    store.close_session("a").unwrap();
    let baseline = counter(&store);
    let mut low_vm = control();
    low_vm.limits.max_vm_steps = 10_000;
    assert!(matches!(
        store.trim(request("vm", 1026, None), &low_vm),
        Err(StoreError::Control(
            super::super::query::QueryError::WorkLimit
        ))
    ));
    assert!(store.connection.is_autocommit());
    assert!(!store.needs_reopen);
    assert_eq!(counter(&store), baseline);
    assert!(matches!(
        store.trim(request("too-many", 1026, None), &control()),
        Err(StoreError::RetentionLimit)
    ));
    assert_eq!(counter(&store), baseline);
    assert_eq!(rows(&store, "retention_operations"), 0);
    let result = store.trim(request("max", 1025, None), &control()).unwrap();
    assert_eq!(result.deleted_ticks, 1024);
    assert_eq!(count(&store, "observations"), 1);
}

#[test]
fn every_precommit_boundary_rolls_back_and_postcommit_reply_loss_is_retryable() {
    for boundary in [
        Boundary::Metadata,
        Boundary::Observation,
        Boundary::Watermark,
        Boundary::BeforeCommit,
        Boundary::AfterCommit,
    ] {
        let directory = TempStore::new();
        let mut store = directory.create();
        store.begin_session(spec("a")).unwrap();
        store.append_tick(tick("a", 1, 0)).unwrap();
        store.close_session("a").unwrap();
        let baseline = counter(&store);
        assert!(store
            .trim_with_hook(
                request("trim", 1, None),
                &control(),
                &mut |b| if b == boundary {
                    invalid("lost reply")
                } else {
                    Ok(())
                }
            )
            .is_err());
        assert!(store.connection.is_autocommit());
        if boundary == Boundary::AfterCommit {
            assert_eq!(count(&store, "observations"), 0);
            let receipt = store.trim(request("trim", 1, None), &control()).unwrap();
            assert_eq!(counter(&store) as u64, receipt.commit_version);
        } else {
            assert_eq!(counter(&store), baseline);
            assert_eq!(count(&store, "observations"), 2);
            assert_eq!(rows(&store, "expired_samples"), 0);
            assert_eq!(fence(&store.connection).unwrap(), (None, 0));
        }
    }
}

#[test]
fn cancellation_budgets_and_unwind_remove_the_handler_before_rollback() {
    use super::super::query::QueryError;
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    store.append_tick(tick("a", 1, 0)).unwrap();
    store.close_session("a").unwrap();
    for kind in 0..5 {
        let mut c = control();
        match kind {
            0 => c.cancellation.cancel(),
            1 => c.limits.max_vm_steps = 1000,
            2 => c.limits.max_decoded_rows = 1,
            3 => c.limits.max_output_bytes = 1,
            _ => c.deadline = std::time::Instant::now(),
        }
        assert!(matches!(
            store.trim(request("trim", 1, None), &c),
            Err(StoreError::Control(_))
        ));
        assert!(store.connection.is_autocommit());
        assert_eq!(count(&store, "observations"), 2);
    }
    let c = control();
    assert!(matches!(
        store.trim_with_hook(request("trim", 1, None), &c, &mut |b| {
            if b == Boundary::Observation {
                c.cancellation.cancel();
            }
            Ok(())
        }),
        Err(StoreError::Control(QueryError::Cancelled))
    ));
    assert!(store.connection.is_autocommit());
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = store.trim_with_hook(request("trim", 1, None), &control(), &mut |b| {
            if b == Boundary::Observation {
                panic!("test unwind")
            }
            Ok(())
        });
    }));
    assert!(panic.is_err());
    assert!(store.connection.is_autocommit());
    assert!(!store.needs_reopen);
    assert_eq!(
        store
            .trim(request("trim", 1, None), &control())
            .unwrap()
            .deleted_ticks,
        1
    );
}

#[test]
fn sql_failure_poisoning_requires_reopen_and_keeps_all_evidence_atomic() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    store.append_tick(tick("a", 1, 0)).unwrap();
    store.close_session("a").unwrap();
    store.connection.execute_batch("CREATE TEMP TRIGGER reject_trim BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
    assert!(matches!(
        store.trim(request("trim", 1, None), &control()),
        Err(StoreError::Sqlite(_))
    ));
    assert_eq!(count(&store, "observations"), 2);
    assert_eq!(rows(&store, "expired_samples"), 0);
    assert!(matches!(
        store.trim(request("trim", 1, None), &control()),
        Err(StoreError::NeedsReopen)
    ));
    drop(store);
    let mut store = directory.open();
    assert_eq!(
        store
            .trim(request("trim", 1, None), &control())
            .unwrap()
            .deleted_ticks,
        1
    );
}

#[test]
fn format_two_is_refused_without_rewriting_the_database() {
    let directory = TempStore::new();
    drop(directory.create());
    let path = directory.0.join("store.sqlite3");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA user_version=2").unwrap();
    drop(db);
    let before = std::fs::read(&path).unwrap();
    assert!(matches!(
        reopen_unowned(&directory.0, &identity()),
        Err(StoreError::UnsupportedStore)
    ));
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn corrupt_target_members_receipts_and_state_are_never_erased_as_success() {
    for corruption in [
        "DELETE FROM observations WHERE series_id='bool'",
        "UPDATE observations SET sample_time_ms=2 WHERE series_id='bool'",
        "DELETE FROM commits",
        "UPDATE commits SET commit_version=999; UPDATE observations SET commit_version=999",
        "UPDATE commits SET payload_json='{}'",
        "DELETE FROM retention_state",
        "UPDATE retention_state SET cutoff_ms=0,revision_commit=1",
        "UPDATE sessions SET spec_json='{}'",
    ] {
        let directory = TempStore::new();
        let mut store = directory.create();
        store.begin_session(spec("a")).unwrap();
        store.append_tick(tick("a", 1, 0)).unwrap();
        store.close_session("a").unwrap();
        store
            .connection
            .execute_batch("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON")
            .unwrap();
        store.connection.execute_batch(corruption).unwrap();
        let baseline = counter(&store);
        assert!(
            matches!(
                store.trim(request("trim", 1, None), &control()),
                Err(StoreError::CorruptData)
            ),
            "{corruption}"
        );
        assert_eq!(counter(&store), baseline);
        assert_eq!(rows(&store, "retention_operations"), 0);
    }
}

#[test]
fn process_exit_during_trim_recovers_all_or_nothing_and_stable_receipts() {
    use std::process::Command;
    for boundary in [
        "Metadata",
        "Observation",
        "Watermark",
        "BeforeCommit",
        "AfterCommit",
    ] {
        let directory = TempStore::new();
        let mut store = directory.create();
        store.begin_session(spec("a")).unwrap();
        store.append_tick(tick("a", 1, 0)).unwrap();
        store.close_session("a").unwrap();
        drop(store);
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store::retention::tests::trim_process_worker",
                "--nocapture",
            ])
            .env("SCADA_TRIM_TEST_PATH", &directory.0)
            .env("SCADA_TRIM_TEST_BOUNDARY", boundary)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(79));
        let mut store = directory.open();
        let committed = boundary == "AfterCommit";
        assert_eq!(count(&store, "observations"), if committed { 0 } else { 2 });
        assert_eq!(rows(&store, "retention_operations"), i64::from(committed));
        let receipt = store.trim(request("trim", 1, None), &control()).unwrap();
        assert_eq!(receipt.deleted_ticks, 1);
        let baseline = counter(&store);
        assert_eq!(
            store.trim(request("trim", 1, None), &control()).unwrap(),
            receipt
        );
        assert_eq!(counter(&store), baseline);
    }
}

#[test]
fn trim_process_worker() {
    let Ok(path) = std::env::var("SCADA_TRIM_TEST_PATH") else {
        return;
    };
    let boundary = std::env::var("SCADA_TRIM_TEST_BOUNDARY").unwrap();
    let mut store = reopen_unowned(path, &identity()).unwrap();
    store
        .trim_with_hook(request("trim", 1, None), &control(), &mut |b| {
            if format!("{b:?}") == boundary {
                std::process::exit(79);
            }
            Ok(())
        })
        .unwrap();
    panic!("boundary was not reached");
}

#[test]
fn cleanup_failure_during_unwind_persistently_poison_the_writer() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    store.append_tick(tick("a", 1, 0)).unwrap();
    store.close_session("a").unwrap();
    store
        .connection
        .authorizer(Some(|context: AuthContext<'_>| {
            if matches!(
                context.action,
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
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = store.trim_with_hook(request("trim", 1, None), &control(), &mut |b| {
            if b == Boundary::Observation {
                panic!("test unwind")
            }
            Ok(())
        });
    }));
    assert!(panic.is_err());
    assert!(store.needs_reopen);
    assert!(matches!(
        store.begin_session(spec("b")),
        Err(StoreError::NeedsReopen)
    ));
    assert!(matches!(
        store.trim(request("trim", 1, None), &control()),
        Err(StoreError::NeedsReopen)
    ));
    drop(store);
    let store = directory.open();
    assert_eq!(count(&store, "observations"), 2);
}
