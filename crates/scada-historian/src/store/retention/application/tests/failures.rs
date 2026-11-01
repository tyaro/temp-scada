use super::*;
use crate::store::query::QueryError;

#[test]
fn capacity_failure_rolls_back_definition_receipt_and_pointer_then_same_request_retries_after_reopen(
) {
    let directory = TempStore::new();
    let mut store = directory.create();
    let first = request(&mut store, "first", policy(1, 2000));
    store.apply_retention_policy(&first, &control()).unwrap();
    let next = request(&mut store, "next", policy(2, 1000));
    store.connection.execute_batch("CREATE TABLE policy_pressure(value BLOB); CREATE TEMP TRIGGER policy_full AFTER INSERT ON retention_policy_applications BEGIN INSERT INTO policy_pressure VALUES(zeroblob(1048576)); END;").unwrap();
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
    let error = store.apply_retention_policy(&next, &control()).unwrap_err();
    assert!(
        matches!(error,StoreError::Sqlite(ref e) if e.sqlite_error_code()==Some(rusqlite::ErrorCode::DiskFull))
    );
    assert!(store.needs_reopen);
    assert!(store.connection.is_autocommit());
    assert_eq!(counter(&store), before);
    let (definitions,operations,pointer):(i64,i64,i64)=store.connection.query_row("SELECT (SELECT count(*) FROM retention_policy_definitions),(SELECT count(*) FROM retention_policy_applications),applied_revision FROM retention_policy_state",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
    assert_eq!((definitions, operations, pointer), (1, 1, 1));
    store
        .connection
        .pragma_update(None, "max_page_count", maximum)
        .unwrap();
    drop(store);
    let mut store = directory.open();
    assert_eq!(
        store
            .apply_retention_policy(&next, &control())
            .unwrap()
            .applied_revision,
        2
    );
}

#[test]
fn controls_and_faults_before_commit_preserve_old_applied_and_late_cancel_keeps_receipt() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let first = request(&mut store, "first", policy(1, 2000));
    let old = store.apply_retention_policy(&first, &control()).unwrap();
    let next = request(&mut store, "next", policy(2, 1000));
    let before = counter(&store);
    for kind in 0..5 {
        let mut c = control();
        match kind {
            0 => c.cancellation.cancel(),
            1 => c.deadline = std::time::Instant::now(),
            2 => c.limits.max_vm_steps = 1000,
            3 => c.limits.max_decoded_rows = 1,
            _ => c.limits.max_output_bytes = 1,
        };
        assert!(matches!(
            store.apply_retention_policy(&next, &c),
            Err(StoreError::Control(_))
        ));
        assert_eq!(counter(&store), before);
    }
    for at in [
        Boundary::Metadata,
        Boundary::Observation,
        Boundary::Watermark,
        Boundary::BeforeCommit,
    ] {
        let c = control();
        assert!(matches!(
            store.apply_policy_with_hook(&next, &c, &mut |point| {
                if point == at {
                    c.cancellation.cancel();
                }
                Ok(())
            }),
            Err(StoreError::Control(QueryError::Cancelled))
        ));
        assert_eq!(counter(&store), before);
        assert!(store.connection.is_autocommit());
        assert_eq!(
            store.apply_retention_policy(&first, &control()).unwrap(),
            old
        );
    }
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = store.apply_policy_with_hook(&next, &control(), &mut |at| {
            if at == Boundary::Watermark {
                panic!("application fault unwind");
            }
            Ok(())
        });
    }));
    assert!(panic.is_err());
    assert!(!store.needs_reopen);
    assert_eq!(counter(&store), before);
    let c = control();
    let receipt = store
        .apply_policy_with_hook(&next, &c, &mut |at| {
            if at == Boundary::AfterCommit {
                c.cancellation.cancel();
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(receipt.applied_revision, 2);
    assert_eq!(
        store.apply_retention_policy(&next, &control()).unwrap(),
        receipt
    );
}

#[test]
fn invalid_definition_requests_and_stale_values_do_not_change_applied() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let base = request(&mut store, "r", policy(1, 1000));
    for kind in 0..6 {
        let mut r = base.clone();
        match kind {
            0 => r.request_id = "bad id".into(),
            1 => r.proposed_policy.revision = 0,
            2 => r.proposed_policy.cutoff_rule = CutoffRule::ExplicitCandidate,
            3 => r.reference_wall_ms = i64::MAX,
            4 => r.expected_applied_revision = Some(0),
            _ => r.expected_preview_snapshot_commit = u64::MAX,
        };
        assert!(matches!(
            store.apply_retention_policy(&r, &control()),
            Err(StoreError::Invalid(_))
        ));
        assert_eq!(counter(&store), 0);
    }
}

#[test]
fn corrupted_pointer_definition_request_receipt_and_job_binding_are_not_unapplied_defaults() {
    for corruption in [
        "DELETE FROM retention_policy_state",
        "UPDATE retention_policy_state SET applied_revision=NULL",
        "UPDATE retention_policy_state SET applied_revision=1",
        "UPDATE retention_policy_definitions SET created_commit=created_commit+100",
        "UPDATE retention_policy_definitions SET payload_json='{}'",
        "UPDATE retention_policy_applications SET payload_json='{}' WHERE applied_revision=2",
        "UPDATE retention_policy_applications SET receipt_json=json_set(receipt_json,'$.preview.proposed.targets.observations',9) WHERE applied_revision=2",
        "UPDATE retention_policy_applications SET receipt_json=json_set(receipt_json,'$.preview.referenceWallMs',42) WHERE applied_revision=2",
        "UPDATE retention_policy_applications SET receipt_json=json_set(receipt_json,'$.preview.comparison.policy.revision',999) WHERE applied_revision=2",
        "UPDATE retention_policy_applications SET receipt_json=json_set(receipt_json,'$.preview.recovery.activeJob',json('{\"status\":{\"jobId\":\"fake\",\"cutoffMs\":2000,\"state\":\"active\",\"nextStep\":1,\"deletedTicks\":0,\"deletedObservations\":0,\"beginCommit\":1,\"completionCommit\":null,\"policyAppliedRevision\":null},\"lastStep\":null}')) WHERE applied_revision=2",
    ] {
        let directory=TempStore::new();let mut store=directory.create();
        let first=request(&mut store,"first",policy(1,2000));store.apply_retention_policy(&first,&control()).unwrap();
        let next=request(&mut store,"next",policy(2,1000));store.apply_retention_policy(&next,&control()).unwrap();
        store.connection.execute_batch(corruption).unwrap();
        assert!(matches!(store.recovery_state(&control()),Err(StoreError::CorruptData)),"{corruption}");
        assert!(store.connection.is_autocommit());assert!(!store.needs_reopen);
    }
}

#[test]
fn format_four_is_rejected_without_rewriting_or_migrating() {
    let directory = TempStore::new();
    drop(directory.create());
    let path = directory.0.join("store.sqlite3");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA user_version=4").unwrap();
    drop(db);
    let bytes = std::fs::read(&path).unwrap();
    assert!(matches!(
        reopen_unowned(&directory.0, &identity()),
        Err(StoreError::UnsupportedStore)
    ));
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[test]
fn bound_job_origin_cannot_be_cleared_or_made_to_reference_another_application() {
    use crate::store::retention::jobs::JobRequest;
    for corruption in [
        "UPDATE retention_jobs SET policy_applied_revision=NULL",
        "PRAGMA foreign_keys=OFF; UPDATE retention_jobs SET policy_applied_revision=2",
        "UPDATE retention_jobs SET payload_json=json_set(payload_json,'$.policyAppliedRevision',NULL)",
        "UPDATE retention_jobs SET begin_commit=1",
    ] {
        let directory=TempStore::new();let mut store=directory.create();
        let r=request(&mut store,"apply",policy(1,1000));store.apply_retention_policy(&r,&control()).unwrap();
        let applied=store.recovery_state(&control()).unwrap().applied_retention_policy.unwrap();
        store.begin_retention_job_bound(JobRequest{job_id:"bound".into(),cutoff_ms:2000,expected_cutoff_ms:None},&applied,&control()).unwrap();
        store.connection.execute_batch(corruption).unwrap();
        assert!(matches!(store.recovery_state(&control()),Err(StoreError::CorruptData)),"{corruption}");
    }
}

#[test]
fn current_policy_reads_only_previous_metadata_and_does_not_recursively_decode_receipts() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let first = request(&mut store, "first", policy(1, 2000));
    store.apply_retention_policy(&first, &control()).unwrap();
    let next = request(&mut store, "next", policy(2, 1000));
    store.apply_retention_policy(&next, &control()).unwrap();
    store
        .connection
        .execute(
            "UPDATE retention_policy_applications SET receipt_json='{' WHERE applied_revision=1",
            [],
        )
        .unwrap();
    assert_eq!(
        store
            .recovery_state(&control())
            .unwrap()
            .applied_retention_policy
            .unwrap()
            .applied_revision,
        2
    );
    assert!(matches!(
        store.apply_retention_policy(&first, &control()),
        Err(StoreError::CorruptData)
    ));
}

#[test]
fn sql_failure_or_failed_rollback_poison_the_writer_without_publishing_a_partial_policy() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
    for rollback in [false, true] {
        let directory = TempStore::new();
        let mut store = directory.create();
        let r = request(&mut store, "apply", policy(1, 1000));
        store
            .connection
            .authorizer(Some(move |c: AuthContext<'_>| {
                if (!rollback
                    && matches!(
                        c.action,
                        AuthAction::Insert {
                            table_name: "retention_policy_applications"
                        }
                    ))
                    || (rollback
                        && matches!(
                            c.action,
                            AuthAction::Transaction {
                                operation: TransactionOperation::Rollback
                            }
                        ))
                {
                    Authorization::Deny
                } else {
                    Authorization::Allow
                }
            }))
            .unwrap();
        if rollback {
            let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = store.apply_policy_with_hook(&r, &control(), &mut |at| {
                    if at == Boundary::Watermark {
                        panic!("application rollback fault");
                    }
                    Ok(())
                });
            }));
            assert!(panic.is_err());
        } else {
            assert!(matches!(
                store.apply_retention_policy(&r, &control()),
                Err(StoreError::Sqlite(_))
            ));
        }
        assert!(store.needs_reopen);
        assert!(matches!(
            store.recovery_state(&control()),
            Err(StoreError::NeedsReopen)
        ));
        assert!(matches!(
            SqliteStore::open_existing(&directory.0, &identity()),
            Err(StoreError::Busy)
        ));
        drop(store);
        let mut store = directory.open();
        assert!(store
            .recovery_state(&control())
            .unwrap()
            .applied_retention_policy
            .is_none());
        assert_eq!(
            store
                .apply_retention_policy(&r, &control())
                .unwrap()
                .applied_revision,
            1
        );
    }
}

