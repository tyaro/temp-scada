use super::*;

#[tokio::test]
async fn committed_lost_response_is_found_without_changing_original_completion_or_recovery() {
    let (mut owner, _dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
    let original = op.wait().await.unwrap();
    let h = c.reconcile(&a.change, &op, "read", control()).unwrap();
    let found = h.wait().await.unwrap();
    assert_eq!(found.as_value()["outcome"]["kind"], "receiptFound");
    assert_eq!(found.as_value()["quiescence"], "confirmed");
    assert_eq!(found.as_value()["recoveryRequired"], true);
    assert_eq!(
        found.as_value()["request"]["operation"],
        *op.request().as_value()
    );
    let state = c.state();
    assert_eq!(state.reconciliation_phase, ReconciliationPhase::Completed);
    assert_eq!(
        state.latest.as_ref().unwrap().as_value()["outcome"]["kind"],
        "applied"
    );
    assert_eq!(state.last_applied.as_ref().unwrap().request, *op.request());
    assert_eq!(op.wait().await.unwrap(), original);
    assert_eq!(
        c.preflight(fixtures::change("again"), control())
            .unwrap_err()
            .code,
        OperationErrorCode::PlanRecoveryRequired
    );
    let next = c.reconcile(&a.change, &op, "read2", control()).unwrap();
    assert_eq!(
        next.wait().await.unwrap().as_value()["outcome"]["kind"],
        "receiptFound"
    );
    assert_eq!(h.wait().await.unwrap(), found);
    let handoff = owner.try_handoff().unwrap();
    assert!(
        handoff
            .supervisor
            .recording_plan_guard_state()
            .recovery_required
    );
    assert_eq!(
        handoff.supervisor.state().recording.phase,
        RecordingPhase::Joined
    );
    assert_eq!(
        handoff.evidence.last_reconciliation.unwrap(),
        next.wait().await.unwrap()
    );
}
#[tokio::test]
async fn rollback_absence_and_read_errors_do_not_authorize_resend() {
    let (mut owner, _dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::Full).await;
    let original = op.wait().await.unwrap();
    for (id, limits, expected) in [("none", None, "notFound"), ("rows", Some(1), "failed")] {
        let mut ctl = control();
        if let Some(n) = limits {
            ctl.limits.max_decoded_rows = n;
        }
        let h = c.reconcile(&a.change, &op, id, ctl).unwrap();
        assert_eq!(
            h.wait().await.unwrap().as_value()["outcome"]["kind"],
            expected
        );
        assert_eq!(c.state().latest.as_ref().unwrap(), &original);
        assert!(c.state().recovery_required);
        assert_eq!(
            c.apply(&a.change, "retry", control()).unwrap_err().code,
            OperationErrorCode::PlanRecoveryRequired
        );
    }
    assert!(
        owner
            .try_handoff()
            .unwrap()
            .supervisor
            .recording_plan_guard_state()
            .recovery_required
    );
}
#[tokio::test]
async fn native_worker_panic_can_be_read_without_forging_original_quiescence() {
    let (mut owner, _dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::WorkerPanic).await;
    let h = c
        .reconcile(&a.change, &op, "afterpanic", control())
        .unwrap();
    let r = h.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["kind"], "notFound");
    assert_eq!(r.as_value()["quiescence"], "unknown");
    assert_eq!(
        c.state().reconciliation_phase,
        ReconciliationPhase::Completed
    );
    assert_eq!(c.state().phase, OperationsPhase::Uncertain);
    assert!(matches!(owner.try_handoff(), Err(OwnerError::Busy)));
}
#[tokio::test]
async fn known_receipt_survives_not_found_and_contradictory_receipt() {
    let (owner, _dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
    c.reconcile(&a.change, &op, "found", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
    let known = c.state().latest.clone().unwrap();
    for (fault, id, expected) in [
        (driver::TestFault::NotFound, "absent", "notFound"),
        (driver::TestFault::DifferentReceipt, "conflict", "failed"),
    ] {
        *c.shared.read_fault.lock().unwrap() = Some(fault);
        let r = c
            .reconcile(&a.change, &op, id, control())
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(r.as_value()["outcome"]["kind"], expected);
        assert_eq!(c.state().latest.as_ref().unwrap(), &known);
    }
}
#[tokio::test]
async fn unprojectable_native_receipt_is_retained_but_internal_snapshot_head_is_not_projected() {
    for (fault, id, expected) in [
        (driver::TestFault::ReceiptOverflow, "large", "failed"),
        (driver::TestFault::SnapshotOverflow, "head", "receiptFound"),
    ] {
        let (mut owner, _dir) = fixtures::setup();
        let c = owner.client();
        let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
        *c.shared.read_fault.lock().unwrap() = Some(fault);
        let r = c
            .reconcile(&a.change, &op, id, control())
            .unwrap()
            .wait()
            .await
            .unwrap();
        assert_eq!(r.as_value()["outcome"]["kind"], expected);
        let handoff = owner.try_handoff().unwrap();
        if id == "large" {
            assert_eq!(
                handoff
                    .evidence
                    .native_receipt
                    .unwrap()
                    .receipt
                    .commit_version,
                projection::MAX_SAFE + 1
            );
            assert!(handoff.evidence.last_applied.is_none());
        }
    }
}
#[tokio::test]
async fn real_read_output_and_vm_budgets_return_failed_after_join() {
    let (owner, _dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
    for id in ["bytes", "vm"] {
        let mut ctl = control();
        if id == "bytes" {
            ctl.limits.max_output_bytes = 1;
        } else {
            ctl.limits.max_vm_steps = 1;
        }
        let h = c.reconcile(&a.change, &op, id, ctl).unwrap();
        let r = h.wait().await.unwrap();
        assert_eq!(r.as_value()["outcome"]["error"], "budgetExceeded");
        assert_eq!(
            c.state().reconciliation_phase,
            ReconciliationPhase::Completed
        );
        assert!(c.shared.core.lock().unwrap().supervisor.is_some());
    }
}
#[tokio::test]
async fn historical_receipt_and_new_apply_success_do_not_conflict_with_previous_success_pair() {
    let (owner, _dir) = fixtures::setup();
    let c = owner.client();
    let first = fixtures::paused(&c, "first").await;
    c.apply(&first.change, "first:apply", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
    let prior = c.state().last_applied.clone().unwrap();
    let mut second = fixtures::change("second").as_value().clone();
    second["apply"]["expectedAppliedRevision"] = json!(1.0);
    second["apply"]["desired"]["revision"] = json!(2.0);
    let change = RecordingChangeRequest::from_value(second).unwrap();
    let a = c.preflight(change, control()).unwrap();
    a.operation.wait().await.unwrap();
    c.pause_join(&a.change, "second:pause", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
    *c.shared.fault.lock().unwrap() = Some(mutation::TestFault::LostResponse);
    let op = c.apply(&a.change, "second:apply", control()).unwrap();
    op.wait().await.unwrap();
    // Advance the real ledger once more through the already owned store, as a later head.
    {
        let mut core = c.shared.core.lock().unwrap();
        let store = core
            .supervisor
            .as_mut()
            .unwrap()
            .host
            .store
            .as_mut()
            .unwrap();
        let mut later = core_apply(op.request());
        later.request_id = "later:apply".into();
        later.expected_applied_revision = Some(2);
        later.desired["revision"] = json!(3);
        store.apply_recording_plan(&later, &control()).unwrap();
    }
    let r = c
        .reconcile(&a.change, &op, "historical", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(r.as_value()["outcome"]["receipt"]["appliedRevision"], 2);
    assert_eq!(
        r.as_value()["request"]["operation"],
        *op.request().as_value()
    );
    assert_ne!(
        c.state().last_applied.as_ref().unwrap().request,
        prior.request
    );
    assert_eq!(
        c.state()
            .last_applied
            .as_ref()
            .unwrap()
            .receipt
            .applied_revision,
        2
    );
}
fn core_apply(op: &RecordingOperationRequest) -> ApplyRecordingPlanRequest {
    let change = RecordingChangeRequest::from_value(op.as_value()["change"].clone()).unwrap();
    projection::apply(&change).unwrap()
}
#[tokio::test]
async fn receipt_lookup_keeps_original_member_order_and_numeric_spelling() {
    let (owner, _dir) = fixtures::setup();
    let c = owner.client();
    let mut change = fixtures::change("members").as_value().clone();
    let first = change["apply"]["desired"]["group"]["members"][0].clone();
    let second = json!({"memberId":"member:second","externalName":"Other","valueType":"bool"});
    change["apply"]["desired"]["group"]["members"] = json!([second, first]);
    change["version"] = json!(1.0);
    change["apply"]["desired"]["group"]["periodMs"] = json!(1000.0);
    let a = c
        .preflight(
            RecordingChangeRequest::from_value(change).unwrap(),
            control(),
        )
        .unwrap();
    a.operation.wait().await.unwrap();
    c.pause_join(&a.change, "members:pause", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
    *c.shared.fault.lock().unwrap() = Some(mutation::TestFault::LostResponse);
    let op = c.apply(&a.change, "members:apply", control()).unwrap();
    op.wait().await.unwrap();
    let r = c
        .reconcile(&a.change, &op, "members:read", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(r.as_value()["outcome"]["kind"], "receiptFound");
    assert_eq!(
        r.as_value()["request"]["operation"],
        *op.request().as_value()
    );
    assert_eq!(
        r.as_value()["request"]["operation"]["change"]["apply"]["desired"]["group"]["members"][0]
            ["memberId"],
        "member:second"
    );
}
#[tokio::test]
async fn real_commit_then_worker_panic_found_never_proves_original_quiescence() {
    let (mut owner, _dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::CommitThenPanic).await;
    let original = op.wait().await.unwrap();
    assert_eq!(original.as_value()["quiescence"], "unknown");
    let r = c
        .reconcile(&a.change, &op, "committed", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(r.as_value()["outcome"]["kind"], "receiptFound");
    assert_eq!(r.as_value()["quiescence"], "unknown");
    let latest = c.state().latest.clone().unwrap();
    assert_eq!(latest.as_value()["outcome"]["kind"], "applied");
    assert_eq!(latest.as_value()["quiescence"], "unknown");
    assert_eq!(op.wait().await.unwrap(), original);
    assert!(matches!(owner.try_handoff(), Err(OwnerError::Busy)));
}
#[tokio::test]
async fn real_saved_receipt_corruption_never_becomes_not_found() {
    let (owner, dir) = fixtures::setup();
    let c = owner.client();
    let (a, op) = failed(&c, mutation::TestFault::LostResponse).await;
    c.reconcile(&a.change, &op, "known", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
    let known = c.state().latest.clone().unwrap();
    let db = rusqlite::Connection::open(dir.0.join("store.sqlite3")).unwrap();
    db.execute(
        "UPDATE recording_plan_applications SET receipt_json='{}'",
        [],
    )
    .unwrap();
    drop(db);
    let r = c
        .reconcile(&a.change, &op, "corrupt", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(r.as_value()["outcome"]["error"], "corruptData");
    assert_eq!(c.state().latest.as_ref().unwrap(), &known);
    assert!(c.state().recovery_required);
}
