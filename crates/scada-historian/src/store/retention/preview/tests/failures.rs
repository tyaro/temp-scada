use super::*;
use crate::store::query::QueryError;

#[test]
fn invalid_policy_reference_or_underflow_never_returns_partial_counts() {
    let directory = TempStore::new();
    let mut store = directory.create();
    for kind in 0..6 {
        let mut r = request();
        match kind {
            0 => r.proposed_policy.revision = 0,
            1 => r.proposed_policy.cutoff_rule = CutoffRule::ExplicitCandidate,
            2 => r.proposed_policy.cutoff_rule = CutoffRule::Elapsed { retain_for_ms: 0 },
            3 => r.reference_wall_ms = i64::MAX,
            4 => r.reference_wall_ms = -(MAX_SAFE as i64),
            _ => r.comparison_policy.as_mut().unwrap().cutoff_rule = CutoffRule::ExplicitCandidate,
        }
        assert!(matches!(
            store.preview_retention_change(&r, &control()),
            Err(StoreError::Invalid(_))
        ));
        assert_eq!(counter(&store), 0);
        assert!(store.connection.is_autocommit());
        assert!(!store.needs_reopen);
    }
}

#[test]
fn preview_is_read_only_even_with_all_modifying_sql_denied() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let (_directory, mut store) = fixture();
    let before = counter(&store);
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
    let result = store
        .preview_retention_change(&request(), &control())
        .unwrap();
    assert_eq!(result.proposed.targets, expected(5, 9, 999, 1999));
    assert_eq!(counter(&store), before);
    assert_eq!(count(&store, "observations"), 13);
    assert!(!store.needs_reopen);
}

#[test]
fn aggregates_and_recovery_share_the_snapshot_pinned_before_an_external_commit() {
    let (_directory, mut store) = fixture();
    let mut other = Connection::open(&store.database_path).unwrap();
    let payload = serde_json::to_string(&TrimRequest {
        request_id: "external".into(),
        cutoff_ms: 1000,
        expected_cutoff_ms: None,
    })
    .unwrap();
    let before = counter(&store);
    let old = store.preview_with_hook(&request(),&control(),&mut || {
        let tx = other.transaction()?;
        tx.execute("UPDATE store_meta SET last_commit=last_commit+1",[])?;
        tx.execute("INSERT INTO retention_operations VALUES('external',?1,1000,(SELECT last_commit FROM store_meta),1,2)",[&payload])?;
        tx.execute("INSERT INTO expired_samples SELECT series_id,sample_time_ms,'external',count(*) FROM observations WHERE sample_time_ms<1000 GROUP BY series_id,sample_time_ms",[])?;
        tx.execute("DELETE FROM observations WHERE sample_time_ms<1000",[])?;
        tx.execute("UPDATE retention_state SET cutoff_ms=1000,revision_commit=(SELECT last_commit FROM store_meta)",[])?;
        tx.commit()?; Ok(())
    }).unwrap();
    assert_eq!(old.recovery.snapshot_commit, before as u64);
    assert_eq!(old.recovery.retention_fence.cutoff_ms, None);
    assert_eq!(old.proposed.targets, expected(5, 9, 999, 1999));
    let fresh = store
        .preview_retention_change(&request(), &control())
        .unwrap();
    assert_eq!(fresh.recovery.snapshot_commit, before as u64 + 1);
    assert_eq!(fresh.recovery.retention_fence.cutoff_ms, Some(1000));
    assert_eq!(fresh.proposed.targets, expected(4, 7, 1000, 1999));
    assert_eq!(fresh.comparison.unwrap().targets, TargetCounts::default());
}

#[test]
fn corrupt_target_members_timestamps_commits_and_references_fail_the_whole_preview() {
    for corruption in [
        "DELETE FROM observations WHERE session_id='a' AND sequence=2 AND series_id='bool'",
        "UPDATE observations SET sample_time_ms=3000 WHERE session_id='a' AND sequence=2 AND series_id='bool'",
        "UPDATE observations SET clock_epoch='other' WHERE session_id='a' AND sequence=2 AND series_id='bool'",
        "UPDATE observations SET clock_epoch='bad clock' WHERE session_id='a' AND sequence=2",
        "UPDATE observations SET clock_epoch='clock-a'||char(0)||'bad' WHERE session_id='a' AND sequence=2",
        "PRAGMA foreign_keys=OFF; UPDATE observations SET segment_id='missing' WHERE session_id='a' AND sequence=2",
        "PRAGMA foreign_keys=OFF; UPDATE observations SET commit_version=999999 WHERE session_id='a' AND sequence=2",
        "PRAGMA foreign_keys=OFF; DELETE FROM commits WHERE session_id='a' AND sequence=2",
        "PRAGMA foreign_keys=OFF; DELETE FROM session_members WHERE session_id='a' AND series_id='bool'",
        "PRAGMA foreign_keys=OFF; DELETE FROM segments WHERE series_id='bool'",
        "PRAGMA foreign_keys=OFF; DELETE FROM series WHERE series_id='bool'",
        "UPDATE sessions SET last_sequence=1 WHERE session_id='a'",
        "UPDATE sessions SET end_commit=begin_commit+1 WHERE session_id='a'",
    ] {
        let (_directory, mut store) = fixture();
        store.connection.execute_batch(corruption).unwrap();
        let before = counter(&store);
        assert!(matches!(store.preview_retention_change(&request(),&control()),Err(StoreError::CorruptData)),"{corruption}");
        assert_eq!(counter(&store),before);
        assert!(store.connection.is_autocommit());
        assert!(!store.needs_reopen);
    }
}