#[test]
fn process_exit_before_or_after_commit_preserves_policy_atomicity_and_exact_replay() {
    for at in [
        Boundary::Metadata,
        Boundary::Observation,
        Boundary::Watermark,
        Boundary::BeforeCommit,
        Boundary::AfterCommit,
    ] {
        let directory = TempStore::new();
        let mut store = directory.create();
        let first = request(&mut store, "first", policy(1, 2000));
        store.apply_retention_policy(&first, &control()).unwrap();
        let next = request(&mut store, "next", policy(2, 1000));
        drop(store);
        let exit = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store::retention::application::tests::failures::application_process_worker",
                "--nocapture",
            ])
            .env("SCADA_POLICY_TEST_PATH", &directory.0)
            .env(
                "SCADA_POLICY_TEST_REQUEST",
                serde_json::to_string(&next).unwrap(),
            )
            .env("SCADA_POLICY_TEST_BOUNDARY", format!("{at:?}"))
            .status()
            .unwrap();
        assert_eq!(exit.code(), Some(91));
        let mut store = directory.open();
        let revision = store
            .recovery_state(&control())
            .unwrap()
            .applied_retention_policy
            .unwrap()
            .applied_revision;
        assert_eq!(revision, if at == Boundary::AfterCommit { 2 } else { 1 });
        let result = store.apply_retention_policy(&next, &control()).unwrap();
        assert_eq!(result.applied_revision, 2);
        let before = counter(&store);
        assert_eq!(
            store.apply_retention_policy(&next, &control()).unwrap(),
            result
        );
        assert_eq!(counter(&store), before);
    }
}

#[test]
fn application_process_worker() {
    let Ok(path) = std::env::var("SCADA_POLICY_TEST_PATH") else {
        return;
    };
    let request: PolicyApplyRequest =
        serde_json::from_str(&std::env::var("SCADA_POLICY_TEST_REQUEST").unwrap()).unwrap();
    let target = std::env::var("SCADA_POLICY_TEST_BOUNDARY").unwrap();
    let mut store = reopen_unowned(path, &identity()).unwrap();
    store
        .apply_policy_with_hook(&request, &control(), &mut |at| {
            if format!("{at:?}") == target {
                std::process::exit(91);
            }
            Ok(())
        })
        .unwrap();
    panic!("application boundary was not reached");
}
