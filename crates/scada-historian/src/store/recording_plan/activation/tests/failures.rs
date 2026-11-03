use super::*;
#[test]
fn every_precommit_fault_rolls_back_metadata_session_evidence_and_receipt() {
    for at in [
        Boundary::Metadata,
        Boundary::Observation,
        Boundary::Watermark,
        Boundary::BeforeCommit,
    ] {
        for cancel in [false, true] {
            let (_d, mut store) = setup();
            let before = counter(&store);
            let c = control();
            assert!(store
                .activate_with_hook(&request("first"), &c, &mut |point| {
                    if point == at {
                        if cancel {
                            c.cancellation.cancel();
                        } else {
                            return Err(StoreError::Invalid("fault"));
                        }
                    }
                    Ok(())
                })
                .is_err());
            assert_eq!(counter(&store), before);
            assert!(store.connection.is_autocommit());
            assert!(!store.needs_reopen);
            for table in [
                "series",
                "segments",
                "sessions",
                "session_members",
                "session_evidence",
                "recording_plans",
                "recording_activations",
            ] {
                let n: i64 = store
                    .connection
                    .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                    .unwrap();
                assert_eq!(n, 0, "{at:?} {table}");
            }
            assert!(store
                .recording_activation_state(&control())
                .unwrap()
                .latest
                .is_none());
        }
    }
}
#[test]
fn late_cancel_and_lost_response_preserve_the_one_committed_activation() {
    let (_d, mut store) = setup();
    let c = control();
    let first = store
        .activate_with_hook(&request("first"), &c, &mut |at| {
            if at == Boundary::AfterCommit {
                c.cancellation.cancel();
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store
            .activate_recording_plan(&request("first"), &control())
            .unwrap(),
        first
    );
    close(&mut store, &first);
    assert!(store
        .activate_with_hook(
            &request("second"),
            &control(),
            &mut |at| if at == Boundary::AfterCommit {
                Err(StoreError::Invalid("response lost"))
            } else {
                Ok(())
            }
        )
        .is_err());
    let second = store
        .activate_recording_plan(&request("second"), &control())
        .unwrap();
    assert_eq!(second.sequence, 2);
    assert_eq!(
        store
            .recording_activation_state(&control())
            .unwrap()
            .latest
            .unwrap()
            .receipt,
        second
    );
}
#[test]
fn all_controls_reject_without_advancing_any_counter_or_partial_session() {
    let (_d, mut store) = setup();
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
            store.activate_recording_plan(&request("first"), &c),
            Err(StoreError::Control(_))
        ));
        assert_eq!(counter(&store), before);
        assert!(store.connection.is_autocommit());
        assert!(store
            .recording_activation_state(&control())
            .unwrap()
            .latest
            .is_none());
    }
}
#[test]
fn sqlite_full_on_partial_members_rolls_back_and_requires_reopen() {
    let (d, mut store) = setup();
    store.connection.execute_batch("CREATE TABLE activation_pressure(value BLOB); CREATE TEMP TRIGGER activation_full AFTER INSERT ON session_members WHEN new.series_id='number' BEGIN INSERT INTO activation_pressure VALUES(zeroblob(1048576)); END;").unwrap();
    let max: i64 = store
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
    assert!(
        matches!(store.activate_recording_plan(&request("first"),&control()),Err(StoreError::Sqlite(ref e)) if e.sqlite_error_code()==Some(rusqlite::ErrorCode::DiskFull))
    );
    assert!(store.needs_reopen);
    assert!(store.connection.is_autocommit());
    assert_eq!(counter(&store), before);
    for table in [
        "series",
        "segments",
        "sessions",
        "session_members",
        "session_evidence",
        "recording_plans",
        "recording_activations",
    ] {
        let n: i64 = store
            .connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "{table}");
    }
    store
        .connection
        .pragma_update(None, "max_page_count", max)
        .unwrap();
    drop(store);
    let mut store = d.open();
    assert_eq!(
        store
            .activate_recording_plan(&request("first"), &control())
            .unwrap()
            .sequence,
        1
    );
}
#[test]
fn panic_cleanup_is_reusable_and_failed_rollback_keeps_writer_poisoned() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
    for fail in [false, true] {
        let (d, mut store) = setup();
        if fail {
            store
                .connection
                .authorizer(Some(|ctx: AuthContext<'_>| {
                    if matches!(
                        ctx.action,
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
            let _ = store.activate_with_hook(&request("first"), &control(), &mut |at| {
                if at == Boundary::Watermark {
                    panic!("activation unwind");
                }
                Ok(())
            });
        }))
        .is_err());
        assert_eq!(store.needs_reopen, fail);
        if fail {
            assert!(matches!(
                store.recording_activation_state(&control()),
                Err(StoreError::NeedsReopen)
            ));
        } else {
            assert!(store
                .recording_activation_state(&control())
                .unwrap()
                .latest
                .is_none());
        }
        drop(store);
        let mut store = d.open();
        assert!(store
            .recording_activation_state(&control())
            .unwrap()
            .latest
            .is_none());
        store
            .activate_recording_plan(&request("first"), &control())
            .unwrap();
    }
}
#[test]
fn corrupted_activation_session_members_and_evidence_are_never_unknown_or_replayed() {
    for sql in [
        "DELETE FROM recording_activation_state",
        "UPDATE recording_activation_state SET last_sequence=NULL,activation_count=0",
        "UPDATE recording_activations SET request_json='{}'",
        "UPDATE recording_activations SET request_hash=printf('%064d',0)",
        "UPDATE recording_activations SET receipt_json='{}'",
        "UPDATE recording_activations SET clock_epoch='different'",
        "UPDATE recording_activations SET commit_version=commit_version-1",
        "UPDATE sessions SET spec_json='{}'",
        "DELETE FROM session_members WHERE series_id='number'",
        "UPDATE session_evidence SET clock_epoch='different'",
        "UPDATE session_evidence SET start_ms=999",
        "DELETE FROM session_evidence",
        "UPDATE segments SET descriptor_json='{}'",
        "UPDATE recording_plans SET created_commit=created_commit+1",
        "UPDATE recording_plans SET members_json='[]'",
    ] {
        let (_d, mut store) = setup();
        store
            .activate_recording_plan(&request("first"), &control())
            .unwrap();
        store.connection.execute_batch(sql).unwrap();
        let before = counter(&store);
        assert!(
            matches!(
                store.recording_activation_state(&control()),
                Err(StoreError::CorruptData)
            ),
            "{sql}"
        );
        assert!(
            matches!(
                store.recording_activation("first", &control()),
                Err(StoreError::CorruptData)
            ),
            "{sql}"
        );
        assert!(
            matches!(
                store.activate_recording_plan(&request("first"), &control()),
                Err(StoreError::CorruptData)
            ),
            "{sql}"
        );
        assert_eq!(counter(&store), before);
        assert!(store.connection.is_autocommit());
        assert!(!store.needs_reopen);
    }
}
#[test]
fn process_exit_on_each_boundary_keeps_only_atomic_start_and_replay() {
    for at in [
        Boundary::Metadata,
        Boundary::Observation,
        Boundary::Watermark,
        Boundary::BeforeCommit,
        Boundary::AfterCommit,
    ] {
        let (d, store) = setup();
        drop(store);
        let exit = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store::recording_plan::activation::tests::failures::activation_process_worker",
                "--nocapture",
            ])
            .env("SCADA_ACTIVATION_TEST_PATH", &d.0)
            .env("SCADA_ACTIVATION_TEST_BOUNDARY", format!("{at:?}"))
            .status()
            .unwrap();
        assert_eq!(exit.code(), Some(91));
        let mut store = d.open();
        let latest = store.recording_activation_state(&control()).unwrap().latest;
        assert_eq!(latest.is_some(), at == Boundary::AfterCommit);
        if let Some(latest) = latest {
            assert_eq!(latest.session.state, SessionState::Interrupted);
            assert_eq!(
                store
                    .activate_recording_plan(&request("first"), &control())
                    .unwrap(),
                latest.receipt
            );
        } else {
            store
                .activate_recording_plan(&request("first"), &control())
                .unwrap();
        }
    }
}
#[test]
fn activation_process_worker() {
    let Ok(path) = std::env::var("SCADA_ACTIVATION_TEST_PATH") else {
        return;
    };
    let target = std::env::var("SCADA_ACTIVATION_TEST_BOUNDARY").unwrap();
    let mut store = reopen_unowned(path, &identity()).unwrap();
    store
        .activate_with_hook(&request("first"), &control(), &mut |at| {
            if format!("{at:?}") == target {
                std::process::exit(91);
            }
            Ok(())
        })
        .unwrap();
    panic!("activation boundary was not reached");
}