#[test]
fn structural_preview_is_not_a_full_json_audit_or_an_execution_guarantee() {
    let (_directory, mut store) = fixture();
    store.connection.execute_batch("UPDATE commits SET payload_json='not-json' WHERE session_id='a' AND sequence=2; UPDATE sessions SET spec_json='not-json' WHERE session_id='a'; UPDATE observations SET clock_epoch='bad clock' WHERE session_id='a' AND sequence=6").unwrap();
    // The terminal session JSON/receipt and rows beyond both cutoffs are outside
    // this structural preview. The actual step still performs its full checks.
    assert_eq!(
        store
            .preview_retention_change(&request(), &control())
            .unwrap()
            .proposed
            .targets,
        expected(5, 9, 999, 1999)
    );
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
    assert!(matches!(
        store.step_retention_job(
            JobStepRequest {
                job_id: "job".into(),
                step: 1,
                max_ticks: 4
            },
            &control()
        ),
        Err(StoreError::CorruptData)
    ));
}

#[test]
fn large_input_is_sql_aggregated_and_low_work_budget_returns_no_partial_report() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("dense")).unwrap();
    for n in 1..=1025 {
        store.append_tick(tick("dense", n, 1000)).unwrap();
    }
    store.close_session("dense").unwrap();
    let before = counter(&store);
    let mut c = control();
    c.limits.max_vm_steps = 50_000;
    assert!(matches!(
        store.preview_retention_change(&request(), &c),
        Err(StoreError::Control(QueryError::WorkLimit))
    ));
    assert!(store.connection.is_autocommit());
    assert!(!store.needs_reopen);
    let mut c = control();
    c.limits.max_decoded_rows = 32;
    let report = store.preview_retention_change(&request(), &c).unwrap();
    assert_eq!(report.proposed.targets, expected(1025, 2050, 1000, 1000));
    assert_eq!(counter(&store), before);
}

#[test]
fn cancellation_limits_and_panic_cleanup_retain_read_only_state_and_handlers_are_removed() {
    let (_directory, mut store) = fixture();
    let before = counter(&store);
    for kind in 0..5 {
        let mut c = control();
        match kind {
            0 => c.cancellation.cancel(),
            1 => c.deadline = std::time::Instant::now(),
            2 => c.limits.max_decoded_rows = 1,
            3 => c.limits.max_output_bytes = 1,
            _ => c.limits.max_vm_steps = 0,
        }
        assert!(matches!(
            store.preview_retention_change(&request(), &c),
            Err(StoreError::Control(_))
        ));
        assert!(store.connection.is_autocommit());
    }
    let c = control();
    assert!(matches!(
        store.preview_with_hook(&request(), &c, &mut || {
            c.cancellation.cancel();
            Ok(())
        }),
        Err(StoreError::Control(QueryError::Cancelled))
    ));
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = store.preview_with_hook(&request(), &control(), &mut || {
            panic!("preview fault unwind")
        });
    }));
    assert!(panic.is_err());
    assert!(store.connection.is_autocommit());
    assert!(!store.needs_reopen);
    assert_eq!(counter(&store), before);
    assert!(store
        .preview_retention_change(&request(), &control())
        .is_ok());
}

#[test]
fn read_failure_and_failed_cleanup_keep_the_existing_needs_reopen_contract() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
    for deny_rollback in [false, true] {
        let (directory, mut store) = fixture();
        store
            .connection
            .authorizer(Some(move |c: AuthContext<'_>| {
                if (!deny_rollback
                    && matches!(
                        c.action,
                        AuthAction::Read {
                            table_name: "observations",
                            ..
                        }
                    ))
                    || (deny_rollback
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
        if deny_rollback {
            let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = store.preview_with_hook(&request(), &control(), &mut || {
                    panic!("preview fault unwind")
                });
            }));
            assert!(panic.is_err());
        } else {
            assert!(matches!(
                store.preview_retention_change(&request(), &control()),
                Err(StoreError::Sqlite(_))
            ));
        }
        assert!(store.needs_reopen);
        assert!(matches!(
            store.preview_retention_change(&request(), &control()),
            Err(StoreError::NeedsReopen)
        ));
        drop(store);
        let mut store = directory.open();
        assert!(store
            .preview_retention_change(&request(), &control())
            .is_ok());
    }
}
