use super::*;
use crate::store::test_support::*;
use std::time::Duration;

fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(10)).unwrap()
}

#[test]
fn diagnostics_and_checkpoint_leave_logical_history_unchanged() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    store.append_tick(tick("a", 1, 1000)).unwrap();
    let reader = store.reader().unwrap();
    let baseline = counter(&store);
    let d = store.storage_diagnostics(&control()).unwrap();
    assert!(d.page_count > 0);
    assert_eq!(d.logical_bytes, d.page_count * d.page_size);
    assert_eq!(d.live_reader_leases, 1);
    let report = store.checkpoint_passive(&control()).unwrap();
    assert_eq!(report.status, CheckpointStatus::Complete);
    assert_eq!(report.log_frames, report.checkpointed_frames);
    assert_eq!(counter(&store), baseline);
    assert_eq!(count(&store, "observations"), 2);
    drop(reader);
    store.append_tick(tick("a", 2, 2000)).unwrap();
}

#[test]
fn diagnostic_read_transaction_is_coherent_with_a_concurrent_writer() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store
        .connection
        .execute_batch("PRAGMA wal_autocheckpoint=0")
        .unwrap();
    // A separate connection is only a disposable-DB fault/concurrency fixture.
    let connection = Connection::open(&store.database_path).unwrap();
    let old = store.storage_diagnostics(&control()).unwrap();
    let during = store.diagnostics_with_hook(&control(), &mut || {
        connection.execute_batch("CREATE TABLE diagnostic_fixture (payload BLOB); INSERT INTO diagnostic_fixture VALUES (zeroblob(1048576))")?;
        Ok(())
    }).unwrap();
    assert_eq!(during.page_count, old.page_count);
    assert_eq!(during.freelist_count, old.freelist_count);
    assert!(store.storage_diagnostics(&control()).unwrap().page_count > old.page_count);
    assert!(store.connection.is_autocommit());
}

#[test]
fn trim_free_pages_and_passive_checkpoint_do_not_claim_file_shrinkage() {
    use crate::store::retention::TrimRequest;
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    for sequence in 1..=256 {
        store
            .append_tick(tick("a", sequence, sequence as i64))
            .unwrap();
    }
    store.close_session("a").unwrap();
    store
        .trim(
            TrimRequest {
                request_id: "trim".into(),
                cutoff_ms: 257,
                expected_cutoff_ms: None,
            },
            &control(),
        )
        .unwrap();
    let baseline = counter(&store);
    let before = store.storage_diagnostics(&control()).unwrap();
    assert!(before.freelist_count > 0);
    assert_eq!(
        before.free_page_bytes,
        before.freelist_count * before.page_size
    );
    let r = store.checkpoint_passive(&control()).unwrap();
    assert_eq!(r.status, CheckpointStatus::Complete);
    let after = store.storage_diagnostics(&control()).unwrap();
    assert_eq!(before.page_count, after.page_count);
    assert_eq!(before.freelist_count, after.freelist_count);
    assert_eq!(before.wal_file_bytes, after.wal_file_bytes);
    assert_eq!(counter(&store), baseline);
    assert_eq!(count(&store, "observations"), 0);
    assert_eq!(count(&store, "commits"), 256);
}

#[test]
fn wal_size_guard_rejects_before_sql_and_diagnostics_still_work() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let directory = TempStore::new();
    let mut store = directory.create();
    let wal = store.database_path.with_extension("sqlite3-wal");
    // Sparse tail on a disposable WAL, restored before any subsequent writes.
    let file = fs::OpenOptions::new().write(true).open(&wal).unwrap();
    let original = file.metadata().unwrap().len();
    file.set_len(MAX_PASSIVE_WAL_BYTES + 1).unwrap();
    store
        .connection
        .authorizer(Some(|c: AuthContext<'_>| {
            if matches!(
                c.action,
                AuthAction::Pragma {
                    pragma_name: "wal_checkpoint",
                    ..
                }
            ) {
                return Authorization::Deny;
            }
            Authorization::Allow
        }))
        .unwrap();
    assert!(matches!(
        store.checkpoint_passive(&control()),
        Err(StoreError::MaintenanceLimit)
    ));
    let d = store.storage_diagnostics(&control()).unwrap();
    assert_eq!(d.wal_file_bytes, Some(MAX_PASSIVE_WAL_BYTES + 1));
    assert!(!store.needs_reopen);
    file.set_len(MAX_PASSIVE_WAL_BYTES).unwrap();
    // At the exact cap SQL is reached (and denied by the injected authorizer).
    assert!(matches!(
        store.checkpoint_passive(&control()),
        Err(StoreError::Sqlite(_))
    ));
    file.set_len(original).unwrap();
}

