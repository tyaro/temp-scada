use super::*;
use crate::store::{
    query::QueryError,
    recording_plan::tests::{apply, control, counter, enabled_store, register},
    test_support::{identity, TempStore},
    SessionState,
};
use serde_json::json;

#[test]
fn empty_snapshot_and_unregistered_requests_do_not_recheck_current_cas() {
    let dir = TempStore::new();
    let mut store = dir.create();
    let mut reader = store.reader().unwrap();
    let mut original = apply("missing", Some(MAX_SAFE), true);
    original.expected_mapping_revision = Some(MAX_SAFE);
    original.expected_retention_applied_revision = Some(MAX_SAFE);
    assert_eq!(
        reader
            .recording_plan_receipt_for_request(&original, &control())
            .unwrap(),
        RecordingPlanReceiptSnapshot {
            snapshot_commit: 0,
            receipt: None
        }
    );
    let first = apply("first", None, false);
    store.apply_recording_plan(&first, &control()).unwrap();
    let before = counter(&store);
    assert_eq!(
        reader
            .recording_plan_receipt_for_request(&original, &control())
            .unwrap(),
        RecordingPlanReceiptSnapshot {
            snapshot_commit: before as u64,
            receipt: None
        }
    );
    assert_eq!(counter(&store), before);
}

#[test]
fn old_request_matches_its_receipt_after_new_application_and_mapping_heads() {
    let (_dir, mut store) = enabled_store();
    let original = apply("original", None, true);
    let receipt = store.apply_recording_plan(&original, &control()).unwrap();
    let mut next = apply("next", Some(1), false);
    next.desired["revision"] = json!(2);
    store.apply_recording_plan(&next, &control()).unwrap();
    store
        .register_recording_mapping(&register("map:2", Some(1)), &control())
        .unwrap();
    use crate::store::retention::application::{PolicyApplyRequest, PolicyPreparationRequest};
    let mut policy = store
        .recovery_state(&control())
        .unwrap()
        .applied_retention_policy
        .unwrap()
        .policy;
    policy.revision = 2;
    let preview = store
        .preview_retention_policy_application(
            &PolicyPreparationRequest {
                proposed_policy: policy.clone(),
                reference_wall_ms: 3000,
            },
            &control(),
        )
        .unwrap();
    store
        .apply_retention_policy(
            &PolicyApplyRequest {
                request_id: "retention:2".into(),
                expected_applied_revision: Some(1),
                expected_preview_snapshot_commit: preview.snapshot_commit,
                reference_wall_ms: 3000,
                proposed_policy: policy,
            },
            &control(),
        )
        .unwrap();
    let before = counter(&store);
    let changes = store.connection.total_changes();
    let mut reader = store.reader().unwrap();
    let read = reader
        .recording_plan_receipt_for_request(&original, &control())
        .unwrap();
    assert_eq!(read.snapshot_commit, before as u64);
    assert_eq!(read.receipt, Some(receipt));
    assert!(read.snapshot_commit > read.receipt.unwrap().commit_version);
    assert_eq!(counter(&store), before);
    assert_eq!(store.connection.total_changes(), changes);
}

#[test]
fn lookup_does_not_stop_an_active_session_or_treat_it_as_a_busy_apply() {
    let (_dir, mut store) = enabled_store();
    let original = apply("original", None, true);
    let receipt = store.apply_recording_plan(&original, &control()).unwrap();
    store
        .activate_recording_plan(
            &ActivateRecordingPlanRequest {
                activation_id: "activation".into(),
                expected_applied_revision: 1,
                expected_mapping_revision: 1,
                expected_retention_applied_revision: 1,
                session_id: "session".into(),
                start: evidence::ClockStamp {
                    clock_epoch: "epoch".into(),
                    at_ms: 1000,
                },
            },
            &control(),
        )
        .unwrap();
    let before = counter(&store);
    let mut reader = store.reader().unwrap();
    assert_eq!(
        reader
            .recording_plan_receipt_for_request(&original, &control())
            .unwrap()
            .receipt,
        Some(receipt)
    );
    let next = apply("missing", Some(1), true);
    assert!(reader
        .recording_plan_receipt_for_request(&next, &control())
        .unwrap()
        .receipt
        .is_none());
    assert_eq!(
        store.session_status("session").unwrap().unwrap().state,
        SessionState::Active
    );
    assert_eq!(counter(&store), before);
}

