use super::*;

#[test]
fn corrupt_saved_evidence_never_becomes_missing_or_a_reused_id_conflict() {
    for corruption in [
        "DELETE FROM recording_mapping_state",
        "DELETE FROM recording_plan_state",
        "UPDATE recording_plan_state SET ledger_plan_id='wrong'",
        "UPDATE recording_plan_applications SET receipt_json='{}'",
        "UPDATE recording_plan_applications SET request_json='{}'",
        "UPDATE recording_plan_applications SET resolved_hash=printf('%064d',0)",
        "UPDATE recording_desired_definitions SET desired_hash=printf('%064d',0)",
        "UPDATE recording_desired_definitions SET created_commit=created_commit+1",
        "UPDATE recording_mapping_revisions SET mapping_hash=printf('%064d',0)",
        "UPDATE retention_policy_applications SET receipt_json='{}'",
        "PRAGMA foreign_keys=OFF; UPDATE recording_series_reservations SET first_revision=2",
        "DELETE FROM recording_application_members",
    ] {
        let (_dir, mut store) = enabled_store();
        let original = apply("original", None, true);
        store.apply_recording_plan(&original, &control()).unwrap();
        store.connection.execute_batch(corruption).unwrap();
        let before = counter(&store);
        let mut reader = store.reader().unwrap();
        assert!(
            matches!(
                reader.recording_plan_receipt_for_request(&original, &control()),
                Err(StoreError::CorruptData)
            ),
            "{corruption}"
        );
        let mut wrong = original.clone();
        wrong.expected_applied_revision = Some(1);
        assert!(
            matches!(
                reader.recording_plan_receipt_for_request(&wrong, &control()),
                Err(StoreError::CorruptData)
            ),
            "{corruption}"
        );
        assert_eq!(counter(&store), before);
        assert!(!store.needs_reopen);
    }
}

#[test]
fn unknown_request_does_not_hide_corrupt_heads_but_unrelated_body_is_not_recursively_read() {
    let (_dir, mut store) = enabled_store();
    let first = apply("first", None, false);
    let receipt = store.apply_recording_plan(&first, &control()).unwrap();
    store
        .apply_recording_plan(&apply("next", Some(1), false), &control())
        .unwrap();
    store
        .connection
        .execute_batch(
            "UPDATE recording_plan_applications SET receipt_json='{}' WHERE request_id='next'",
        )
        .unwrap();
    let mut reader = store.reader().unwrap();
    assert_eq!(
        reader
            .recording_plan_receipt_for_request(&first, &control())
            .unwrap()
            .receipt,
        Some(receipt)
    );
    store
        .connection
        .execute_batch("DELETE FROM recording_plan_state")
        .unwrap();
    assert!(matches!(
        reader.recording_plan_receipt_for_request(&apply("missing", None, false), &control()),
        Err(StoreError::CorruptData)
    ));
}

#[test]
fn sqlite_full_rollback_can_be_read_without_recovering_or_transferring_the_writer() {
    let (_dir, mut store) = enabled_store();
    let original = apply("original", None, true);
    let mut reader = store.reader().unwrap();
    store.connection.execute_batch("CREATE TABLE recording_pressure(value BLOB); CREATE TEMP TRIGGER recording_full AFTER INSERT ON recording_application_members BEGIN INSERT INTO recording_pressure VALUES(zeroblob(1048576)); END;").unwrap();
    let pages: i64 = store
        .connection
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .unwrap();
    store
        .connection
        .pragma_update(None, "max_page_count", pages)
        .unwrap();
    let before = counter(&store);
    let error = store
        .apply_recording_plan(&original, &control())
        .unwrap_err();
    assert!(
        matches!(error,StoreError::Sqlite(ref e) if e.sqlite_error_code()==Some(rusqlite::ErrorCode::DiskFull))
    );
    assert!(store.needs_reopen);
    assert!(matches!(
        store.recording_plan_receipt("original", &control()),
        Err(StoreError::NeedsReopen)
    ));
    let read = reader
        .recording_plan_receipt_for_request(&original, &control())
        .unwrap();
    assert_eq!(read.snapshot_commit, before as u64);
    assert!(read.receipt.is_none());
    assert!(store.needs_reopen);
    assert_eq!(counter(&store), before);
}

#[test]
fn committed_receipt_is_found_after_the_writer_loses_its_success_response() {
    let (_dir, mut store) = enabled_store();
    let original = apply("original", None, true);
    let mut reader = store.reader().unwrap();
    let before = counter(&store);
    assert!(store
        .apply_recording_plan_with_hook(&original, &control(), &mut |at| {
            if at == Boundary::AfterCommit {
                Err(StoreError::Invalid("lost response"))
            } else {
                Ok(())
            }
        })
        .is_err());
    let read = reader
        .recording_plan_receipt_for_request(&original, &control())
        .unwrap();
    assert_eq!(read.snapshot_commit, before as u64 + 1);
    assert_eq!(read.receipt.unwrap().applied_revision, 1);
    assert_eq!(counter(&store), before + 1);
}
