use super::*;
use crate::store::{
    recording_plan::tests::{apply, control, counter, enabled_store, register},
    test_support::TempStore,
    SessionState,
};
fn setup() -> (TempStore, SqliteStore) {
    let (d, mut s) = enabled_store();
    s.apply_recording_plan(&apply("apply", None, true), &control())
        .unwrap();
    (d, s)
}
fn activate(s: &mut SqliteStore) -> RecordingActivationReceipt {
    s.activate_recording_plan(
        &ActivateRecordingPlanRequest {
            activation_id: "start".into(),
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
    .unwrap()
}
#[test]
fn empty_and_current_active_closed_states_share_all_snapshot_commits_without_mutating_store() {
    let d = TempStore::new();
    let s = d.create();
    let mut r = s.reader().unwrap();
    let before = counter(&s);
    let v = r.recording_resume_state(&control()).unwrap();
    assert_eq!(v.snapshot_commit, 0);
    assert_eq!(v.plan.snapshot_commit, 0);
    assert_eq!(v.recovery.snapshot_commit, 0);
    assert!(v.plan.applied.is_none());
    assert!(v.latest_activation.is_none());
    assert_eq!(counter(&s), before);
    drop(r);
    drop(s);
    let (_d, mut s) = setup();
    let mut r = s.reader().unwrap();
    let receipt = activate(&mut s);
    let before = counter(&s);
    let v = r.recording_resume_state(&control()).unwrap();
    assert_eq!(v.snapshot_commit, before as u64);
    assert_eq!(v.plan.snapshot_commit, v.snapshot_commit);
    assert_eq!(v.recovery.snapshot_commit, v.snapshot_commit);
    assert_eq!(v.latest_activation.as_ref().unwrap().receipt, receipt);
    assert_eq!(v.recovery.active_session_id.as_deref(), Some("session"));
    assert_eq!(counter(&s), before);
    s.close_timed_session(
        "session",
        evidence::ClockStamp {
            clock_epoch: "epoch".into(),
            at_ms: 2000,
        },
    )
    .unwrap();
    let v = r.recording_resume_state(&control()).unwrap();
    assert!(v.recovery.active_session_id.is_none());
    assert_eq!(
        v.latest_activation.unwrap().session.state,
        SessionState::Closed
    );
}
#[test]
fn writer_progress_after_snapshot_pin_cannot_mix_heads_activation_and_recovery() {
    let (_d, mut s) = setup();
    let mut r = s.reader().unwrap();
    let before = counter(&s);
    let v = r
        .resume_with_hook(&control(), &mut || {
            activate(&mut s);
            Ok(())
        })
        .unwrap();
    assert_eq!(v.snapshot_commit, before as u64);
    assert!(v.latest_activation.is_none());
    assert!(v.recovery.active_session_id.is_none());
    let v = r.recording_resume_state(&control()).unwrap();
    assert!(v.snapshot_commit > before as u64);
    assert!(v.latest_activation.is_some());
    assert_eq!(v.recovery.active_session_id.as_deref(), Some("session"));
}
#[test]
fn current_mapping_and_plan_can_differ_from_latest_closed_activation_without_inventing_a_new_start()
{
    let (_d, mut s) = setup();
    let old = activate(&mut s);
    s.close_timed_session(
        "session",
        evidence::ClockStamp {
            clock_epoch: "epoch".into(),
            at_ms: 2000,
        },
    )
    .unwrap();
    s.register_recording_mapping(&register("map:2", Some(1)), &control())
        .unwrap();
    let mut next = apply("apply:2", Some(1), true);
    next.expected_mapping_revision = Some(2);
    let receipt = s.apply_recording_plan(&next, &control()).unwrap();
    let mut reader = s.reader().unwrap();
    let v = reader.recording_resume_state(&control()).unwrap();
    assert_eq!(v.plan.applied.unwrap().receipt, receipt);
    assert_eq!(v.plan.mapping.unwrap().receipt.mapping_revision, 2);
    assert_eq!(v.latest_activation.unwrap().receipt, old);
}
#[test]
fn small_original_budgets_deadline_cancel_and_panics_leave_reader_reusable() {
    let (_d, s) = setup();
    let mut r = s.reader().unwrap();
    for kind in 0..5 {
        let mut c = control();
        match kind {
            0 => c.cancellation.cancel(),
            1 => c.deadline = std::time::Instant::now(),
            2 => c.limits.max_decoded_rows = 1,
            3 => c.limits.max_vm_steps = 1000,
            _ => c.limits.max_output_bytes = 1,
        };
        assert!(matches!(
            r.recording_resume_state(&c),
            Err(StoreError::Control(_))
        ));
        assert!(r.recording_resume_state(&control()).is_ok());
    }
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = r.resume_with_hook(&control(), &mut || panic!("snapshot"));
    }))
    .is_err());
    assert!(r.recording_resume_state(&control()).is_ok());
}
#[test]
fn old_receipt_and_metadata_corruption_are_not_hidden_by_full_or_first_use_caches() {
    for kind in 0..3 {
        let (_d, mut s) = setup();
        activate(&mut s);
        let mut r = s.reader().unwrap();
        assert!(r.recording_resume_state(&control()).is_ok());
        let sql = match kind {
            0 => {
                "UPDATE recording_plan_applications SET receipt_json='{}' WHERE applied_revision=1"
            }
            1 => "UPDATE recording_activations SET receipt_json='{}' WHERE sequence=1",
            _ => "UPDATE segments SET descriptor_json='{}'",
        };
        s.connection.execute(sql, []).unwrap();
        assert!(matches!(
            r.recording_resume_state(&control()),
            Err(StoreError::CorruptData)
        ));
    }
    // A first-use proof intentionally skips receipt text; it cannot satisfy the
    // full validation of the old application's activation evidence.
    let (_d, mut s) = setup();
    activate(&mut s);
    s.close_timed_session(
        "session",
        evidence::ClockStamp {
            clock_epoch: "epoch".into(),
            at_ms: 2000,
        },
    )
    .unwrap();
    s.apply_recording_plan(&apply("apply:2", Some(1), true), &control())
        .unwrap();
    let mut r = s.reader().unwrap();
    r.recording_resume_state(&control()).unwrap();
    s.connection
        .execute(
            "UPDATE recording_plan_applications SET receipt_json='{}' WHERE applied_revision=1",
            [],
        )
        .unwrap();
    assert!(matches!(
        r.recording_resume_state(&control()),
        Err(StoreError::CorruptData)
    ));
}
#[test]
fn reopen_and_active_retention_job_are_diagnostics_not_restart_permissions() {
    let (d, mut s) = setup();
    let original = activate(&mut s);
    drop(s);
    let mut s = d.open();
    let mut r = s.reader().unwrap();
    let v = r.recording_resume_state(&control()).unwrap();
    assert_eq!(v.latest_activation.as_ref().unwrap().receipt, original);
    assert_eq!(
        v.latest_activation.unwrap().session.state,
        SessionState::Interrupted
    );
    assert!(v.recovery.active_session_id.is_none());
    s.begin_retention_job(
        retention::jobs::JobRequest {
            job_id: "job".into(),
            cutoff_ms: 1000,
            expected_cutoff_ms: None,
        },
        &control(),
    )
    .unwrap();
    let before = counter(&s);
    let v = r.recording_resume_state(&control()).unwrap();
    assert_eq!(v.recovery.active_job.unwrap().status.job_id, "job");
    assert_eq!(counter(&s), before);
}
#[test]
fn cached_full_applications_keep_ledger_and_snapshot_bounds() {
    let (_d, s) = setup();
    let mut b = Budget::new(&control());
    let h = read::heads(&s.connection, &mut b).unwrap();
    let mut cache = reservations::EvidenceCache::default();
    let ledger = h.ledger.as_deref().unwrap();
    read::application_with_cache(&s.connection, &mut b, 1, h.snapshot, ledger, &mut cache).unwrap();
    assert!(matches!(
        read::application_with_cache(&s.connection, &mut b, 1, 0, ledger, &mut cache),
        Err(StoreError::CorruptData)
    ));
    assert!(matches!(
        read::application_with_cache(
            &s.connection,
            &mut b,
            1,
            h.snapshot,
            "other:ledger",
            &mut cache
        ),
        Err(StoreError::CorruptData)
    ));
}
