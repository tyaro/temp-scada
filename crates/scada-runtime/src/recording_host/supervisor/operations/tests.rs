use super::*;
use crate::recording_host::retention::tests::control;
use crate::recording_host::{RecordingPhase, RecordingPlanTurnIntent};
use crate::recording_registry::RecordingRegistryOwnerSeed;
use serde_json::{json, Value};
use std::time::Duration;
pub(super) fn context() -> RecordingOperationsContext {
    let fixtures: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../examples/recording-operations-cases.json"
    )))
    .unwrap();
    let mut c = fixtures["bases"]["context"].clone();
    c["sessionId"] = json!("recording");
    RecordingOperationsContext::from_value(c).unwrap()
}
pub(super) fn change(id: &str) -> RecordingChangeRequest {
    let RecordingPlanTurnIntent::Apply(r) = super::super::tests::apply(&format!("apply:{id}"))
    else {
        unreachable!()
    };
    RecordingChangeRequest::from_value(json!({"version":1,"kind":"recordingChangeRequest","changeId":id,"context":context().as_value(),"apply":r})).unwrap()
}
pub(super) fn setup() -> (
    RecordingOperationsOwner,
    crate::recording_host::retention::tests::Directory,
) {
    let (s, dir) = super::super::tests::setup();
    let run = s.state().recording.run.clone().unwrap();
    (
        RecordingOperationsOwner::try_new(s, context(), run).unwrap(),
        dir,
    )
}
pub(super) async fn candidate(c: &RecordingOperationsClient, id: &str) -> AcceptedRecordingChange {
    let a = c.preflight(change(id), control()).unwrap();
    let r = a.operation.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["kind"], "candidate");
    a
}
pub(super) async fn paused(c: &RecordingOperationsClient, id: &str) -> AcceptedRecordingChange {
    let a = candidate(c, id).await;
    let h = c
        .pause_join(&a.change, &format!("pause:{id}"), control())
        .unwrap();
    assert_eq!(
        h.wait().await.unwrap().as_value()["outcome"]["kind"],
        "paused"
    );
    a
}
#[tokio::test]
async fn registry_seed_claims_only_a_pristine_unshared_native_owner() {
    let (root, _dir) = setup();
    let mut seed = RecordingRegistryOwnerSeed::try_from_owner(root).unwrap();
    let handoff = seed.try_handoff().unwrap();
    assert_eq!(
        handoff.supervisor.state().recording.phase,
        RecordingPhase::Joined
    );
}

#[tokio::test]
async fn registry_seed_refuses_even_a_dropped_external_client_and_returns_owner() {
    let (root, _dir) = setup();
    drop(root.client());
    let failure = RecordingRegistryOwnerSeed::try_from_owner(root)
        .err()
        .unwrap();
    assert_eq!(failure.reason, RegistryClaimReason::ClientAlreadyIssued);
    let mut recovered = failure.owner;
    assert!(recovered.try_handoff().is_ok());
}

#[tokio::test]
async fn registry_seed_busy_failure_does_not_claim_the_owner() {
    let (root, _dir) = setup();
    let shared = root.shared.clone();
    let guard = shared.core.lock().unwrap();
    let failure = RecordingRegistryOwnerSeed::try_from_owner(root)
        .err()
        .unwrap();
    assert_eq!(failure.reason, RegistryClaimReason::Busy);
    drop(guard);
    drop(shared);
    assert!(RecordingRegistryOwnerSeed::try_from_owner(failure.owner).is_ok());
}