#[test]
fn entry_limits_cancel_without_checkpoint_and_late_cancel_keeps_success() {
    use crate::store::query::QueryError;
    let directory = TempStore::new();
    let mut store = directory.create();
    let baseline = counter(&store);
    for kind in 0..5 {
        let mut c = control();
        match kind {
            0 => c.cancellation.cancel(),
            1 => c.deadline = std::time::Instant::now(),
            2 => c.limits.max_vm_steps = 1000,
            3 => c.limits.max_decoded_rows = 0,
            _ => c.limits.max_output_bytes = 1,
        }
        assert!(matches!(
            store.checkpoint_passive(&c),
            Err(StoreError::Control(_))
        ));
        assert!(store.connection.is_autocommit());
        assert!(!store.needs_reopen);
    }
    let c = control();
    let report = store
        .checkpoint_with_hook(&c, &mut || {
            c.cancellation.cancel();
            Ok(())
        })
        .unwrap();
    assert_eq!(report.status, CheckpointStatus::Complete);
    assert_eq!(counter(&store), baseline);
    let c = control();
    assert!(matches!(
        store.diagnostics_with_hook(&c, &mut || {
            c.cancellation.cancel();
            Ok(())
        }),
        Err(StoreError::Control(QueryError::Cancelled))
    ));
    assert!(store.connection.is_autocommit());
    assert!(!store.needs_reopen);
    store.storage_diagnostics(&control()).unwrap();
}

#[test]
fn diagnostic_limits_and_unwind_release_the_transaction_and_handler() {
    let directory = TempStore::new();
    let mut store = directory.create();
    for kind in 0..3 {
        let mut c = control();
        match kind {
            0 => c.limits.max_decoded_rows = 1,
            1 => c.limits.max_output_bytes = 1,
            _ => c.limits.max_vm_steps = 3000,
        }
        assert!(matches!(
            store.storage_diagnostics(&c),
            Err(StoreError::Control(_))
        ));
        assert!(store.connection.is_autocommit());
        assert!(!store.needs_reopen);
    }
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = store.diagnostics_with_hook(&control(), &mut || panic!("test unwind"));
    }));
    assert!(panic.is_err());
    assert!(store.connection.is_autocommit());
    assert!(!store.needs_reopen);
    store.storage_diagnostics(&control()).unwrap();
    store.checkpoint_passive(&control()).unwrap();
}

#[test]
fn sql_failure_requires_reopen_and_does_not_change_logical_commits() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let directory = TempStore::new();
    let mut store = directory.create();
    let baseline = counter(&store);
    store
        .connection
        .authorizer(Some(|c: AuthContext<'_>| {
            if matches!(
                c.action,
                AuthAction::Pragma {
                    pragma_name: "wal_checkpoint",
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
        store.checkpoint_passive(&control()),
        Err(StoreError::Sqlite(_))
    ));
    assert_eq!(counter(&store), baseline);
    assert!(store.needs_reopen);
    assert!(matches!(
        store.storage_diagnostics(&control()),
        Err(StoreError::NeedsReopen)
    ));
    drop(store);
    let mut store = directory.open();
    store.storage_diagnostics(&control()).unwrap();
    store.checkpoint_passive(&control()).unwrap();
}

#[test]
fn panic_with_failed_cleanup_poison_is_shared_with_retention() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
    let directory = TempStore::new();
    let mut store = directory.create();
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
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = store.diagnostics_with_hook(&control(), &mut || panic!("test unwind"));
    }));
    assert!(panic.is_err());
    assert!(store.needs_reopen);
    assert!(matches!(
        store.checkpoint_passive(&control()),
        Err(StoreError::NeedsReopen)
    ));
    drop(store);
    let mut store = directory.open();
    store.storage_diagnostics(&control()).unwrap();
}

#[test]
fn checkpoint_result_distinguishes_busy_incomplete_no_wal_and_invalid_counts() {
    // SQLite's exceptional counter combinations must never become false completion.
    assert_eq!(
        checkpoint_report(0, 100, 50).unwrap().status,
        CheckpointStatus::Incomplete
    );
    assert_eq!(
        checkpoint_report(1, 100, 50).unwrap().status,
        CheckpointStatus::Busy
    );
    assert_eq!(checkpoint_report(1, -1, -1).unwrap().log_frames, None);
    assert_eq!(
        checkpoint_report(0, -1, -1).unwrap().status,
        CheckpointStatus::NoWal
    );
    for (busy, log, done) in [(2, 0, 0), (0, -1, 0), (0, 1, -1), (0, 1, 2), (0, -2, -2)] {
        assert!(matches!(
            checkpoint_report(busy, log, done),
            Err(StoreError::CorruptData)
        ));
    }
}

#[test]
fn non_wal_database_reports_no_wal_without_changing_journal_mode() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store
        .connection
        .execute_batch("PRAGMA journal_mode=DELETE")
        .unwrap();
    let report = store.checkpoint_passive(&control()).unwrap();
    assert_eq!(report.status, CheckpointStatus::NoWal);
    assert_eq!(
        (report.log_frames, report.checkpointed_frames),
        (None, None)
    );
    let mode: String = store
        .connection
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "delete");
    assert_eq!(
        store
            .storage_diagnostics(&control())
            .unwrap()
            .wal_file_bytes,
        None
    );
}