#[test]
fn full_is_not_reclassified_when_cancellation_is_set_during_sql_compilation() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    let (_d, mut store) = setup();
    store.connection.execute_batch("CREATE TABLE activation_pressure(value BLOB); CREATE TEMP TRIGGER activation_full AFTER INSERT ON session_members BEGIN INSERT INTO activation_pressure VALUES(zeroblob(1048576)); END;").unwrap();
    let pages: i64 = store
        .connection
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .unwrap();
    store
        .connection
        .pragma_update(None, "max_page_count", pages)
        .unwrap();
    let c = control();
    let token = c.cancellation.clone();
    store
        .connection
        .authorizer(Some(move |context: AuthContext<'_>| {
            if matches!(
                context.action,
                AuthAction::Insert {
                    table_name: "activation_pressure"
                }
            ) {
                token.cancel();
            }
            Authorization::Allow
        }))
        .unwrap();
    let before = counter(&store);
    assert!(
        matches!(store.activate_recording_plan(&request("first"),&c),Err(StoreError::Sqlite(ref e)) if e.sqlite_error_code()==Some(rusqlite::ErrorCode::DiskFull))
    );
    assert!(c.cancellation.is_cancelled());
    assert!(store.needs_reopen);
    assert_eq!(counter(&store), before);
    assert!(store.connection.is_autocommit());
}

