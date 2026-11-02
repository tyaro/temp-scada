use super::*;
#[test]
fn corrupted_heads_payloads_hashes_and_reservations_are_never_unapplied_defaults() {
    for corruption in [
        "DELETE FROM recording_mapping_state",
        "DELETE FROM recording_plan_state",
        "UPDATE recording_mapping_state SET mapping_revision=NULL,revision_count=0",
        "UPDATE recording_plan_state SET ledger_plan_id=NULL,applied_revision=NULL,application_count=0,definition_count=0",
        "UPDATE recording_mapping_revisions SET request_json='{}'",
        "UPDATE recording_mapping_revisions SET mapping_hash=printf('%064d',0)",
        "UPDATE recording_desired_definitions SET desired_hash=printf('%064d',0)",
        "PRAGMA foreign_keys=OFF; DELETE FROM recording_desired_definitions",
        "PRAGMA foreign_keys=OFF; DELETE FROM retention_policy_definitions",
        "UPDATE recording_desired_definitions SET created_commit=created_commit+1",
        "UPDATE recording_plan_applications SET receipt_json='{}'",
        "UPDATE recording_plan_applications SET resolved_hash=printf('%064d',0)",
        "UPDATE recording_segment_reservations SET descriptor_hash=printf('%064d',0)",
        "UPDATE recording_segment_reservations SET descriptor_json='{}'",
        "DELETE FROM recording_application_members",
        "UPDATE retention_policy_applications SET receipt_json='{}'",
    ] {
        let (_directory,mut store)=enabled_store();
        store.apply_recording_plan(&apply("apply",None,true),&control()).unwrap();
        store.connection.execute_batch(corruption).unwrap();
        let before=counter(&store);
        assert!(matches!(store.recording_plan_state(&control()),Err(StoreError::CorruptData)),"{corruption}");
        assert_eq!(counter(&store),before);
        assert!(store.connection.is_autocommit());
        assert!(!store.needs_reopen);
    }
}
#[test]
fn sqlite_full_rolls_back_every_table_and_requires_reopen() {
    let (directory, mut store) = enabled_store();
    let a = apply("apply", None, true);
    store.connection.execute_batch("CREATE TABLE recording_pressure(value BLOB); CREATE TEMP TRIGGER recording_full AFTER INSERT ON recording_application_members BEGIN INSERT INTO recording_pressure VALUES(zeroblob(1048576)); END;").unwrap();
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
    let error = store.apply_recording_plan(&a, &control()).unwrap_err();
    assert!(
        matches!(error,StoreError::Sqlite(ref e) if e.sqlite_error_code()==Some(rusqlite::ErrorCode::DiskFull))
    );
    assert!(store.needs_reopen);
    assert!(store.connection.is_autocommit());
    assert_eq!(counter(&store), before);
    for table in [
        "recording_desired_definitions",
        "recording_plan_applications",
        "recording_series_reservations",
        "recording_segment_reservations",
        "recording_application_members",
    ] {
        let n: i64 = store
            .connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "{table}");
    }
    store
        .connection
        .pragma_update(None, "max_page_count", maximum)
        .unwrap();
    drop(store);
    let mut store = directory.open();
    assert_eq!(
        store
            .apply_recording_plan(&a, &control())
            .unwrap()
            .applied_revision,
        1
    );
}
#[test]
fn cancellation_and_panic_clean_up_but_failed_rollback_poisons_writer() {
    use crate::store::query::QueryError;
    for boundary in [
        Boundary::Metadata,
        Boundary::Observation,
        Boundary::Watermark,
        Boundary::BeforeCommit,
    ] {
        let (_directory, mut store) = enabled_store();
        let before = counter(&store);
        let c = control();
        assert!(matches!(
            store.apply_recording_plan_with_hook(&apply("apply", None, true), &c, &mut |at| {
                if at == boundary {
                    c.cancellation.cancel();
                }
                Ok(())
            }),
            Err(StoreError::Control(QueryError::Cancelled))
        ));
        assert_eq!(counter(&store), before);
        assert!(store.connection.is_autocommit());
        assert!(!store.needs_reopen);
    }
    for failed_cleanup in [false, true] {
        use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
        let (directory, mut store) = enabled_store();
        let before = counter(&store);
        if failed_cleanup {
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
        }
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = store.apply_recording_plan_with_hook(
                &apply("apply", None, true),
                &control(),
                &mut |at| {
                    if at == Boundary::Watermark {
                        panic!("injected recording apply unwind");
                    }
                    Ok(())
                },
            );
        }))
        .is_err());
        assert_eq!(store.needs_reopen, failed_cleanup);
        if failed_cleanup {
            assert!(matches!(
                store.recording_plan_state(&control()),
                Err(StoreError::NeedsReopen)
            ));
        } else {
            assert_eq!(counter(&store), before);
            assert!(store.connection.is_autocommit());
        }
        drop(store);
        let mut store = directory.open();
        assert!(store
            .recording_plan_state(&control())
            .unwrap()
            .applied
            .is_none());
        store
            .apply_recording_plan(&apply("apply", None, true), &control())
            .unwrap();
    }
}
#[test]
fn process_exit_at_each_commit_boundary_keeps_atomicity_and_replay() {
    for at in [
        Boundary::Metadata,
        Boundary::Observation,
        Boundary::Watermark,
        Boundary::BeforeCommit,
        Boundary::AfterCommit,
    ] {
        let (directory, mut store) = enabled_store();
        let before = counter(&store);
        drop(store);
        let exit = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store::recording_plan::tests::failures::recording_process_worker",
                "--nocapture",
            ])
            .env("SCADA_RECORDING_TEST_PATH", &directory.0)
            .env("SCADA_RECORDING_TEST_BOUNDARY", format!("{at:?}"))
            .status()
            .unwrap();
        assert_eq!(exit.code(), Some(91));
        store = directory.open();
        let state = store.recording_plan_state(&control()).unwrap();
        assert_eq!(state.applied.is_some(), at == Boundary::AfterCommit);
        assert_eq!(
            counter(&store),
            before + i64::from(at == Boundary::AfterCommit)
        );
        let receipt = store
            .apply_recording_plan(&apply("apply", None, true), &control())
            .unwrap();
        assert_eq!(receipt.applied_revision, 1);
        assert_eq!(
            store
                .apply_recording_plan(&apply("apply", None, true), &control())
                .unwrap(),
            receipt
        );
    }
}
#[test]
fn recording_process_worker() {
    let Ok(path) = std::env::var("SCADA_RECORDING_TEST_PATH") else {
        return;
    };
    let target = std::env::var("SCADA_RECORDING_TEST_BOUNDARY").unwrap();
    let mut store = reopen_unowned(path, &identity()).unwrap();
    store
        .apply_recording_plan_with_hook(&apply("apply", None, true), &control(), &mut |at| {
            if format!("{at:?}") == target {
                std::process::exit(91);
            }
            Ok(())
        })
        .unwrap();
    panic!("recording apply boundary was not reached");
}
#[test]
fn format_five_six_and_unknown_formats_are_rejected_without_migration() {
    for version in [5, 6, 8] {
        let directory = TempStore::new();
        drop(directory.create());
        let path = directory.0.join("store.sqlite3");
        let db = Connection::open(&path).unwrap();
        db.pragma_update(None, "user_version", version).unwrap();
        drop(db);
        let bytes = std::fs::read(&path).unwrap();
        assert!(matches!(
            reopen_unowned(&directory.0, &identity()),
            Err(StoreError::UnsupportedStore)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn mapping_receipts_also_require_valid_singleton_heads() {
    for corruption in [
        "DELETE FROM recording_mapping_state",
        "UPDATE recording_mapping_state SET mapping_revision=NULL,revision_count=0",
        "DELETE FROM recording_plan_state",
    ] {
        let (_directory, mut store) = enabled_store();
        store.connection.execute_batch(corruption).unwrap();
        assert!(
            matches!(
                store.recording_mapping_receipt("map", &control()),
                Err(StoreError::CorruptData)
            ),
            "{corruption}"
        );
        assert!(
            matches!(
                store.register_recording_mapping(&register("map", None), &control()),
                Err(StoreError::CorruptData)
            ),
            "{corruption}"
        );
    }
}
#[test]
fn first_use_must_be_enabled_and_contain_the_actual_reserved_descriptor() {
    for disabled in [false, true] {
        let (_directory, mut store) = enabled_store();
        let first = apply("first", None, !disabled);
        store.apply_recording_plan(&first, &control()).unwrap();
        let mut next = apply("next", Some(1), true);
        next.desired["revision"] = json!(2);
        store.apply_recording_plan(&next, &control()).unwrap();
        if disabled {
            store.connection.execute_batch("UPDATE recording_series_reservations SET first_revision=1; UPDATE recording_segment_reservations SET first_revision=1; INSERT INTO recording_application_members SELECT 1,series_id,segment_id FROM recording_application_members WHERE applied_revision=2;").unwrap();
        } else {
            // The current read validates first-use evidence without decoding old receipt bodies.
            store.connection.execute("UPDATE recording_plan_applications SET receipt_json='{' WHERE applied_revision=1",[]).unwrap();
            assert!(store.recording_plan_state(&control()).is_ok());
            assert!(matches!(
                store.recording_plan_receipt("first", &control()),
                Err(StoreError::CorruptData)
            ));
            // Mutating the referenced mapping invalidates the first-use proof.
            store
                .connection
                .execute(
                    "UPDATE recording_mapping_revisions SET request_json='{}'",
                    [],
                )
                .unwrap();
        }
        assert!(matches!(
            store.recording_plan_state(&control()),
            Err(StoreError::CorruptData)
        ));
    }
}