#[cfg(unix)]
#[test]
fn filesystem_sampling_rejects_symlinks_instead_of_following_them() {
    use std::os::unix::fs::symlink;
    let directory = TempStore::new();
    let mut store = directory.create();
    let wal = store.database_path.with_extension("sqlite3-wal");
    let moved = directory.0.join("saved-wal");
    fs::rename(&wal, &moved).unwrap();
    symlink(&moved, &wal).unwrap();
    assert!(matches!(
        store.storage_diagnostics(&control()),
        Err(StoreError::Invalid(_))
    ));
    assert!(matches!(
        store.checkpoint_passive(&control()),
        Err(StoreError::Invalid(_))
    ));
    fs::remove_file(&wal).unwrap();
    fs::rename(moved, wal).unwrap();
}

#[cfg(unix)]
#[test]
fn main_file_is_required_before_any_maintenance_sql() {
    use rusqlite::hooks::{AuthContext, Authorization};
    use std::os::unix::fs::symlink;
    for checkpoint in [false, true] {
        for linked in [false, true] {
            let directory = TempStore::new();
            let mut store = directory.create();
            let main = store.database_path.clone();
            let saved = directory.0.join("saved-main");
            fs::rename(&main, &saved).unwrap();
            if linked {
                symlink(&saved, &main).unwrap();
            }
            store
                .connection
                .authorizer(Some(|_: AuthContext<'_>| Authorization::Deny))
                .unwrap();
            let result = if checkpoint {
                store.checkpoint_passive(&control()).map(|_| ())
            } else {
                store.storage_diagnostics(&control()).map(|_| ())
            };
            assert!(
                matches!(result, Err(StoreError::Invalid(_))),
                "checkpoint={checkpoint}, linked={linked}: {result:?}"
            );
            if linked {
                fs::remove_file(&main).unwrap();
            }
            fs::rename(saved, main).unwrap();
        }
    }
}

#[test]
fn unexpected_transaction_disables_maintenance_until_reopen() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.connection.execute_batch("BEGIN DEFERRED").unwrap();
    assert!(matches!(
        store.checkpoint_passive(&control()),
        Err(StoreError::NeedsReopen)
    ));
    assert!(matches!(
        store.storage_diagnostics(&control()),
        Err(StoreError::NeedsReopen)
    ));
    drop(store);
    let mut store = directory.open();
    store.checkpoint_passive(&control()).unwrap();
}

#[test]
fn process_exit_around_checkpoint_preserves_trim_receipts_and_history() {
    use crate::store::{query::QueryControl, retention::TrimRequest};
    use serde_json::json;
    for phase in ["before", "after"] {
        let directory = TempStore::new();
        let mut store = directory.create();
        store.begin_session(spec("a")).unwrap();
        let first = tick("a", 1, 0);
        let receipt = store.append_tick(first.clone()).unwrap();
        store.append_tick(tick("a", 2, 10)).unwrap();
        store.close_session("a").unwrap();
        let request = TrimRequest {
            request_id: "trim".into(),
            cutoff_ms: 1,
            expected_cutoff_ms: None,
        };
        let trimmed = store.trim(request.clone(), &control()).unwrap();
        let baseline = counter(&store);
        drop(store);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store::maintenance::tests::maintenance_process_worker",
                "--nocapture",
            ])
            .env("SCADA_MAINTENANCE_TEST_PATH", &directory.0)
            .env("SCADA_MAINTENANCE_TEST_PHASE", phase)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(83));
        let mut store = directory.open();
        assert_eq!(counter(&store), baseline);
        assert_eq!(store.append_tick(first).unwrap(), receipt);
        assert_eq!(store.trim(request, &control()).unwrap(), trimmed);
        let mut reader = store.reader().unwrap();
        let q = json!({"version":1,"kind":"query","requestId":"q","seriesIds":["number"],"fromMs":0,"toMs":20,"mode":"raw","maxPointsPerSeries":10});
        let result = reader
            .query_raw(
                &q,
                &QueryControl::with_timeout(Duration::from_secs(10)).unwrap(),
            )
            .unwrap();
        assert_eq!(result["series"][0]["raw"].as_array().unwrap().len(), 1);
        assert_eq!(
            result["series"][0]["coverage"][0],
            json!({"fromMs":0,"toMs":1,"reason":"expired"})
        );
        assert_eq!(
            store.checkpoint_passive(&control()).unwrap().status,
            CheckpointStatus::Complete
        );
    }
}

#[test]
fn maintenance_process_worker() {
    let Ok(path) = std::env::var("SCADA_MAINTENANCE_TEST_PATH") else {
        return;
    };
    let phase = std::env::var("SCADA_MAINTENANCE_TEST_PHASE").unwrap();
    let mut store = reopen_unowned(path, &identity()).unwrap();
    if phase == "before" {
        std::process::exit(83);
    }
    store
        .checkpoint_with_hook(&control(), &mut || std::process::exit(83))
        .unwrap();
    panic!("checkpoint callback was not reached");
}