#[tokio::test]
async fn registry_seed_refuses_an_owner_after_handoff() {
    let (mut root, _dir) = setup();
    let handoff = root.try_handoff().unwrap();
    let failure = RecordingRegistryOwnerSeed::try_from_owner(root)
        .err()
        .unwrap();
    assert_eq!(failure.reason, RegistryClaimReason::NotPristine);
    drop(handoff);
}
#[tokio::test]
async fn explicit_stages_return_the_native_owner_before_each_terminal_state() {
    let (mut root, _dir) = setup();
    let c = root.client();
    let a = candidate(&c, "first").await;
    assert_eq!(c.state().phase, OperationsPhase::Candidate);
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
    assert_eq!(
        c.apply(&a.change, "early", control()).unwrap_err().code,
        OperationErrorCode::PauseRequired
    );
    let p = c.pause_join(&a.change, "pause", control()).unwrap();
    assert_eq!(p.request_cancel(), CancelDisposition::NotSupported);
    p.wait().await.unwrap();
    assert_eq!(c.state().phase, OperationsPhase::Paused);
    let op = c.apply(&a.change, "apply", control()).unwrap();
    let r = op.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["kind"], "applied");
    assert_eq!(c.state().phase, OperationsPhase::Completed);
    assert_eq!(op.request_cancel(), CancelDisposition::AlreadyCompleted);
    assert!(c.state().last_applied.is_some());
    let h = root.try_handoff().unwrap();
    assert_eq!(h.supervisor.state().recording.phase, RecordingPhase::Joined);
    assert!(!h.evidence.owner_recovery_required);
    assert!(c.state().closed);
    assert_eq!(
        c.preflight(change("later"), control()).unwrap_err().code,
        OperationErrorCode::WrongOwner
    );
}
#[tokio::test]
async fn simultaneous_clone_calls_share_one_gate_and_never_queue() {
    let (root, _dir) = setup();
    let a = root.client();
    let b = a.clone();
    let first = a.preflight(change("a"), control()).unwrap();
    assert_eq!(
        b.preflight(change("b"), control()).unwrap_err().code,
        OperationErrorCode::Busy
    );
    let result = first.operation.wait().await.unwrap();
    assert_eq!(result.as_value()["outcome"]["kind"], "candidate");
    assert_eq!(
        b.state().request.as_ref().unwrap().as_value()["changeId"],
        "a"
    );
    assert_eq!(
        b.preflight(change("b"), control()).unwrap_err().code,
        OperationErrorCode::Busy
    );
}
#[tokio::test]
async fn foreign_handle_is_rejected_even_when_context_text_matches() {
    let (one, _a) = setup();
    let (two, _b) = setup();
    let a = candidate(&one.client(), "same").await;
    let b = candidate(&two.client(), "same").await;
    assert_eq!(
        one.client()
            .pause_join(&b.change, "pause", control())
            .unwrap_err()
            .code,
        OperationErrorCode::WrongOwner
    );
    one.client().discard(&a.change).unwrap();
    assert_eq!(one.client().state().phase, OperationsPhase::Idle);
}
#[tokio::test]
async fn discard_completes_synchronously_and_never_reuses_registered_ids() {
    let (root, _dir) = setup();
    let c = root.client();
    let a = candidate(&c, "old").await;
    c.discard(&a.change).unwrap();
    assert_eq!(c.state().phase, OperationsPhase::Idle);
    assert_eq!(
        c.preflight(change("old"), control()).unwrap_err().code,
        OperationErrorCode::Consumed
    );
    let a = paused(&c, "next").await;
    c.discard(&a.change).unwrap();
    assert_eq!(c.state().phase, OperationsPhase::Idle);
    let a = candidate(&c, "third").await;
    assert_eq!(
        c.pause_join(&a.change, "pause:next", control())
            .unwrap_err()
            .code,
        OperationErrorCode::Consumed
    );
    assert_eq!(c.state().phase, OperationsPhase::Candidate);
}
#[tokio::test]
async fn capacity_is_reserved_for_both_later_stages() {
    let (root, _dir) = setup();
    let c = root.client();
    {
        let mut core = c.shared.core.lock().unwrap();
        for n in 0..MAX_OWNER_IDS - 4 {
            core.registry.used.insert((true, format!("used:{n}")));
        }
    }
    let a = paused(&c, "last").await;
    let h = c.apply(&a.change, "last:apply", control()).unwrap();
    h.wait().await.unwrap();
    assert_eq!(
        c.preflight(change("full"), control()).unwrap_err().code,
        OperationErrorCode::BudgetExceeded
    );
    assert_eq!(
        c.shared.core.lock().unwrap().registry.used.len(),
        MAX_OWNER_IDS
    );
}
#[tokio::test]
async fn remaining_three_slots_refuse_before_registration_or_dispatch() {
    let (root, _dir) = setup();
    let c = root.client();
    {
        let mut core = c.shared.core.lock().unwrap();
        for n in 0..MAX_OWNER_IDS - 3 {
            core.registry.used.insert((true, format!("used:{n}")));
        }
    }
    assert_eq!(
        c.preflight(change("no-space"), control()).unwrap_err().code,
        OperationErrorCode::BudgetExceeded
    );
    assert_eq!(c.state().phase, OperationsPhase::Idle);
    assert!(c.state().active.is_none());
}
#[tokio::test]
async fn completion_is_retained_without_receivers_and_survives_client_drop() {
    let (root, _dir) = setup();
    let c = root.client();
    let a = c.preflight(change("detached"), control()).unwrap();
    drop(c);
    let clone = a.operation.clone();
    drop(a);
    let result = clone.wait().await.unwrap();
    let again = clone.wait().await.unwrap();
    assert!(Arc::ptr_eq(&result, &again));
    assert_eq!(root.client().state().phase, OperationsPhase::Candidate);
}
#[tokio::test]
async fn owner_drop_closes_clients_and_retains_an_inflight_result() {
    let (root, _dir) = setup();
    let c = root.client();
    let a = c.preflight(change("closing"), control()).unwrap();
    drop(root);
    let result = a.operation.wait().await.unwrap();
    assert!(c.state().closed);
    assert_eq!(result.as_value()["outcome"]["kind"], "failed");
    assert_eq!(
        c.preflight(change("later"), control()).unwrap_err().code,
        OperationErrorCode::WrongOwner
    );
}
#[tokio::test]
async fn invalid_control_and_invalid_stage_id_preserve_candidate_and_reserved_credit() {
    let (root, _dir) = setup();
    let c = root.client();
    let a = candidate(&c, "valid").await;
    let mut bad = control();
    bad.limits.max_decoded_rows = 9001;
    assert_eq!(
        c.pause_join(&a.change, "pause", bad).unwrap_err().code,
        OperationErrorCode::InvalidRequest
    );
    assert_eq!(
        c.pause_join(&a.change, "bad id", control())
            .unwrap_err()
            .code,
        OperationErrorCode::InvalidRequest
    );
    {
        let core = c.shared.core.lock().unwrap();
        assert_eq!(core.workflow.as_ref().unwrap().credits, 2);
    }
    let cancelled = control();
    cancelled.cancellation.cancel();
    assert_eq!(
        c.pause_join(&a.change, "pause", cancelled)
            .unwrap_err()
            .code,
        OperationErrorCode::Cancelled
    );
    let mut expired = control();
    expired.deadline = std::time::Instant::now();
    assert_eq!(
        c.pause_join(&a.change, "pause", expired).unwrap_err().code,
        OperationErrorCode::DeadlineExceeded
    );
    c.pause_join(&a.change, "pause", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
}
#[tokio::test]
async fn cancellation_after_acceptance_reports_no_dispatch_and_allows_a_new_preflight() {
    let (root, _dir) = setup();
    let c = root.client();
    let a = c.preflight(change("cancel"), control()).unwrap();
    assert_eq!(a.operation.request_cancel(), CancelDisposition::Requested);
    let r = a.operation.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["error"], "cancelled");
    assert!(!c.state().recovery_required);
    candidate(&c, "new").await;
}
#[tokio::test]
async fn original_request_numeric_spelling_and_member_order_are_echoed() {
    let (mut root, _dir) = setup();
    let c = root.client();
    let first = paused(&c, "first").await;
    c.apply(&first.change, "first:apply", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
    let mut value = change("numbers").as_value().clone();
    value["version"] = json!(1.0);
    value["apply"]["expectedAppliedRevision"] = json!(1.0);
    value["apply"]["desired"]["revision"] = json!(2.0);
    value["apply"]["desired"]["group"]["periodMs"] = json!(1000.0);
    value["context"]["target"]["projectRevision"] = json!(2.0);
    let members = value["apply"]["desired"]["group"]["members"]
        .as_array_mut()
        .unwrap();
    members.insert(
        0,
        json!({"memberId":"member:second","externalName":"Other","valueType":"bool"}),
    );
    let request = RecordingChangeRequest::from_value(value).unwrap();
    let original = request.clone();
    let accepted = c.preflight(request, control()).unwrap();
    let result = accepted.operation.wait().await.unwrap();
    assert_eq!(result.as_value()["request"]["change"], *original.as_value());
    assert_eq!(c.state().request.as_ref().unwrap(), &original);
    c.pause_join(&accepted.change, "numbers:pause", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
    let applied = c
        .apply(&accepted.change, "numbers:apply", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(
        applied.as_value()["request"]["change"],
        *original.as_value()
    );
    assert_eq!(
        applied.as_value()["outcome"]["receipt"]["appliedRevision"],
        2
    );
    let mut handoff = root.try_handoff().unwrap();
    let mut store = handoff.supervisor.take_store().unwrap();
    let native = store
        .recording_plan_state(&control())
        .unwrap()
        .applied
        .unwrap();
    assert_eq!(
        native.request.desired["group"]["members"][0]["memberId"],
        "member:0"
    );
    assert_eq!(
        original.as_value()["apply"]["desired"]["group"]["members"][0]["memberId"],
        "member:second"
    );
}
#[test]
fn init_without_runtime_preserves_supervisor_and_does_no_work() {
    let (s, _dir) = super::super::tests::setup();
    let run = s.state().recording.run.clone().unwrap();
    let error = match RecordingOperationsOwner::try_new(s, context(), run) {
        Err(e) => e,
        Ok(_) => panic!("requires runtime"),
    };
    assert_eq!(error.error, OwnerError::NoRuntime);
    assert_eq!(
        error.supervisor.state().preflight_phase,
        crate::recording_host::PreflightPhase::Idle
    );
}
#[tokio::test]
async fn new_owner_cannot_hide_an_owner_only_block_at_handoff() {
    let (mut root, _dir) = setup();
    let c = root.client();
    let a = candidate(&c, "old").await;
    let mut core = c.shared.core.lock().unwrap();
    core.recovery = true;
    core.phase = OperationsPhase::Blocked;
    core.latest = Some(projection::failed(
        a.operation.request(),
        OperationErrorCode::Internal,
        "notDispatched",
        true,
        true,
    ));
    c.shared.publish(&core);
    drop(core);
    let h = root.try_handoff().unwrap();
    assert!(h.evidence.owner_recovery_required);
    assert!(h.supervisor.recording_plan_guard_state().recovery_required);
    let run = h.supervisor.state().recording.run.clone().unwrap();
    assert!(RecordingOperationsOwner::try_new(h.supervisor, context(), run).is_err());
}
#[tokio::test]
async fn poison_and_missing_native_resources_never_become_idle() {
    let (mut root, _dir) = setup();
    let c = root.client();
    let shared = c.shared.clone();
    let _ = std::thread::spawn(move || {
        let _guard = shared.core.lock().unwrap();
        panic!("poison");
    })
    .join();
    assert_eq!(
        c.preflight(change("poison"), control()).unwrap_err().code,
        OperationErrorCode::Internal
    );
    assert!(matches!(root.try_handoff(), Err(OwnerError::Internal)));
}
#[tokio::test]
async fn wait_timeout_does_not_request_cancel() {
    let (root, _dir) = setup();
    let c = root.client();
    let a = c.preflight(change("wait"), control()).unwrap();
    let future = a.operation.wait();
    let _ = tokio::time::timeout(Duration::ZERO, future).await;
    let r = a.operation.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["kind"], "candidate");
    assert!(!a.operation.0.cancel.is_cancelled());
}

#[tokio::test]
async fn replay_never_becomes_a_current_apply_success_and_old_handles_keep_their_receipts() {
    let (mut root, dir) = setup();
    let c = root.client();
    let a = paused(&c, "first").await;
    let op = c.apply(&a.change, "first:apply", control()).unwrap();
    let applied = op.wait().await.unwrap();
    let original = c.state().last_applied.clone().unwrap();
    let mut second = change("second").as_value().clone();
    second["apply"]["expectedAppliedRevision"] = json!(1);
    second["apply"]["desired"]["revision"] = json!(2);
    let a = c
        .preflight(
            RecordingChangeRequest::from_value(second).unwrap(),
            control(),
        )
        .unwrap();
    a.operation.wait().await.unwrap();
    c.pause_join(&a.change, "second:pause", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
    c.apply(&a.change, "second:apply", control())
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(
        c.state()
            .last_applied
            .as_ref()
            .unwrap()
            .receipt
            .applied_revision,
        2
    );
    let mut replay = change("replay").as_value().clone();
    replay["apply"] = original.request.as_value()["change"]["apply"].clone();
    let a = c
        .preflight(
            RecordingChangeRequest::from_value(replay).unwrap(),
            control(),
        )
        .unwrap();
    assert_eq!(
        a.operation.wait().await.unwrap().as_value()["outcome"]["kind"],
        "replay"
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
    assert_eq!(op.wait().await.unwrap(), applied);
    drop(root.try_handoff().unwrap());
    drop(c);
    drop(dir);
}
#[tokio::test]
async fn native_start_rejection_after_acceptance_blocks_without_consuming_the_native_candidate() {
    let (mut root, _dir) = setup();
    let c = root.client();
    let a = paused(&c, "reject").await;
    *c.shared.fault.lock().unwrap() = Some(driver::TestFault::NativeReject);
    let op = c.apply(&a.change, "reject:apply", control()).unwrap();
    let r = op.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["effect"], "notDispatched");
    assert_eq!(r.as_value()["recoveryRequired"], true);
    assert_eq!(c.state().phase, OperationsPhase::Blocked);
    let h = root.try_handoff().unwrap();
    assert_eq!(
        h.supervisor.state().candidate_phase,
        Some(crate::recording_host::CandidatePhase::Paused)
    );
    assert!(h.supervisor.recording_plan_guard_state().recovery_required);
}
#[tokio::test]
async fn plan_worker_error_keeps_the_native_and_owner_recovery_gates() {
    for (fault, expected_receipt) in [
        (driver::TestFault::Full, false),
        (driver::TestFault::LostResponse, true),
    ] {
        let (mut root, _dir) = setup();
        let c = root.client();
        let a = paused(&c, "error").await;
        *c.shared.fault.lock().unwrap() = Some(fault);
        let op = c.apply(&a.change, "error:apply", control()).unwrap();
        let r = op.wait().await.unwrap();
        assert_eq!(r.as_value()["outcome"]["kind"], "failed");
        assert_eq!(r.as_value()["outcome"]["effect"], "unconfirmed");
        assert_eq!(r.as_value()["quiescence"], "confirmed");
        assert_eq!(r.as_value()["recoveryRequired"], true);
        assert_eq!(
            c.preflight(change("again"), control()).unwrap_err().code,
            OperationErrorCode::PlanRecoveryRequired
        );
        let mut h = root.try_handoff().unwrap();
        assert!(h.supervisor.recording_plan_guard_state().recovery_required);
        let mut store = h.supervisor.take_store().unwrap();
        let found = store
            .recording_plan_receipt("apply:error", &control())
            .unwrap();
        // The source FULL value is injected here; real FULL atomicity is tested in Historian.
        assert_eq!(found.is_some(), expected_receipt);
    }
}
#[tokio::test]
async fn worker_panic_and_stage_panic_do_not_release_an_uncertain_owner() {
    for fault in [
        driver::TestFault::WorkerPanic,
        driver::TestFault::DriverPanic,
    ] {
        let (mut root, _dir) = setup();
        let c = root.client();
        let a = paused(&c, "panic").await;
        *c.shared.fault.lock().unwrap() = Some(fault);
        let op = c.apply(&a.change, "panic:apply", control()).unwrap();
        let r = op.wait().await.unwrap();
        assert_eq!(r.as_value()["quiescence"], "unknown");
        assert_eq!(r.as_value()["recoveryRequired"], true);
        assert_eq!(c.state().phase, OperationsPhase::Uncertain);
        assert!(root.try_handoff().is_err());
        assert_eq!(
            c.preflight(change("again"), control()).unwrap_err().code,
            OperationErrorCode::PlanRecoveryRequired
        );
    }
}
#[tokio::test]
async fn successful_commit_survives_a_late_cancel() {
    let (root, _dir) = setup();
    let c = root.client();
    let a = paused(&c, "late").await;
    *c.shared.fault.lock().unwrap() = Some(driver::TestFault::LateCancel);
    let op = c.apply(&a.change, "late:apply", control()).unwrap();
    let r = op.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["kind"], "applied");
    assert!(op.0.cancel.is_cancelled());
    assert_eq!(op.request_cancel(), CancelDisposition::AlreadyCompleted);
    assert!(!c.state().recovery_required);
}
#[tokio::test]
async fn accepted_deadline_is_not_restarted_when_dispatch_is_delayed() {
    let (root, _dir) = setup();
    let c = root.client();
    let gate = Arc::new(driver::TestGate::default());
    *c.shared.fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    let request = change("deadline");
    let mut control = control();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    control.deadline = deadline;
    let a = c.preflight(request, control).unwrap();
    gate.entered.notified().await;
    tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
    gate.release.notify_one();
    let r = a.operation.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["error"], "deadlineExceeded");
    assert_eq!(r.as_value()["outcome"]["effect"], "notDispatched");
    assert!(!c.state().recovery_required);
}
#[tokio::test]
async fn receipt_projection_overflow_keeps_native_evidence_and_latches_handoff() {
    let (mut root, dir) = setup();
    let c = root.client();
    let a = paused(&c, "large").await;
    let db = rusqlite::Connection::open(dir.0.join("store.sqlite3")).unwrap();
    db.execute(
        "UPDATE store_meta SET last_commit=?1",
        [projection::MAX_SAFE as i64],
    )
    .unwrap();
    drop(db);
    let op = c.apply(&a.change, "large:apply", control()).unwrap();
    let r = op.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["error"], "projectionFailed");
    assert_eq!(r.as_value()["quiescence"], "confirmed");
    assert!(c.state().last_applied.is_none());
    let h = root.try_handoff().unwrap();
    assert_eq!(
        h.evidence.native_receipt.unwrap().receipt.commit_version,
        projection::MAX_SAFE + 1
    );
    assert!(h.supervisor.recording_plan_guard_state().recovery_required);
}