#[test]
fn canonical_member_order_and_integer_spelling_do_not_replace_original_content() {
    let (_dir, mut store) = enabled_store();
    let mut original = apply("original", None, true);
    original.desired["group"]["members"]
        .as_array_mut()
        .unwrap()
        .reverse();
    original.desired["revision"] = json!(1.0);
    original.desired["group"]["periodMs"] = json!(1000.0);
    let copy = original.clone();
    let receipt = store.apply_recording_plan(&original, &control()).unwrap();
    let mut reader = store.reader().unwrap();
    assert_eq!(
        reader
            .recording_plan_receipt_for_request(&original, &control())
            .unwrap()
            .receipt,
        Some(receipt.clone())
    );
    assert_eq!(original, copy);
    assert_eq!(
        reader
            .recording_plan_receipt_for_request(&apply("original", None, true), &control())
            .unwrap()
            .receipt,
        Some(receipt)
    );
}

#[test]
fn every_different_expected_revision_or_desired_content_conflicts_for_the_same_id() {
    let (_dir, mut store) = enabled_store();
    let original = apply("original", None, true);
    store.apply_recording_plan(&original, &control()).unwrap();
    let mut reader = store.reader().unwrap();
    for kind in 0..8 {
        let mut changed = original.clone();
        match kind {
            0 => changed.expected_applied_revision = Some(1),
            1 => changed.expected_mapping_revision = Some(2),
            2 => changed.expected_retention_applied_revision = Some(2),
            3 => changed.desired["revision"] = json!(2),
            4 => changed.desired["planId"] = json!("other"),
            5 => changed.desired["group"]["groupId"] = json!("other"),
            6 => changed.desired["group"]["members"][0]["externalName"] = json!("other"),
            _ => {
                changed.desired["enabled"] = json!(false);
                changed.expected_mapping_revision = None;
                changed.expected_retention_applied_revision = None;
            }
        }
        assert!(
            matches!(
                reader.recording_plan_receipt_for_request(&changed, &control()),
                Err(StoreError::Conflict)
            ),
            "{kind}"
        );
        assert!(reader
            .recording_plan_receipt_for_request(&original, &control())
            .unwrap()
            .receipt
            .is_some());
    }
}

#[test]
fn no_receipt_from_after_the_pinned_snapshot_is_mixed_into_a_missing_result() {
    let (_dir, mut store) = enabled_store();
    let mut reader = store.reader().unwrap();
    let original = apply("original", None, true);
    let before = counter(&store);
    let mut receipt = None;
    let read = reader
        .receipt_for_request_with_hook(&original, &control(), &mut || {
            receipt = Some(store.apply_recording_plan(&original, &control())?);
            Ok(())
        })
        .unwrap();
    assert_eq!(read.snapshot_commit, before as u64);
    assert!(read.receipt.is_none());
    let read = reader
        .recording_plan_receipt_for_request(&original, &control())
        .unwrap();
    assert_eq!(read.receipt, receipt);
    assert!(read.snapshot_commit > before as u64);
}

#[test]
fn found_receipt_keeps_the_snapshot_commit_from_before_a_later_writer_commit() {
    let (_dir, mut store) = enabled_store();
    let original = apply("original", None, true);
    let receipt = store.apply_recording_plan(&original, &control()).unwrap();
    let before = counter(&store);
    let mut reader = store.reader().unwrap();
    let read = reader
        .receipt_for_request_with_hook(&original, &control(), &mut || {
            let mut next = apply("next", Some(1), false);
            next.desired["revision"] = json!(2);
            store.apply_recording_plan(&next, &control())?;
            Ok(())
        })
        .unwrap();
    assert_eq!(read.snapshot_commit, before as u64);
    assert_eq!(read.receipt, Some(receipt));
    assert!(counter(&store) > before);
}