#[test]
fn activation_capacity_preserves_latest_and_old_receipts() {
    let (_d, mut store) = setup();
    let first = store
        .activate_recording_plan(&request("first"), &control())
        .unwrap();
    close(&mut store, &first);
    let tx = store.connection.transaction().unwrap();
    for n in 2..=MAX_LEDGER_ENTRIES {
        let r = request(&format!("seed:{n}"));
        let mut receipt = first.clone();
        receipt.activation_id = r.activation_id.clone();
        receipt.sequence = n;
        receipt.commit_version = first.commit_version + (n - 1) * 2;
        receipt.spec.session_id = r.session_id.clone();
        receipt.start = r.start.clone();
        tx.execute(
            "INSERT INTO sessions VALUES(?1,'closed',?2,0,?3,?4)",
            params![
                r.session_id,
                serde_json::to_string(&receipt.spec).unwrap(),
                receipt.commit_version as i64,
                receipt.commit_version as i64 + 1
            ],
        )
        .unwrap();
        for m in &receipt.spec.members {
            tx.execute(
                "INSERT INTO session_members VALUES(?1,?2,?3)",
                params![r.session_id, m.series_id, m.segment_id],
            )
            .unwrap();
        }
        tx.execute(
            "INSERT INTO session_evidence VALUES(?1,?2,?3,?4,1000,3000,3000)",
            params![
                r.session_id,
                receipt.plan.plan_id,
                receipt.plan.revision as i64,
                r.start.clock_epoch
            ],
        )
        .unwrap();
        let text = canonical::encode(&r).unwrap();
        tx.execute(
            "INSERT INTO recording_activations VALUES(?1,?2,1,1,1,?3,?4,?5,?6,?7,?8)",
            params![
                n as i64,
                r.activation_id,
                r.session_id,
                r.start.clock_epoch,
                text,
                canonical::hash(&text),
                receipt.commit_version as i64,
                canonical::encode(&receipt).unwrap()
            ],
        )
        .unwrap();
    }
    tx.execute(
        "UPDATE recording_activation_state SET last_sequence=?1,activation_count=?1",
        [MAX_LEDGER_ENTRIES as i64],
    )
    .unwrap();
    tx.execute(
        "UPDATE store_meta SET last_commit=?1",
        [(first.commit_version + MAX_LEDGER_ENTRIES * 2 - 1) as i64],
    )
    .unwrap();
    tx.commit().unwrap();
    let before = counter(&store);
    assert!(matches!(
        store.activate_recording_plan(&request("overflow"), &control()),
        Err(StoreError::RecordingPlanCapacity)
    ));
    assert_eq!(counter(&store), before);
    assert_eq!(
        store
            .activate_recording_plan(&request("first"), &control())
            .unwrap(),
        first
    );
    assert_eq!(
        store
            .recording_activation_state(&control())
            .unwrap()
            .latest
            .unwrap()
            .receipt
            .sequence,
        MAX_LEDGER_ENTRIES
    );
}

#[test]
fn managed_session_without_activation_or_evidence_is_never_treated_as_manual() {
    for sql in [
        "UPDATE recording_activation_state SET last_sequence=NULL,activation_count=0; DELETE FROM recording_activations",
        "DELETE FROM session_evidence",
    ] {
        let (_d,mut store)=setup();
        let receipt=store.activate_recording_plan(&request("first"),&control()).unwrap();close(&mut store,&receipt);
        store.connection.execute_batch(sql).unwrap();
        assert!(matches!(store.recording_activation_state(&control()),Err(StoreError::CorruptData)));
        assert!(matches!(store.recording_plan_state(&control()),Err(StoreError::CorruptData)));
        assert!(matches!(store.activate_recording_plan(&request("next"),&control()),Err(StoreError::CorruptData)));
    }
}

#[test]
fn activated_permanent_metadata_cannot_disappear_or_be_silently_recreated() {
    for sql in [
        "PRAGMA foreign_keys=OFF; DELETE FROM segments WHERE series_id='number'",
        "PRAGMA foreign_keys=OFF; DELETE FROM segments WHERE series_id='number'; DELETE FROM series WHERE series_id='number'",
    ] {
        let (_d,mut store)=setup();let receipt=store.activate_recording_plan(&request("first"),&control()).unwrap();close(&mut store,&receipt);
        store.connection.execute_batch(sql).unwrap();let before=counter(&store);
        assert!(matches!(store.recording_activation_state(&control()),Err(StoreError::CorruptData)));
        assert!(matches!(store.recording_activation("first",&control()),Err(StoreError::CorruptData)));
        assert!(matches!(store.activate_recording_plan(&request("first"),&control()),Err(StoreError::CorruptData)));
        assert!(matches!(store.activate_recording_plan(&request("next"),&control()),Err(StoreError::CorruptData)));
        assert!(matches!(store.recording_plan_state(&control()),Err(StoreError::CorruptData)));
        assert_eq!(counter(&store),before);
    }
}