#[tokio::test]
async fn racing_threads_accept_exactly_one_workflow() {
    let (root, _dir) = setup();
    let c = root.client();
    let a = c.clone();
    let b = c.clone();
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let left = change("left");
    let right = change("right");
    let one = barrier.clone();
    let two = barrier.clone();
    let l = std::thread::spawn(move || {
        one.wait();
        a.preflight(left, control())
    });
    let r = std::thread::spawn(move || {
        two.wait();
        b.preflight(right, control())
    });
    barrier.wait();
    let l = l.join().unwrap();
    let r = r.join().unwrap();
    assert_ne!(l.is_ok(), r.is_ok());
    let accepted = if let Ok(v) = l { v } else { r.unwrap() };
    accepted.operation.wait().await.unwrap();
    assert_eq!(c.state().phase, OperationsPhase::Candidate);
}
#[test]
fn runtime_shutdown_keeps_an_unpolled_stage_uncertain_instead_of_dropping_its_request() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (root, _dir) = runtime.block_on(async { setup() });
    let c = root.client();
    // The runtime is alive but is not polling tasks during this synchronous call.
    let a = c.preflight(change("runtime-end"), control()).unwrap();
    drop(runtime);
    let r = a
        .operation
        .watch()
        .borrow()
        .clone()
        .expect("Drop guard publishes failure without a live runtime");
    assert_eq!(r.as_value()["quiescence"], "unknown");
    assert_eq!(r.as_value()["recoveryRequired"], true);
    assert!(c.state().active.is_some());
    assert_eq!(
        c.preflight(change("later"), control()).unwrap_err().code,
        OperationErrorCode::PlanRecoveryRequired
    );
    drop(root);
}
#[tokio::test]
async fn owner_drop_waits_for_loan_cleanup_and_does_not_release_the_writer_early() {
    let (root, dir) = setup();
    let c = root.client();
    let gate = Arc::new(driver::TestGate::default());
    *c.shared.fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    let a = c.preflight(change("retained"), control()).unwrap();
    gate.entered.notified().await;
    drop(root);
    assert!(matches!(
        scada_historian::store::SqliteStore::open_existing(
            &dir.0,
            &crate::recording_host::retention::tests::identity()
        ),
        Err(scada_historian::store::StoreError::Busy)
    ));
    assert!(a.operation.watch().borrow().is_none());
    gate.release.notify_one();
    a.operation.wait().await.unwrap();
    assert!(c.state().closed);
}
#[tokio::test]
async fn source_shutdown_failure_never_becomes_a_successful_pause() {
    let (mut root, _dir) = setup();
    let c = root.client();
    let a = candidate(&c, "source").await;
    {
        let mut core = c.shared.core.lock().unwrap();
        let s = core.supervisor.as_mut().unwrap();
        Arc::get_mut(s.host.completion.as_mut().unwrap())
            .unwrap()
            .source_shutdown = Err(banto_tagclient::ErrorKind::Transport);
        s.host.status.send_modify(|v| {
            Arc::make_mut(v).source_shutdown = Some(Err(banto_tagclient::ErrorKind::Transport))
        });
    }
    let op = c.pause_join(&a.change, "source:pause", control()).unwrap();
    let r = op.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["kind"], "failed");
    assert_eq!(r.as_value()["recoveryRequired"], true);
    assert_eq!(c.state().phase, OperationsPhase::Uncertain);
    assert_eq!(
        c.apply(&a.change, "source:apply", control())
            .unwrap_err()
            .code,
        OperationErrorCode::PlanRecoveryRequired
    );
    assert!(root.try_handoff().is_err());
}
#[tokio::test]
async fn cas_conflict_after_candidate_cannot_replace_the_original_immutable_apply() {
    let (mut root, _dir) = setup();
    let c = root.client();
    let a = paused(&c, "original").await;
    {
        let mut core = c.shared.core.lock().unwrap();
        let s = core.supervisor.as_mut().unwrap();
        let RecordingPlanTurnIntent::Apply(request) = super::super::tests::apply("competing")
        else {
            unreachable!()
        };
        s.host
            .store
            .as_mut()
            .unwrap()
            .apply_recording_plan(&request, &control())
            .unwrap();
    }
    let op = c.apply(&a.change, "original:apply", control()).unwrap();
    let r = op.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["error"], "conflict");
    assert_eq!(
        r.as_value()["request"]["change"],
        *change("original").as_value()
    );
    let mut h = root.try_handoff().unwrap();
    assert!(h.supervisor.recording_plan_guard_state().recovery_required);
    let mut store = h.supervisor.take_store().unwrap();
    assert!(store
        .recording_plan_receipt("apply:original", &control())
        .unwrap()
        .is_none());
    assert!(store
        .recording_plan_receipt("competing", &control())
        .unwrap()
        .is_some());
}
#[tokio::test]
async fn context_mismatch_and_ineligible_init_return_the_original_owner() {
    let (s, _dir) = super::super::tests::setup();
    let run = s.state().recording.run.clone().unwrap();
    let mut ctx = context().as_value().clone();
    ctx["sessionId"] = json!("other");
    let err = match RecordingOperationsOwner::try_new(
        s,
        RecordingOperationsContext::from_value(ctx).unwrap(),
        run,
    ) {
        Err(e) => e,
        Ok(_) => panic!(),
    };
    assert_eq!(err.error, OwnerError::InvalidContext);
    assert_eq!(
        err.supervisor.state().recording.session_id.as_deref(),
        Some("recording")
    );
    let (mut s, _dir) = super::super::tests::setup();
    let run = s.state().recording.run.clone().unwrap();
    s.latch_recording_operations_recovery();
    let err = match RecordingOperationsOwner::try_new(s, context(), run) {
        Err(e) => e,
        Ok(_) => panic!(),
    };
    assert_eq!(err.error, OwnerError::RecoveryRequired);
    assert!(
        err.supervisor
            .recording_plan_guard_state()
            .recovery_required
    );
}
#[tokio::test]
async fn state_poison_during_a_loan_closes_the_owner_and_preserves_a_finite_completion() {
    let (root, _dir) = setup();
    let c = root.client();
    let gate = Arc::new(driver::TestGate::default());
    *c.shared.fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    let a = c.preflight(change("poison-active"), control()).unwrap();
    gate.entered.notified().await;
    let shared = c.shared.clone();
    let _ = std::thread::spawn(move || {
        let _guard = shared.core.lock().unwrap();
        panic!("state fault");
    })
    .join();
    gate.release.notify_one();
    let result = a.operation.wait().await.unwrap();
    assert_eq!(result.as_value()["recoveryRequired"], true);
    assert!(c.state().closed);
    assert!(c.state().recovery_required);
}