#[test]
fn each_original_control_limit_is_enforced_and_errors_do_not_poison_a_healthy_reader() {
    let (_dir, mut store) = enabled_store();
    let original = apply("original", None, true);
    let receipt = store.apply_recording_plan(&original, &control()).unwrap();
    let mut reader = store.reader().unwrap();
    for kind in 0..7 {
        let mut c = control();
        let expected = match kind {
            0 => {
                c.cancellation.cancel();
                QueryError::Cancelled
            }
            1 => {
                c.deadline = std::time::Instant::now();
                QueryError::Deadline
            }
            2 => {
                c.limits.max_decoded_rows = 1;
                QueryError::WorkLimit
            }
            3 => {
                c.limits.max_vm_steps = 1000;
                QueryError::WorkLimit
            }
            4 => {
                c.limits.max_output_bytes = 1;
                QueryError::ByteLimit
            }
            5 => {
                c.limits.max_vm_steps = 0;
                QueryError::InvalidLimits
            }
            _ => {
                c.limits.max_decoded_rows = 9001;
                QueryError::InvalidLimits
            }
        };
        assert!(
            matches!(reader.recording_plan_receipt_for_request(&original,&c),Err(StoreError::Control(error)) if error==expected),
            "{kind}"
        );
        assert_eq!(
            reader
                .recording_plan_receipt_for_request(&original, &control())
                .unwrap()
                .receipt,
            Some(receipt.clone())
        );
    }
}

#[test]
fn malformed_or_oversized_input_is_rejected_before_opening_a_snapshot() {
    let (_dir, store) = enabled_store();
    let mut reader = store.reader().unwrap();
    for kind in 0..5 {
        let mut bad = apply("missing", None, true);
        match kind {
            0 => bad.request_id = " ".into(),
            1 => bad.expected_applied_revision = Some(0),
            2 => bad.desired["extra"] = json!("private"),
            3 => bad.expected_mapping_revision = None,
            _ => bad.request_id = "x".repeat(MAX_DOCUMENT_BYTES + 1),
        }
        let mut entered = false;
        assert!(
            reader
                .receipt_for_request_with_hook(&bad, &control(), &mut || {
                    entered = true;
                    Ok(())
                })
                .is_err(),
            "{kind}"
        );
        assert!(!entered);
    }
    assert!(reader
        .recording_plan_receipt_for_request(&apply("missing", None, true), &control())
        .unwrap()
        .receipt
        .is_none());
}

#[test]
fn late_cancellation_and_panics_roll_back_before_the_reader_can_be_reused() {
    let (_dir, mut store) = enabled_store();
    let original = apply("original", None, true);
    let receipt = store.apply_recording_plan(&original, &control()).unwrap();
    let mut reader = store.reader().unwrap();
    let c = control();
    assert!(matches!(
        reader.receipt_for_request_with_hook(&original, &c, &mut || {
            c.cancellation.cancel();
            Ok(())
        }),
        Err(StoreError::Control(QueryError::Cancelled))
    ));
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = reader.receipt_for_request_with_hook(&original, &control(), &mut || {
            panic!("injected snapshot unwind")
        });
    }))
    .is_err());
    assert_eq!(
        reader
            .recording_plan_receipt_for_request(&original, &control())
            .unwrap()
            .receipt,
        Some(receipt)
    );
}

#[test]
fn existing_leases_are_reused_and_keep_the_writer_lock_after_writer_drop() {
    let (dir, mut store) = enabled_store();
    let original = apply("original", None, true);
    let receipt = store.apply_recording_plan(&original, &control()).unwrap();
    let mut a = store.reader().unwrap();
    let b = store.reader().unwrap();
    assert!(matches!(store.reader(), Err(StoreError::Busy)));
    a.recording_plan_receipt_for_request(&original, &control())
        .unwrap();
    assert_eq!(
        store
            .storage_diagnostics(&control())
            .unwrap()
            .live_reader_leases,
        2
    );
    drop(store);
    assert!(matches!(
        SqliteStore::open_existing(&dir.0, &identity()),
        Err(StoreError::Busy)
    ));
    assert_eq!(
        a.recording_plan_receipt_for_request(&original, &control())
            .unwrap()
            .receipt,
        Some(receipt)
    );
    drop(a);
    drop(b);
    let mut store = dir.open();
    assert_eq!(
        store
            .recording_plan_receipt("original", &control())
            .unwrap()
            .unwrap()
            .applied_revision,
        1
    );
}

#[test]
fn snapshot_serialization_only_exposes_commit_and_receipt() {
    let dir = TempStore::new();
    let store = dir.create();
    let mut reader = store.reader().unwrap();
    let snapshot = reader
        .recording_plan_receipt_for_request(&apply("missing", None, false), &control())
        .unwrap();
    assert_eq!(
        serde_json::to_value(snapshot).unwrap(),
        json!({"snapshotCommit":0,"receipt":null})
    );
}

mod failures;
