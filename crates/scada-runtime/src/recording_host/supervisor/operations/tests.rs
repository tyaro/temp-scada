use super::*;
use crate::recording_host::retention::tests::control;
use crate::recording_host::{RecordingOptions, RecordingPhase, RecordingPlanTurnIntent};
use crate::recording_registry::{
    ApplyDispatchFault, ApplyRegistration, DiscardDispatchFault, DiscardRegistration, LeaseError,
    LeaseRole, PauseDispatchFault, PauseRegistration, PreflightRegistration,
    ReconciliationRegistration, RecordingRegistryAdmissionTicket, RecordingRegistryOwnerSeed,
    RecordingRegistryPauseTicket, RecordingRegistryRoot, RecordingRegistrySession,
    RecordingRegistryWorkflowTicket, TestDispatchFault,
};
use futures_util::SinkExt;
use scada_historian::store::{Source, SqliteStore, StoreIdentity};
use scada_model::recording_admission::{
    RecordingAdmissionInspectionReply, RecordingAdmissionInspectionRequest,
    RecordingAdmissionReply, RecordingAdmissionRequest,
};
use scada_model::recording_wire::{RecordingWireLeaseReply, RecordingWireLeaseRequest};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tokio_tungstenite::tungstenite::Message;

mod registry_observation;
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

fn registry_scope(epoch: &str) -> Value {
    json!({"ownerRef":"native-owner", "ownerEpoch":epoch, "context":context().as_value()})
}

fn registry_lease(
    scope: &Value,
    id: &str,
    admission: &str,
    role: &str,
    budget: u64,
) -> RecordingWireLeaseRequest {
    RecordingWireLeaseRequest::from_value(json!({
        "version":1, "kind":"recordingWireLeaseRequest", "scope":scope,
        "leaseRequestId":id, "admissionId":admission, "role":role,
        "requestedBudgetMs":budget
    }))
    .unwrap()
}

fn registry_preflight(
    scope: &Value,
    change: &RecordingChangeRequest,
    admission: &str,
    lease: &RecordingWireLeaseReply,
) -> RecordingAdmissionRequest {
    RecordingAdmissionRequest::from_value(json!({
        "version":1, "kind":"recordingAdmissionRequest", "ownerRef":scope["ownerRef"],
        "admissionId":admission, "context":scope["context"],
        "deadlineLeaseRef":lease.as_value()["outcome"]["deadlineLeaseRef"],
        "action":{"kind":"preflight", "change":change.as_value()}
    }))
    .unwrap()
}

fn registry_pause_admission(
    scope: &Value,
    change: &RecordingChangeRequest,
    admission: &str,
    lease: &RecordingWireLeaseReply,
    change_ref: &str,
    operation_id: &str,
) -> RecordingAdmissionRequest {
    RecordingAdmissionRequest::from_value(json!({
        "version":1, "kind":"recordingAdmissionRequest", "ownerRef":scope["ownerRef"],
        "admissionId":admission, "context":scope["context"],
        "deadlineLeaseRef":lease.as_value()["outcome"]["deadlineLeaseRef"],
        "action":{"kind":"pauseJoin", "changeRef":change_ref,
            "operation":{"version":1,"kind":"recordingOperationRequest",
                "operationId":operation_id,"stage":"pauseJoin","change":change.as_value()}}
    }))
    .unwrap()
}

fn registry_apply_admission(
    scope: &Value,
    change: &RecordingChangeRequest,
    admission: &str,
    lease: &RecordingWireLeaseReply,
    change_ref: &str,
    operation_id: &str,
) -> RecordingAdmissionRequest {
    RecordingAdmissionRequest::from_value(json!({
        "version":1, "kind":"recordingAdmissionRequest", "ownerRef":scope["ownerRef"],
        "admissionId":admission, "context":scope["context"],
        "deadlineLeaseRef":lease.as_value()["outcome"]["deadlineLeaseRef"],
        "action":{"kind":"apply", "changeRef":change_ref,
            "operation":{"version":1,"kind":"recordingOperationRequest",
                "operationId":operation_id,"stage":"apply","change":change.as_value()}}
    }))
    .unwrap()
}

fn registry_reconciliation_admission(
    scope: &Value,
    apply: &RecordingAdmissionRequest,
    admission: &str,
    lease: &RecordingWireLeaseReply,
    change_ref: &str,
    operation_ref: &str,
) -> RecordingAdmissionRequest {
    RecordingAdmissionRequest::from_value(json!({
        "version":1, "kind":"recordingAdmissionRequest", "ownerRef":scope["ownerRef"],
        "admissionId":admission, "context":scope["context"],
        "deadlineLeaseRef":lease.as_value()["outcome"]["deadlineLeaseRef"],
        "action":{"kind":"reconcile", "changeRef":change_ref,
            "operationRef":operation_ref,
            "reconciliation":{"version":1,"kind":"recordingReconciliationRequest",
                "reconciliationId":"read:original-apply",
                "operation":apply.as_value()["action"]["operation"]}}
    }))
    .unwrap()
}

fn registry_discard_admission(
    scope: &Value,
    change: &RecordingChangeRequest,
    admission: &str,
    lease: &RecordingWireLeaseReply,
    change_ref: &str,
) -> RecordingAdmissionRequest {
    RecordingAdmissionRequest::from_value(json!({
        "version":1, "kind":"recordingAdmissionRequest", "ownerRef":scope["ownerRef"],
        "admissionId":admission, "context":scope["context"],
        "deadlineLeaseRef":lease.as_value()["outcome"]["deadlineLeaseRef"],
        "action":{"kind":"discard", "changeRef":change_ref, "change":change.as_value()}
    }))
    .unwrap()
}

async fn ready_pause_registry(
    epoch: &str,
    pause_budget_ms: u64,
) -> (
    RecordingRegistryRoot,
    RecordingRegistrySession,
    RecordingRegistryWorkflowTicket,
    RecordingRegistryAdmissionTicket,
    RecordingAdmissionRequest,
    crate::recording_host::retention::tests::Directory,
) {
    let (owner, dir) = setup();
    let scope = registry_scope(epoch);
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let session = root.test_session("alice", LeaseRole::Mutation);
    let change = change("pause-ready");
    let workflow = root.reserve_workflow(&session, change.clone()).unwrap();
    let lease = root
        .issue_preflight_lease(
            &session,
            &workflow,
            registry_lease(
                &scope,
                "preflight-lease",
                "preflight-admission",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    let preflight = match root
        .register_preflight(
            &session,
            &workflow,
            registry_preflight(&scope, &change, "preflight-admission", &lease),
        )
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new preflight"),
    };
    let accepted = root.dispatch_preflight(&session, &preflight).unwrap();
    for _ in 0..100 {
        if root
            .preflight_completion(&session, &preflight)
            .unwrap()
            .is_some()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        root.preflight_completion(&session, &preflight)
            .unwrap()
            .unwrap()
            .as_value()["outcome"]["kind"],
        "candidate"
    );
    let change_ref = accepted.as_value()["outcome"]["handle"]["changeRef"]
        .as_str()
        .unwrap();
    let pause_lease = root
        .issue_pause_join_lease(
            &session,
            &workflow,
            &preflight,
            "pause:ready",
            registry_lease(
                &scope,
                "pause-lease",
                "pause-admission",
                "mutation",
                pause_budget_ms,
            ),
        )
        .unwrap();
    let admission = registry_pause_admission(
        &scope,
        &change,
        "pause-admission",
        &pause_lease,
        change_ref,
        "pause:ready",
    );
    (root, session, workflow, preflight, admission, dir)
}

async fn ready_discard_candidate_registry(
    epoch: &str,
) -> (
    RecordingRegistryRoot,
    RecordingRegistrySession,
    RecordingRegistryWorkflowTicket,
    RecordingRegistryAdmissionTicket,
    RecordingAdmissionReply,
    crate::recording_host::retention::tests::Directory,
) {
    let (owner, dir) = setup();
    let scope = registry_scope(epoch);
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let session = root.test_session("alice", LeaseRole::Mutation);
    let change = change("pause-ready");
    let workflow = root.reserve_workflow(&session, change.clone()).unwrap();
    let lease = root
        .issue_preflight_lease(
            &session,
            &workflow,
            registry_lease(
                &scope,
                "preflight-lease",
                "preflight-admission",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    let preflight = match root
        .register_preflight(
            &session,
            &workflow,
            registry_preflight(&scope, &change, "preflight-admission", &lease),
        )
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new preflight"),
    };
    let accepted = root.dispatch_preflight(&session, &preflight).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while root
            .preflight_completion(&session, &preflight)
            .unwrap()
            .is_none()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        root.preflight_completion(&session, &preflight)
            .unwrap()
            .unwrap()
            .as_value()["outcome"]["kind"],
        "candidate"
    );
    (root, session, workflow, preflight, accepted, dir)
}

async fn ready_apply_registry(
    epoch: &str,
    apply_budget_ms: u64,
) -> (
    RecordingRegistryRoot,
    RecordingRegistrySession,
    RecordingRegistryWorkflowTicket,
    RecordingRegistryPauseTicket,
    RecordingAdmissionRequest,
    crate::recording_host::retention::tests::Directory,
) {
    let (mut root, session, workflow, preflight, pause_admission, dir) =
        ready_pause_registry(epoch, 1000).await;
    let pause = match root
        .register_pause_join(&session, &workflow, &preflight, pause_admission)
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("new pause"),
    };
    let accepted = root.dispatch_pause_join(&session, &pause).unwrap();
    assert_eq!(accepted.as_value()["outcome"]["kind"], "accepted");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if root.pause_completion(&session, &pause).unwrap().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let scope = registry_scope(epoch);
    let change = change("pause-ready");
    let lease = root
        .issue_apply_lease(
            &session,
            &workflow,
            &pause,
            "apply:ready",
            registry_lease(
                &scope,
                "apply-lease",
                "apply-admission",
                "mutation",
                apply_budget_ms,
            ),
        )
        .unwrap();
    let change_ref = accepted.as_value()["outcome"]["handle"]["changeRef"]
        .as_str()
        .unwrap();
    let admission = registry_apply_admission(
        &scope,
        &change,
        "apply-admission",
        &lease,
        change_ref,
        "apply:ready",
    );
    (root, session, workflow, pause, admission, dir)
}

fn sqlite_applied_revision(directory: &Path) -> i64 {
    let db = rusqlite::Connection::open_with_flags(
        directory.join("store.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    db.query_row(
        "SELECT COALESCE(applied_revision, 0) FROM recording_plan_state WHERE singleton=1",
        [],
        |row| row.get(0),
    )
    .unwrap()
}

#[tokio::test]
async fn registry_apply_admission_consumes_lease_and_dispatches_one_native_commit() {
    let (mut root, session, workflow, pause, admission, dir) =
        ready_apply_registry("epoch-apply-dispatch", 1000).await;
    let bob = root.test_session("bob", LeaseRole::Mutation);
    let mut wrong = admission.as_value().clone();
    wrong["action"]["operation"]["operationId"] = json!("other:apply");
    assert!(matches!(
        root.register_apply(
            &session,
            &workflow,
            &pause,
            RecordingAdmissionRequest::from_value(wrong).unwrap(),
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    assert!(matches!(
        root.register_apply(&bob, &workflow, &pause, admission.clone()),
        Err(LeaseError::Forbidden)
    ));
    let mut wrong_stage = admission.as_value().clone();
    wrong_stage["action"]["kind"] = json!("pauseJoin");
    wrong_stage["action"]["operation"]["stage"] = json!("pauseJoin");
    assert!(matches!(
        root.register_apply(
            &session,
            &workflow,
            &pause,
            RecordingAdmissionRequest::from_value(wrong_stage).unwrap()
        ),
        Err(LeaseError::Forbidden)
    ));
    let mut alternate = admission.as_value().clone();
    alternate["action"]["operation"]["change"]["apply"]["desired"]["revision"] = json!(1.0);
    let alternate = RecordingAdmissionRequest::from_value(alternate).unwrap();
    let client = root.test_native_client();
    let before = sqlite_applied_revision(&dir.0);
    let used_before = client.shared.core.lock().unwrap().registry.used.len();
    let bytes = root.test_used_bytes(LeaseRole::Mutation);
    let ticket = match root
        .register_apply(&session, &workflow, &pause, alternate.clone())
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    assert_eq!(root.test_lease_consumed("apply-lease"), Some(true));
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
    assert_eq!(sqlite_applied_revision(&dir.0), before);
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 0);
    assert_eq!(
        client.shared.core.lock().unwrap().registry.used.len(),
        used_before
    );
    assert!(matches!(
        root.register_apply_at(
            &session,
            &workflow,
            &pause,
            admission.clone(),
            Instant::now() + Duration::from_secs(2),
        )
        .unwrap(),
        ApplyRegistration::Existing(_)
    ));
    let reply = root.dispatch_apply(&session, &ticket).unwrap();
    assert_eq!(reply.as_value()["outcome"]["kind"], "accepted");
    assert_eq!(reply.as_value()["request"], *alternate.as_value());
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert_eq!(
        client.shared.core.lock().unwrap().registry.used.len(),
        used_before + 1
    );
    let completion = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(result) = root.apply_completion(&session, &ticket).unwrap() {
                break result;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(completion.as_value()["outcome"]["kind"], "applied");
    assert_eq!(
        completion.as_value()["outcome"]["receipt"]["appliedRevision"],
        before + 1
    );
    assert_eq!(sqlite_applied_revision(&dir.0), before + 1);
    assert_eq!(
        root.apply_reply(&session, &ticket).unwrap(),
        Some(reply.clone())
    );
    assert_eq!(root.dispatch_apply(&session, &ticket).unwrap(), reply);
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert_eq!(
        client.shared.core.lock().unwrap().registry.used.len(),
        used_before + 1
    );
    assert_eq!(sqlite_applied_revision(&dir.0), before + 1);
    assert!(matches!(
        root.apply_reply(&bob, &ticket),
        Err(LeaseError::Forbidden)
    ));
    let mut conflicting = admission.as_value().clone();
    conflicting["deadlineLeaseRef"] = json!("different-lease");
    assert!(matches!(
        root.register_apply(
            &session,
            &workflow,
            &pause,
            RecordingAdmissionRequest::from_value(conflicting).unwrap()
        ),
        Err(LeaseError::ProtocolViolation)
    ));
}

#[tokio::test]
async fn registry_apply_admission_expiry_does_not_call_native_or_change_sqlite() {
    let (mut root, session, workflow, pause, admission, dir) =
        ready_apply_registry("epoch-apply-expiry", 2000).await;
    let client = root.test_native_client();
    let before = sqlite_applied_revision(&dir.0);
    let used_before = client.shared.core.lock().unwrap().registry.used.len();
    assert!(matches!(
        root.register_apply_at(
            &session,
            &workflow,
            &pause,
            admission.clone(),
            Instant::now() + Duration::from_secs(2),
        ),
        Err(LeaseError::Expired)
    ));
    assert_eq!(root.test_lease_consumed("apply-lease"), Some(false));
    let ticket = match root
        .register_apply(&session, &workflow, &pause, admission)
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    tokio::time::sleep(Duration::from_millis(2100)).await;
    let reply = root.dispatch_apply(&session, &ticket).unwrap();
    assert_eq!(reply.as_value()["outcome"]["kind"], "rejected");
    assert_eq!(reply.as_value()["outcome"]["error"], "deadlineExceeded");
    assert_eq!(root.dispatch_apply(&session, &ticket).unwrap(), reply);
    assert!(root.apply_completion(&session, &ticket).unwrap().is_none());
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 0);
    assert_eq!(
        client.shared.core.lock().unwrap().registry.used.len(),
        used_before
    );
    assert_eq!(sqlite_applied_revision(&dir.0), before);
}

#[tokio::test]
async fn registry_apply_admission_keeps_unknown_after_projection_or_native_panic() {
    for (epoch, fault, has_handle) in [
        (
            "epoch-apply-projection",
            ApplyDispatchFault::ProjectionPanic,
            true,
        ),
        (
            "epoch-apply-native-panic",
            ApplyDispatchFault::NativePanicAfterCall,
            false,
        ),
    ] {
        let (mut root, session, workflow, pause, admission, dir) =
            ready_apply_registry(epoch, 1000).await;
        let client = root.test_native_client();
        let before = sqlite_applied_revision(&dir.0);
        let used_before = client.shared.core.lock().unwrap().registry.used.len();
        let ticket = match root
            .register_apply(&session, &workflow, &pause, admission)
            .unwrap()
        {
            ApplyRegistration::Registered(ticket) => ticket,
            _ => panic!("new apply"),
        };
        root.test_set_apply_dispatch_fault(&session, &ticket, fault);
        let unknown = root.dispatch_apply(&session, &ticket).unwrap();
        assert_eq!(unknown.as_value()["outcome"]["kind"], "unknown");
        assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
        assert_eq!(
            root.apply_reply(&session, &ticket).unwrap(),
            Some(unknown.clone())
        );
        assert_eq!(
            client.shared.core.lock().unwrap().registry.used.len(),
            used_before + 1
        );
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if client.state().phase != OperationsPhase::Applying {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(sqlite_applied_revision(&dir.0), before + 1);
        assert_eq!(
            root.apply_completion(&session, &ticket).unwrap().is_some(),
            has_handle
        );
        assert_eq!(root.dispatch_apply(&session, &ticket).unwrap(), unknown);
        assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
        assert_eq!(
            client.shared.core.lock().unwrap().registry.used.len(),
            used_before + 1
        );
        assert_eq!(sqlite_applied_revision(&dir.0), before + 1);
        assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
    }
}

#[tokio::test]
async fn registry_apply_admission_distinguishes_committed_loss_from_failed_write() {
    for (epoch, fault, committed) in [
        ("epoch-apply-lost", driver::TestFault::LostResponse, true),
        ("epoch-apply-full", driver::TestFault::Full, false),
    ] {
        let (mut root, session, workflow, pause, admission, dir) =
            ready_apply_registry(epoch, 1000).await;
        let client = root.test_native_client();
        let before = sqlite_applied_revision(&dir.0);
        let used_before = client.shared.core.lock().unwrap().registry.used.len();
        let ticket = match root
            .register_apply(&session, &workflow, &pause, admission)
            .unwrap()
        {
            ApplyRegistration::Registered(ticket) => ticket,
            _ => panic!("new apply"),
        };
        *client.shared.fault.lock().unwrap() = Some(fault);
        let accepted = root.dispatch_apply(&session, &ticket).unwrap();
        assert_eq!(accepted.as_value()["outcome"]["kind"], "accepted");
        assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
        let completion = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(result) = root.apply_completion(&session, &ticket).unwrap() {
                    break result;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(completion.as_value()["outcome"]["kind"], "failed");
        assert_eq!(completion.as_value()["outcome"]["effect"], "unconfirmed");
        assert_eq!(completion.as_value()["recoveryRequired"], true);
        assert_eq!(
            sqlite_applied_revision(&dir.0),
            before + i64::from(committed)
        );
        assert_eq!(
            root.apply_reply(&session, &ticket).unwrap(),
            Some(accepted.clone())
        );
        assert_eq!(root.dispatch_apply(&session, &ticket).unwrap(), accepted);
        assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
        assert_eq!(
            client.shared.core.lock().unwrap().registry.used.len(),
            used_before + 1
        );
        assert_eq!(
            sqlite_applied_revision(&dir.0),
            before + i64::from(committed)
        );
    }
}

#[tokio::test]
async fn registry_apply_admission_commit_then_panic_preserves_unknown_quiescence() {
    let (mut root, session, workflow, pause, admission, dir) =
        ready_apply_registry("epoch-apply-commit-panic", 1000).await;
    let client = root.test_native_client();
    let before = sqlite_applied_revision(&dir.0);
    let used_before = client.shared.core.lock().unwrap().registry.used.len();
    let ticket = match root
        .register_apply(&session, &workflow, &pause, admission)
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::CommitThenPanic);
    let accepted = root.dispatch_apply(&session, &ticket).unwrap();
    assert_eq!(accepted.as_value()["outcome"]["kind"], "accepted");
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    let completion = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(result) = root.apply_completion(&session, &ticket).unwrap() {
                break result;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(completion.as_value()["quiescence"], "unknown");
    assert_eq!(completion.as_value()["recoveryRequired"], true);
    assert_eq!(sqlite_applied_revision(&dir.0), before + 1);
    assert_eq!(
        root.apply_reply(&session, &ticket).unwrap(),
        Some(accepted.clone())
    );
    assert_eq!(root.dispatch_apply(&session, &ticket).unwrap(), accepted);
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert_eq!(
        client.shared.core.lock().unwrap().registry.used.len(),
        used_before + 1
    );
    assert_eq!(sqlite_applied_revision(&dir.0), before + 1);
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
}

#[tokio::test]
async fn registry_apply_admission_typed_native_rejection_does_not_claim_apply_id() {
    let (mut root, session, workflow, pause, admission, dir) =
        ready_apply_registry("epoch-apply-rejection", 1000).await;
    let client = root.test_native_client();
    let before = sqlite_applied_revision(&dir.0);
    let used_before = client.shared.core.lock().unwrap().registry.used.len();
    let ticket = match root
        .register_apply(&session, &workflow, &pause, admission)
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    {
        let mut core = client.shared.core.lock().unwrap();
        core.recovery = true;
    }
    let rejected = root.dispatch_apply(&session, &ticket).unwrap();
    assert_eq!(rejected.as_value()["outcome"]["kind"], "rejected");
    assert_eq!(
        rejected.as_value()["outcome"]["error"],
        "planRecoveryRequired"
    );
    assert_eq!(root.dispatch_apply(&session, &ticket).unwrap(), rejected);
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert!(root.apply_completion(&session, &ticket).unwrap().is_none());
    assert_eq!(
        client.shared.core.lock().unwrap().registry.used.len(),
        used_before
    );
    assert_eq!(sqlite_applied_revision(&dir.0), before);
}

fn registry_inspection(
    original: &RecordingAdmissionRequest,
    id: &str,
) -> RecordingAdmissionInspectionRequest {
    RecordingAdmissionInspectionRequest::from_value(json!({
        "version":1, "kind":"recordingAdmissionInspectionRequest",
        "inspectionId":id, "original":original.as_value()
    }))
    .unwrap()
}

#[tokio::test]
async fn registry_root_matches_native_context_and_returns_seed_on_failure() {
    let (owner, _dir) = setup();
    let seed = RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap();
    let mut foreign = registry_scope("epoch-1");
    foreign["context"]["sessionId"] = json!("other");
    let failure = RecordingRegistryRoot::try_new(seed, foreign).err().unwrap();
    assert_eq!(failure.error, LeaseError::InvalidInput);
    let mut root = RecordingRegistryRoot::try_new(failure.seed, registry_scope("epoch-1"))
        .ok()
        .unwrap();
    assert!(root.try_handoff().is_ok());
}

#[tokio::test]
async fn registry_root_refuses_a_seed_after_native_handoff() {
    let (owner, _dir) = setup();
    let mut seed = RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap();
    let handoff = seed.try_handoff().unwrap();
    let failure = RecordingRegistryRoot::try_new(seed, registry_scope("epoch-1"))
        .err()
        .unwrap();
    assert_eq!(failure.error, LeaseError::Forbidden);
    drop(handoff);
}

#[tokio::test]
async fn registry_lease_accepts_equivalent_json_numbers() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-1");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let session = root.test_session("alice", LeaseRole::Mutation);
    let mut equivalent = scope;
    equivalent["context"]["version"] = json!(1.0);
    let request = RecordingWireLeaseRequest::from_value(json!({
        "version":1, "kind":"recordingWireLeaseRequest", "scope":equivalent,
        "leaseRequestId":"lease-1", "admissionId":"admission-1", "role":"mutation",
        "requestedBudgetMs":1.0
    }))
    .unwrap();
    let first = root.issue_lease(&session, request.clone()).unwrap();
    assert_eq!(
        root.issue_lease(&session, request).unwrap().as_value(),
        first.as_value()
    );
}

#[tokio::test]
async fn registry_lease_byte_budget_accepts_exact_and_rejects_one_short_atomically() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-1");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let now = std::time::Instant::now();
    for (role, name) in [
        (LeaseRole::Mutation, "mutation"),
        (LeaseRole::Reconciliation, "reconciliation"),
    ] {
        let session = root.test_session("alice", role);
        root.issue_lease_at(
            &session,
            registry_lease(
                &scope,
                &format!("{name}-1"),
                &format!("admission-{name}-1"),
                name,
                1,
            ),
            now,
        )
        .unwrap();
        let one = root.test_used_bytes(role);
        let second = registry_lease(
            &scope,
            &format!("{name}-2"),
            &format!("admission-{name}-2"),
            name,
            1,
        );
        root.test_set_byte_limit(role, one * 2 - 1);
        assert_eq!(
            root.issue_lease_at(&session, second.clone(), now),
            Err(LeaseError::Capacity)
        );
        assert_eq!(root.test_used_bytes(role), one);
        root.test_set_byte_limit(role, one * 2);
        let reply = root.issue_lease_at(&session, second, now).unwrap();
        assert_eq!(
            reply.as_value()["outcome"]["deadlineLeaseRef"],
            format!(
                "native-lease:{}",
                if role == LeaseRole::Mutation { 2 } else { 4 }
            )
        );
        assert_eq!(root.test_used_bytes(role), one * 2);
    }
}

#[tokio::test]
async fn registry_real_lease_replay_keeps_deadline_and_is_principal_bound() {
    let (owner, _dir) = setup();
    let seed = RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap();
    let scope = registry_scope("epoch-1");
    let mut root = RecordingRegistryRoot::try_new(seed, scope.clone())
        .ok()
        .unwrap();
    let alice = root.test_session("alice", LeaseRole::Mutation);
    let bob = root.test_session("bob", LeaseRole::Mutation);
    let now = std::time::Instant::now();
    let request = registry_lease(&scope, "lease-1", "admission-1", "mutation", 5);
    let first = root.issue_lease_at(&alice, request.clone(), now).unwrap();
    assert_eq!(
        root.issue_lease_at(&bob, request.clone(), now),
        Err(LeaseError::Forbidden)
    );
    assert_eq!(
        root.issue_lease_at(
            &alice,
            registry_lease(&scope, "lease-1", "admission-2", "mutation", 5),
            now
        ),
        Err(LeaseError::ProtocolViolation)
    );
    assert_eq!(
        root.issue_lease_at(
            &alice,
            registry_lease(&scope, "lease-2", "admission-1", "mutation", 5),
            now
        ),
        Err(LeaseError::ProtocolViolation)
    );
    let later = now + Duration::from_millis(5);
    assert_eq!(
        root.issue_lease_at(&alice, request, later)
            .unwrap()
            .as_value(),
        first.as_value()
    );
    for index in 2..=5 {
        let id = format!("lease-{index}");
        let admission = format!("admission-{index}");
        root.issue_lease_at(
            &alice,
            registry_lease(&scope, &id, &admission, "mutation", 5),
            later,
        )
        .unwrap();
    }
    assert_eq!(
        root.issue_lease_at(
            &alice,
            registry_lease(&scope, "lease-6", "admission-6", "mutation", 5),
            later
        ),
        Err(LeaseError::Capacity)
    );
    let other_role = root.test_session("alice", LeaseRole::Reconciliation);
    root.issue_lease_at(
        &other_role,
        registry_lease(&scope, "read-1", "read-admission-1", "reconciliation", 5),
        later,
    )
    .unwrap();
    assert_eq!(
        root.issue_lease_at(
            &alice,
            registry_lease(
                &scope,
                "wrong-role",
                "wrong-role-admission",
                "reconciliation",
                5
            ),
            later
        ),
        Err(LeaseError::Forbidden)
    );
    assert!(root.try_handoff().is_ok());
    assert_eq!(
        root.issue_lease_at(
            &alice,
            registry_lease(
                &scope,
                "after-close",
                "after-close-admission",
                "mutation",
                5
            ),
            later
        ),
        Err(LeaseError::Closed)
    );
}

#[tokio::test]
async fn registry_lease_rejects_foreign_root_scope_and_epoch() {
    let (first_owner, _first_dir) = setup();
    let (second_owner, _second_dir) = setup();
    let first_scope = registry_scope("epoch-1");
    let second_scope = registry_scope("epoch-2");
    let first = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(first_owner).unwrap(),
        first_scope.clone(),
    )
    .ok()
    .unwrap();
    let mut second = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(second_owner).unwrap(),
        second_scope.clone(),
    )
    .ok()
    .unwrap();
    let first_session = first.test_session("alice", LeaseRole::Mutation);
    let second_session = second.test_session("alice", LeaseRole::Mutation);
    let now = std::time::Instant::now();
    assert_eq!(
        second.issue_lease_at(
            &first_session,
            registry_lease(&second_scope, "lease-1", "admission-1", "mutation", 5),
            now
        ),
        Err(LeaseError::Forbidden)
    );
    assert_eq!(
        second.issue_lease_at(
            &second_session,
            registry_lease(&first_scope, "lease-1", "admission-1", "mutation", 5),
            now
        ),
        Err(LeaseError::Forbidden)
    );
}

#[tokio::test]
async fn registry_workflow_reserves_all_four_stages_before_a_mutation_lease() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-1");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let session = root.test_session("alice", LeaseRole::Mutation);
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let planned_change = change("workflow-1");
    let model_session = crate::recording_registry_model::ModelSession::new(
        scope.clone(),
        crate::recording_registry_model::SimulatedPrincipal::new("alice").unwrap(),
    )
    .unwrap();
    let mut model = crate::recording_registry_model::RegistryModel::new_workflow(
        model_session.clone(),
        crate::recording_registry_model::ModelLimits::default(),
        crate::recording_registry_model::SimulatedRunQualification::CleanJoined,
    )
    .unwrap();
    let before = model.stats().mutation_bytes;
    model
        .reserve_workflow(&model_session, planned_change.clone())
        .unwrap();
    let expected_bytes = model.stats().mutation_bytes - before;
    root.test_set_byte_limit(LeaseRole::Mutation, expected_bytes - 1);
    assert!(matches!(
        root.reserve_workflow(&session, planned_change.clone()),
        Err(LeaseError::Capacity)
    ));
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), 0);
    root.test_set_byte_limit(LeaseRole::Mutation, expected_bytes);
    let ticket = root
        .reserve_workflow(&session, planned_change.clone())
        .unwrap();
    assert_eq!(ticket.change_id(), "workflow-1");
    assert_eq!(ticket.sequence(), 1);
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), expected_bytes);
    let replay = root
        .reserve_workflow(&session, planned_change.clone())
        .unwrap();
    assert_eq!(replay.sequence(), ticket.sequence());
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), expected_bytes);
    assert!(matches!(
        root.reserve_workflow(
            &root.test_session("bob", LeaseRole::Mutation),
            planned_change.clone()
        ),
        Err(LeaseError::Forbidden)
    ));
    assert!(matches!(
        root.reserve_workflow(&read, change("workflow-2")),
        Err(LeaseError::Forbidden)
    ));
    assert!(matches!(
        root.reserve_workflow(&session, change("workflow-2")),
        Err(LeaseError::Busy)
    ));
    let mutation_lease = registry_lease(&scope, "lease-1", "admission-1", "mutation", 1);
    assert_eq!(
        root.issue_lease(&session, mutation_lease),
        Err(LeaseError::Forbidden)
    );
    assert!(root.try_handoff().is_ok());
    assert!(matches!(
        root.reserve_workflow(&session, planned_change),
        Err(LeaseError::Closed)
    ));
}

#[tokio::test]
async fn registry_workflow_cannot_follow_an_unreserved_mutation_lease() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-1");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let session = root.test_session("alice", LeaseRole::Mutation);
    root.issue_lease(
        &session,
        registry_lease(&scope, "lease-1", "admission-1", "mutation", 1),
    )
    .unwrap();
    assert!(matches!(
        root.reserve_workflow(&session, change("workflow-1")),
        Err(LeaseError::Busy)
    ));
}

#[tokio::test]
async fn registry_preflight_registration_consumes_lease_once_without_native_call() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-1");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let session = root.test_session("alice", LeaseRole::Mutation);
    let planned = change("workflow-preflight");
    let workflow = root.reserve_workflow(&session, planned.clone()).unwrap();
    let reserved_bytes = root.test_used_bytes(LeaseRole::Mutation);
    let now = std::time::Instant::now();
    let lease_request = registry_lease(&scope, "lease-1", "admission-1", "mutation", 10);
    let lease = root
        .issue_preflight_lease_at(&session, &workflow, lease_request.clone(), now)
        .unwrap();
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), reserved_bytes);
    assert_eq!(root.test_reserved_revisions(), 11);
    assert_eq!(root.test_lease_consumed("lease-1"), Some(false));
    let request = registry_preflight(&scope, &planned, "admission-1", &lease);
    let bob = root.test_session("bob", LeaseRole::Mutation);
    assert!(matches!(
        root.issue_preflight_lease_at(&bob, &workflow, lease_request, now),
        Err(LeaseError::Forbidden)
    ));
    assert!(matches!(
        root.register_preflight_at(&bob, &workflow, request.clone(), now),
        Err(LeaseError::Forbidden)
    ));
    let mut changed_before_registration = request.as_value().clone();
    changed_before_registration["action"]["change"] = change("different-change").as_value().clone();
    let changed_before_registration =
        RecordingAdmissionRequest::from_value(changed_before_registration).unwrap();
    assert!(matches!(
        root.register_preflight_at(&session, &workflow, changed_before_registration, now),
        Err(LeaseError::ProtocolViolation)
    ));
    let registered = root
        .register_preflight_at(
            &session,
            &workflow,
            request.clone(),
            now + Duration::from_millis(9),
        )
        .unwrap();
    let PreflightRegistration::Registered(ticket) = registered else {
        panic!("new registration expected")
    };
    assert_eq!(ticket.admission_id(), "admission-1");
    assert_eq!(ticket.sequence(), 3);
    assert_eq!(root.test_lease_consumed("lease-1"), Some(true));
    let replay = root
        .register_preflight_at(
            &session,
            &workflow,
            request.clone(),
            now + Duration::from_millis(20),
        )
        .unwrap();
    let PreflightRegistration::Existing(existing) = replay else {
        panic!("existing registration expected")
    };
    assert_eq!(existing.sequence(), ticket.sequence());
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), reserved_bytes);
    let mut changed = request.as_value().clone();
    changed["deadlineLeaseRef"] = json!("different-ref");
    let changed = RecordingAdmissionRequest::from_value(changed).unwrap();
    assert!(matches!(
        root.register_preflight_at(
            &session,
            &workflow,
            changed,
            now + Duration::from_millis(20)
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    assert!(matches!(
        root.issue_preflight_lease_at(
            &session,
            &workflow,
            registry_lease(&scope, "lease-2", "admission-2", "mutation", 10),
            now + Duration::from_millis(20)
        ),
        Err(LeaseError::Busy)
    ));
    let handoff = root.try_handoff().unwrap();
    assert_eq!(
        handoff.supervisor.state().recording.phase,
        RecordingPhase::Joined
    );
    assert!(matches!(
        root.register_preflight_at(
            &session,
            &workflow,
            request,
            now + Duration::from_millis(20)
        ),
        Err(LeaseError::Closed)
    ));
}

#[tokio::test]
async fn registry_preflight_expiry_retry_preserves_original_and_future_reservations() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-1");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let session = root.test_session("alice", LeaseRole::Mutation);
    let planned = change("workflow-retry");
    let workflow = root.reserve_workflow(&session, planned.clone()).unwrap();
    let initial_bytes = root.test_used_bytes(LeaseRole::Mutation);
    let (stage, _) =
        crate::recording_registry::kernel::workflow::stage(&planned, &scope, "preflight").unwrap();
    let retry_bytes = stage.bytes().unwrap();
    let now = std::time::Instant::now();
    let first_request = registry_lease(&scope, "lease-1", "admission-1", "mutation", 5);
    let first = root
        .issue_preflight_lease_at(&session, &workflow, first_request.clone(), now)
        .unwrap();
    let first_admission = registry_preflight(&scope, &planned, "admission-1", &first);
    assert!(matches!(
        root.test_register_preflight_with_clock(
            &session,
            &workflow,
            first_admission.clone(),
            || now + Duration::from_millis(5)
        ),
        Err(LeaseError::Expired)
    ));
    assert_eq!(root.test_lease_consumed("lease-1"), Some(false));
    assert!(matches!(
        root.issue_preflight_lease_at(
            &session,
            &workflow,
            registry_lease(&scope, "lease-2", "admission-2", "mutation", 5),
            now + Duration::from_millis(4)
        ),
        Err(LeaseError::Busy)
    ));
    assert_eq!(
        root.issue_preflight_lease_at(
            &session,
            &workflow,
            first_request,
            now + Duration::from_millis(20)
        )
        .unwrap()
        .as_value(),
        first.as_value()
    );
    let retry_request = registry_lease(&scope, "lease-2", "admission-2", "mutation", 5);
    root.test_set_byte_limit(LeaseRole::Mutation, initial_bytes + retry_bytes - 1);
    assert!(matches!(
        root.issue_preflight_lease_at(
            &session,
            &workflow,
            retry_request.clone(),
            now + Duration::from_millis(5)
        ),
        Err(LeaseError::Capacity)
    ));
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), initial_bytes);
    assert_eq!(root.test_reserved_revisions(), 11);
    root.test_set_byte_limit(LeaseRole::Mutation, initial_bytes + retry_bytes);
    let second = root
        .issue_preflight_lease_at(
            &session,
            &workflow,
            retry_request,
            now + Duration::from_millis(5),
        )
        .unwrap();
    assert_eq!(
        second.as_value()["outcome"]["deadlineLeaseRef"],
        "native-lease:3"
    );
    assert_eq!(
        root.test_used_bytes(LeaseRole::Mutation),
        initial_bytes + retry_bytes
    );
    assert_eq!(root.test_reserved_revisions(), 14);
    assert!(matches!(
        root.issue_preflight_lease_at(
            &session,
            &workflow,
            registry_lease(&scope, "lease-3", "admission-2", "mutation", 5),
            now + Duration::from_millis(6)
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    assert!(matches!(
        root.register_preflight_at(
            &session,
            &workflow,
            first_admission,
            now + Duration::from_millis(6)
        ),
        Err(LeaseError::Busy)
    ));
    let second_admission = registry_preflight(&scope, &planned, "admission-2", &second);
    assert!(matches!(
        root.register_preflight_at(
            &session,
            &workflow,
            second_admission,
            now + Duration::from_millis(9)
        ),
        Ok(PreflightRegistration::Registered(_))
    ));
    assert_eq!(root.test_lease_consumed("lease-1"), Some(false));
    assert_eq!(root.test_lease_consumed("lease-2"), Some(true));
}

#[tokio::test]
async fn registry_preflight_rejects_a_same_named_ticket_from_another_root() {
    let (first_owner, _first_dir) = setup();
    let (second_owner, _second_dir) = setup();
    let scope = registry_scope("epoch-1");
    let mut first = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(first_owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let mut second = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(second_owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let first_session = first.test_session("alice", LeaseRole::Mutation);
    let second_session = second.test_session("alice", LeaseRole::Mutation);
    let planned = change("same-name");
    let foreign = first
        .reserve_workflow(&first_session, planned.clone())
        .unwrap();
    let _local = second.reserve_workflow(&second_session, planned).unwrap();
    let request = registry_lease(&scope, "lease-1", "admission-1", "mutation", 5);
    assert!(matches!(
        second.issue_preflight_lease_at(
            &second_session,
            &foreign,
            request,
            std::time::Instant::now()
        ),
        Err(LeaseError::Forbidden)
    ));
}

#[tokio::test]
async fn registry_dispatches_registered_preflight_once_and_recovers_original_reply() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-dispatch");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let alice = root.test_session("alice", LeaseRole::Mutation);
    let bob = root.test_session("bob", LeaseRole::Mutation);
    let change = change("native-dispatch");
    let workflow = root.reserve_workflow(&alice, change.clone()).unwrap();
    let lease = root
        .issue_preflight_lease(
            &alice,
            &workflow,
            registry_lease(
                &scope,
                "dispatch-lease",
                "dispatch-admission",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    let request = registry_preflight(&scope, &change, "dispatch-admission", &lease);
    let ticket = match root
        .register_preflight(&alice, &workflow, request.clone())
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new registration expected"),
    };
    assert!(root.preflight_reply(&alice, &ticket).unwrap().is_none());
    assert!(matches!(
        root.dispatch_preflight(&bob, &ticket),
        Err(LeaseError::Forbidden)
    ));
    let reply = root.dispatch_preflight(&alice, &ticket).unwrap();
    assert_eq!(reply.as_value()["outcome"]["kind"], "accepted");
    assert_eq!(reply.as_value()["request"], *request.as_value());
    assert_eq!(root.dispatch_preflight(&alice, &ticket).unwrap(), reply);
    assert_eq!(
        root.preflight_reply(&alice, &ticket).unwrap(),
        Some(reply.clone())
    );
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
    for _ in 0..100 {
        if root
            .preflight_completion(&alice, &ticket)
            .unwrap()
            .is_some()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let completion = root.preflight_completion(&alice, &ticket).unwrap().unwrap();
    assert_eq!(
        completion.as_value()["request"],
        reply.as_value()["outcome"]["handle"]["request"]
    );
    assert_eq!(root.preflight_reply(&alice, &ticket).unwrap(), Some(reply));
}

#[tokio::test]
async fn registry_expired_registered_preflight_never_calls_native() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-expiry");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let session = root.test_session("alice", LeaseRole::Mutation);
    let change = change("native-expiry");
    let workflow = root.reserve_workflow(&session, change.clone()).unwrap();
    let now = std::time::Instant::now();
    let lease = root
        .issue_preflight_lease_at(
            &session,
            &workflow,
            registry_lease(&scope, "expired-lease", "expired-admission", "mutation", 1),
            now,
        )
        .unwrap();
    let ticket = match root
        .register_preflight_at(
            &session,
            &workflow,
            registry_preflight(&scope, &change, "expired-admission", &lease),
            now,
        )
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new registration expected"),
    };
    tokio::time::sleep(Duration::from_millis(3)).await;
    let reply = root.dispatch_preflight(&session, &ticket).unwrap();
    assert_eq!(reply.as_value()["outcome"]["kind"], "rejected");
    assert_eq!(reply.as_value()["outcome"]["error"], "deadlineExceeded");
    assert_eq!(root.dispatch_preflight(&session, &ticket).unwrap(), reply);
    assert!(root
        .preflight_completion(&session, &ticket)
        .unwrap()
        .is_none());
    assert!(root.try_handoff().is_ok());
}

#[tokio::test]
async fn registry_native_typed_rejection_is_saved_without_a_handle() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-rejection");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let session = root.test_session("alice", LeaseRole::Mutation);
    let change = change("native-rejection");
    let workflow = root.reserve_workflow(&session, change.clone()).unwrap();
    let lease = root
        .issue_preflight_lease(
            &session,
            &workflow,
            registry_lease(
                &scope,
                "rejection-lease",
                "rejection-admission",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    let original = registry_preflight(&scope, &change, "rejection-admission", &lease);
    let ticket = match root
        .register_preflight(&session, &workflow, original.clone())
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new registration expected"),
    };
    let competing = root
        .test_native_client()
        .preflight(self::change("competing"), control())
        .unwrap();
    let reply = root.dispatch_preflight(&session, &ticket).unwrap();
    assert_eq!(reply.as_value()["outcome"]["kind"], "rejected");
    assert_eq!(reply.as_value()["outcome"]["error"], "busy");
    assert_eq!(
        root.preflight_reply(&session, &ticket).unwrap(),
        Some(reply.clone())
    );
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let inspection = root
        .inspect_preflight_admission(
            &read,
            &workflow,
            registry_inspection(&original, "rejection-inspection"),
        )
        .unwrap();
    assert_eq!(inspection.as_value()["outcome"]["reply"], *reply.as_value());
    assert!(root
        .preflight_completion(&session, &ticket)
        .unwrap()
        .is_none());
    let _ = competing.operation.wait().await.unwrap();
}

#[tokio::test]
async fn registry_uncertain_native_or_projection_panic_never_redispatches() {
    for fault in [
        TestDispatchFault::NativePanicAfterCall,
        TestDispatchFault::ProjectionPanic,
    ] {
        let (owner, _dir) = setup();
        let scope = registry_scope("epoch-panic");
        let mut root = RecordingRegistryRoot::try_new(
            RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
            scope.clone(),
        )
        .ok()
        .unwrap();
        let session = root.test_session("alice", LeaseRole::Mutation);
        let change = change("native-panic");
        let workflow = root.reserve_workflow(&session, change.clone()).unwrap();
        let lease = root
            .issue_preflight_lease(
                &session,
                &workflow,
                registry_lease(&scope, "panic-lease", "panic-admission", "mutation", 1000),
            )
            .unwrap();
        let ticket = match root
            .register_preflight(
                &session,
                &workflow,
                registry_preflight(&scope, &change, "panic-admission", &lease),
            )
            .unwrap()
        {
            PreflightRegistration::Registered(ticket) => ticket,
            _ => panic!("new registration expected"),
        };
        root.test_set_dispatch_fault(&session, &ticket, fault);
        let reply = root.dispatch_preflight(&session, &ticket).unwrap();
        assert_eq!(reply.as_value()["outcome"]["kind"], "unknown");
        assert_eq!(root.dispatch_preflight(&session, &ticket).unwrap(), reply);
        assert_eq!(
            root.preflight_reply(&session, &ticket).unwrap(),
            Some(reply)
        );
        assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
        if fault == TestDispatchFault::ProjectionPanic {
            for _ in 0..100 {
                if root
                    .preflight_completion(&session, &ticket)
                    .unwrap()
                    .is_some()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            assert!(root
                .preflight_completion(&session, &ticket)
                .unwrap()
                .is_some());
        } else {
            assert!(root
                .preflight_completion(&session, &ticket)
                .unwrap()
                .is_none());
        }
    }
}

#[tokio::test]
async fn registry_inspection_freezes_each_query_without_rewriting_the_original_reply() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-inspection");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let mutation = root.test_session("alice", LeaseRole::Mutation);
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let bob = root.test_session("bob", LeaseRole::Reconciliation);
    let change = change("inspect-preflight");
    let workflow = root.reserve_workflow(&mutation, change.clone()).unwrap();
    let lease = root
        .issue_preflight_lease(
            &mutation,
            &workflow,
            registry_lease(
                &scope,
                "inspect-lease",
                "inspect-admission",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    let original = registry_preflight(&scope, &change, "inspect-admission", &lease);
    let first_request = registry_inspection(&original, "inspection-1");
    let (foreign_owner, _foreign_dir) = setup();
    let mut foreign_root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(foreign_owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let foreign_session = foreign_root.test_session("alice", LeaseRole::Mutation);
    let foreign_workflow = foreign_root
        .reserve_workflow(&foreign_session, change.clone())
        .unwrap();
    assert!(matches!(
        root.inspect_preflight_admission(&read, &foreign_workflow, first_request.clone()),
        Err(LeaseError::Forbidden)
    ));
    assert!(matches!(
        root.inspect_preflight_admission(&bob, &workflow, first_request.clone()),
        Err(LeaseError::Forbidden)
    ));
    assert!(matches!(
        root.inspect_preflight_admission(&mutation, &workflow, first_request.clone()),
        Err(LeaseError::Forbidden)
    ));
    let mutation_bytes = root.test_used_bytes(LeaseRole::Mutation);
    let first = root
        .inspect_preflight_admission(&read, &workflow, first_request.clone())
        .unwrap();
    assert_eq!(first.as_value()["outcome"]["kind"], "notFound");
    let read_bytes = root.test_used_bytes(LeaseRole::Reconciliation);
    let ticket = match root
        .register_preflight(&mutation, &workflow, original.clone())
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new registration expected"),
    };
    let pending = root
        .inspect_preflight_admission(
            &read,
            &workflow,
            registry_inspection(&original, "inspection-2"),
        )
        .unwrap();
    assert_eq!(pending.as_value()["outcome"]["kind"], "found");
    assert_eq!(
        pending.as_value()["outcome"]["reply"]["outcome"]["kind"],
        "unknown"
    );
    let accepted = root.dispatch_preflight(&mutation, &ticket).unwrap();
    let replay = root
        .inspect_preflight_admission(&read, &workflow, first_request)
        .unwrap();
    assert_eq!(replay, first);
    assert!(root.test_used_bytes(LeaseRole::Reconciliation) > read_bytes);
    let current = root
        .inspect_preflight_admission(
            &read,
            &workflow,
            registry_inspection(&original, "inspection-3"),
        )
        .unwrap();
    assert_eq!(current.as_value()["outcome"]["reply"], *accepted.as_value());
    assert_eq!(
        root.preflight_reply(&mutation, &ticket).unwrap(),
        Some(accepted)
    );
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), mutation_bytes);
    assert_eq!(root.test_admission_inspection_count(), 3);
    let changed = registry_inspection(
        &registry_preflight(&scope, &change, "different-admission", &lease),
        "inspection-3",
    );
    assert!(matches!(
        root.inspect_preflight_admission(&read, &workflow, changed),
        Err(LeaseError::ProtocolViolation)
    ));
    let mut changed_original = original.as_value().clone();
    changed_original["deadlineLeaseRef"] = json!("changed-lease-ref");
    let changed_original = RecordingAdmissionRequest::from_value(changed_original).unwrap();
    assert!(matches!(
        root.inspect_preflight_admission(
            &read,
            &workflow,
            registry_inspection(&changed_original, "inspection-4")
        ),
        Err(LeaseError::ProtocolViolation)
    ));
}

#[tokio::test]
async fn registry_inspection_can_prove_saved_handle_after_projection_panic() {
    for fault in [
        TestDispatchFault::ProjectionPanic,
        TestDispatchFault::NativePanicAfterCall,
    ] {
        let (owner, _dir) = setup();
        let scope = registry_scope("epoch-inspection-panic");
        let mut root = RecordingRegistryRoot::try_new(
            RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
            scope.clone(),
        )
        .ok()
        .unwrap();
        let mutation = root.test_session("alice", LeaseRole::Mutation);
        let read = root.test_session("alice", LeaseRole::Reconciliation);
        let change = change("inspect-panic");
        let workflow = root.reserve_workflow(&mutation, change.clone()).unwrap();
        let lease = root
            .issue_preflight_lease(
                &mutation,
                &workflow,
                registry_lease(
                    &scope,
                    "panic-inspection-lease",
                    "panic-inspection-admission",
                    "mutation",
                    1000,
                ),
            )
            .unwrap();
        let original = registry_preflight(&scope, &change, "panic-inspection-admission", &lease);
        let ticket = match root
            .register_preflight(&mutation, &workflow, original.clone())
            .unwrap()
        {
            PreflightRegistration::Registered(ticket) => ticket,
            _ => panic!("new registration expected"),
        };
        root.test_set_dispatch_fault(&mutation, &ticket, fault);
        let original_reply = root.dispatch_preflight(&mutation, &ticket).unwrap();
        assert_eq!(original_reply.as_value()["outcome"]["kind"], "unknown");
        let inspection = root
            .inspect_preflight_admission(
                &read,
                &workflow,
                registry_inspection(&original, "panic-inspection"),
            )
            .unwrap();
        let expected = if fault == TestDispatchFault::ProjectionPanic {
            "accepted"
        } else {
            "unknown"
        };
        assert_eq!(
            inspection.as_value()["outcome"]["reply"]["outcome"]["kind"],
            expected
        );
        if fault == TestDispatchFault::ProjectionPanic {
            root.test_set_inspection_projection_panic(&mutation, &ticket);
            let later = root
                .inspect_preflight_admission(
                    &read,
                    &workflow,
                    registry_inspection(&original, "panic-inspection-later"),
                )
                .unwrap();
            assert_eq!(
                later.as_value()["outcome"]["reply"]["outcome"]["kind"],
                "accepted"
            );
        }
        assert_eq!(
            root.preflight_reply(&mutation, &ticket).unwrap(),
            Some(original_reply)
        );
        assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
    }
}

#[tokio::test]
async fn registry_inspection_capacity_failure_does_not_bind_id_or_spend_read_bytes() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-inspection-capacity");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let mutation = root.test_session("alice", LeaseRole::Mutation);
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let change = change("inspect-capacity");
    let workflow = root.reserve_workflow(&mutation, change.clone()).unwrap();
    let lease = root
        .issue_preflight_lease(
            &mutation,
            &workflow,
            registry_lease(
                &scope,
                "capacity-lease",
                "capacity-admission",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    let original = registry_preflight(&scope, &change, "capacity-admission", &lease);
    let request = registry_inspection(&original, "capacity-inspection");
    let reply = RecordingAdmissionInspectionReply::from_value(json!({
        "version":1, "kind":"recordingAdmissionInspectionReply",
        "request":request.as_value(), "outcome":{"kind":"notFound"}
    }))
    .unwrap();
    let cost = crate::recording_registry::kernel::budget::measured(request.as_value())
        .unwrap()
        .bytes
        + crate::recording_registry::kernel::budget::measured(reply.as_value())
            .unwrap()
            .bytes;
    root.test_set_byte_limit(LeaseRole::Reconciliation, cost - 1);
    assert!(matches!(
        root.inspect_preflight_admission(&read, &workflow, request.clone()),
        Err(LeaseError::Capacity)
    ));
    assert_eq!(root.test_admission_inspection_count(), 0);
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), 0);
    root.test_set_byte_limit(LeaseRole::Reconciliation, cost);
    assert_eq!(
        root.inspect_preflight_admission(&read, &workflow, request.clone())
            .unwrap(),
        reply
    );
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), cost);
    assert_eq!(
        root.inspect_preflight_admission(&read, &workflow, request)
            .unwrap(),
        reply
    );
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), cost);
}

#[tokio::test]
async fn registry_pause_admission_dispatches_one_native_join_and_keeps_original_reply() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-pause-dispatch");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let session = root.test_session("alice", LeaseRole::Mutation);
    let bob = root.test_session("bob", LeaseRole::Mutation);
    let change = change("pause-dispatch");
    let workflow = root.reserve_workflow(&session, change.clone()).unwrap();
    let first = root
        .issue_preflight_lease(
            &session,
            &workflow,
            registry_lease(
                &scope,
                "preflight-lease",
                "preflight-admission",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    let preflight = match root
        .register_preflight(
            &session,
            &workflow,
            registry_preflight(&scope, &change, "preflight-admission", &first),
        )
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new preflight"),
    };
    let accepted = root.dispatch_preflight(&session, &preflight).unwrap();
    for _ in 0..100 {
        if root
            .preflight_completion(&session, &preflight)
            .unwrap()
            .is_some()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        root.preflight_completion(&session, &preflight)
            .unwrap()
            .unwrap()
            .as_value()["outcome"]["kind"],
        "candidate"
    );
    let change_ref = accepted.as_value()["outcome"]["handle"]["changeRef"]
        .as_str()
        .unwrap();
    let pause_lease = root
        .issue_pause_join_lease(
            &session,
            &workflow,
            &preflight,
            "pause:dispatch",
            registry_lease(&scope, "pause-lease", "pause-admission", "mutation", 1000),
        )
        .unwrap();
    let admission = registry_pause_admission(
        &scope,
        &change,
        "pause-admission",
        &pause_lease,
        change_ref,
        "pause:dispatch",
    );
    let mut alternate_number = admission.as_value().clone();
    let revision =
        &mut alternate_number["action"]["operation"]["change"]["apply"]["desired"]["revision"];
    assert_eq!(*revision, json!(1));
    *revision = json!(1.0);
    let admission = RecordingAdmissionRequest::from_value(alternate_number).unwrap();
    let mut wrong = admission.as_value().clone();
    wrong["action"]["changeRef"] = json!("native-change:wrong");
    assert!(matches!(
        root.register_pause_join(
            &session,
            &workflow,
            &preflight,
            RecordingAdmissionRequest::from_value(wrong).unwrap()
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    assert!(matches!(
        root.register_pause_join(&bob, &workflow, &preflight, admission.clone()),
        Err(LeaseError::Forbidden)
    ));
    let bytes = root.test_used_bytes(LeaseRole::Mutation);
    let ticket = match root
        .register_pause_join(&session, &workflow, &preflight, admission.clone())
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("new pause"),
    };
    assert_eq!(root.test_lease_consumed("pause-lease"), Some(true));
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
    assert!(matches!(
        root.register_pause_join_at(
            &session,
            &workflow,
            &preflight,
            admission.clone(),
            Instant::now() + Duration::from_secs(3)
        )
        .unwrap(),
        PauseRegistration::Existing(_)
    ));
    let gate = Arc::new(driver::TestGate::default());
    let client = root.test_native_client();
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    let reply = root.dispatch_pause_join(&session, &ticket).unwrap();
    assert_eq!(reply.as_value()["outcome"]["kind"], "accepted");
    assert_eq!(
        reply.as_value()["outcome"]["handle"]["changeRef"],
        change_ref
    );
    gate.entered.notified().await;
    assert_eq!(client.state().phase, OperationsPhase::Pausing);
    assert!(root.pause_completion(&session, &ticket).unwrap().is_none());
    let apply_request = registry_lease(&scope, "apply-lease", "apply-admission", "mutation", 100);
    assert!(matches!(
        root.issue_apply_lease(
            &session,
            &workflow,
            &ticket,
            "apply:operation",
            apply_request.clone()
        ),
        Err(LeaseError::Busy)
    ));
    assert_eq!(root.dispatch_pause_join(&session, &ticket).unwrap(), reply);
    assert_eq!(
        root.pause_reply(&session, &ticket).unwrap(),
        Some(reply.clone())
    );
    assert!(matches!(
        root.pause_reply(&bob, &ticket),
        Err(LeaseError::Forbidden)
    ));
    gate.release.notify_one();
    for _ in 0..100 {
        if root.pause_completion(&session, &ticket).unwrap().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let completion = root.pause_completion(&session, &ticket).unwrap().unwrap();
    assert_eq!(completion.as_value()["outcome"]["kind"], "paused");
    assert_eq!(completion.as_value()["quiescence"], "confirmed");
    assert_eq!(completion.as_value()["recoveryRequired"], false);
    assert_eq!(root.pause_reply(&session, &ticket).unwrap(), Some(reply));
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
    let native_preflight_id = accepted.as_value()["outcome"]["handle"]["operationRef"]
        .as_str()
        .unwrap();
    for collision in [native_preflight_id, "pause:dispatch"] {
        assert!(matches!(
            root.issue_apply_lease(
                &session,
                &workflow,
                &ticket,
                collision,
                apply_request.clone()
            ),
            Err(LeaseError::ProtocolViolation)
        ));
    }
    let oversized = "x".repeat(65);
    assert!(matches!(
        root.issue_apply_lease(
            &session,
            &workflow,
            &ticket,
            &oversized,
            apply_request.clone()
        ),
        Err(LeaseError::InvalidInput)
    ));
    assert!(matches!(
        root.issue_apply_lease(
            &bob,
            &workflow,
            &ticket,
            "apply:operation",
            apply_request.clone()
        ),
        Err(LeaseError::Forbidden)
    ));
    let (
        mut other_root,
        other_session,
        other_workflow,
        other_preflight,
        other_admission,
        _other_dir,
    ) = ready_pause_registry("other-root-apply", 1000).await;
    let other_ticket = match other_root
        .register_pause_join(
            &other_session,
            &other_workflow,
            &other_preflight,
            other_admission,
        )
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("other pause"),
    };
    assert!(matches!(
        root.issue_apply_lease(
            &session,
            &workflow,
            &other_ticket,
            "apply:operation",
            apply_request.clone()
        ),
        Err(LeaseError::Forbidden)
    ));
    let foreign = registry_scope("foreign-apply-epoch");
    for id in ["pause-lease", "unused-foreign-lease"] {
        assert!(matches!(
            root.issue_apply_lease(
                &session,
                &workflow,
                &ticket,
                "apply:operation",
                registry_lease(&foreign, id, "foreign-admission", "mutation", 100)
            ),
            Err(LeaseError::Forbidden)
        ));
    }
    for reused in [
        registry_lease(&scope, "pause-lease", "new-admission", "mutation", 100),
        registry_lease(&scope, "new-lease", "pause-admission", "mutation", 100),
        registry_lease(
            &scope,
            "preflight-lease",
            "newer-admission",
            "mutation",
            100,
        ),
        registry_lease(
            &scope,
            "newer-lease",
            "preflight-admission",
            "mutation",
            100,
        ),
    ] {
        assert!(matches!(
            root.issue_apply_lease(&session, &workflow, &ticket, "apply:operation", reused),
            Err(LeaseError::ProtocolViolation)
        ));
    }
    assert_eq!(root.test_lease_consumed("apply-lease"), None);
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
    root.test_set_lease_limit(LeaseRole::Mutation, 2);
    assert!(matches!(
        root.issue_apply_lease(
            &session,
            &workflow,
            &ticket,
            "apply:operation",
            apply_request.clone()
        ),
        Err(LeaseError::Capacity)
    ));
    assert_eq!(root.test_lease_consumed("apply-lease"), None);
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
    root.test_set_lease_limit(LeaseRole::Mutation, 3);
    let apply_reply = root
        .issue_apply_lease(
            &session,
            &workflow,
            &ticket,
            "apply:operation",
            apply_request.clone(),
        )
        .unwrap();
    assert_eq!(root.test_lease_consumed("apply-lease"), Some(false));
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
    assert_eq!(root.test_reserved_revisions(), 11);
    assert_eq!(client.state().phase, OperationsPhase::Paused);
    assert!(client.state().last_applied.is_none());
    tokio::time::sleep(Duration::from_millis(110)).await;
    assert_eq!(
        root.issue_apply_lease(
            &session,
            &workflow,
            &ticket,
            "apply:operation",
            apply_request.clone()
        )
        .unwrap(),
        apply_reply
    );
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
    assert!(matches!(
        root.issue_apply_lease(
            &session,
            &workflow,
            &ticket,
            "other:apply",
            apply_request.clone()
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    assert!(matches!(
        root.issue_apply_lease(
            &session,
            &workflow,
            &ticket,
            "apply:operation",
            registry_lease(&scope, "other-lease", "other-admission", "mutation", 100)
        ),
        Err(LeaseError::ProtocolViolation)
    ));
}

#[tokio::test]
async fn registry_pause_admission_expires_before_registration_or_native_call() {
    let (mut root, session, workflow, preflight, admission, _dir) =
        ready_pause_registry("epoch-pause-expiry", 100).await;
    let bytes = root.test_used_bytes(LeaseRole::Mutation);
    assert!(matches!(
        root.register_pause_join_at(
            &session,
            &workflow,
            &preflight,
            admission.clone(),
            Instant::now() + Duration::from_secs(2)
        ),
        Err(LeaseError::Expired)
    ));
    assert_eq!(root.test_lease_consumed("pause-lease"), Some(false));
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
    let ticket = match root
        .register_pause_join(&session, &workflow, &preflight, admission)
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("new pause"),
    };
    tokio::time::sleep(Duration::from_millis(120)).await;
    let reply = root.dispatch_pause_join(&session, &ticket).unwrap();
    assert_eq!(reply.as_value()["outcome"]["kind"], "rejected");
    assert_eq!(reply.as_value()["outcome"]["error"], "deadlineExceeded");
    assert_eq!(root.pause_completion(&session, &ticket).unwrap(), None);
    assert_eq!(root.dispatch_pause_join(&session, &ticket).unwrap(), reply);
    assert_eq!(
        root.test_native_client().state().phase,
        OperationsPhase::Candidate
    );
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
}

#[tokio::test]
async fn registry_pause_admission_keeps_unknown_and_real_handle_after_projection_failure() {
    let (mut root, session, workflow, preflight, admission, _dir) =
        ready_pause_registry("epoch-pause-unknown", 1000).await;
    let ticket = match root
        .register_pause_join(&session, &workflow, &preflight, admission)
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("new pause"),
    };
    root.test_set_pause_dispatch_fault(&session, &ticket, PauseDispatchFault::ProjectionPanic);
    let unknown = root.dispatch_pause_join(&session, &ticket).unwrap();
    assert_eq!(unknown.as_value()["outcome"]["kind"], "unknown");
    assert_eq!(
        root.pause_reply(&session, &ticket).unwrap(),
        Some(unknown.clone())
    );
    assert_eq!(
        root.dispatch_pause_join(&session, &ticket).unwrap(),
        unknown
    );
    for _ in 0..100 {
        if root.pause_completion(&session, &ticket).unwrap().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let completion = root.pause_completion(&session, &ticket).unwrap().unwrap();
    assert_eq!(completion.as_value()["outcome"]["kind"], "paused");
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
    let scope = registry_scope("epoch-pause-unknown");
    assert!(matches!(
        root.issue_apply_lease(
            &session,
            &workflow,
            &ticket,
            "apply:unknown",
            registry_lease(&scope, "apply-lease", "apply-admission", "mutation", 1000)
        ),
        Err(LeaseError::Busy)
    ));

    let (mut root, session, workflow, preflight, admission, _dir) =
        ready_pause_registry("epoch-pause-after-call-panic", 1000).await;
    let ticket = match root
        .register_pause_join(&session, &workflow, &preflight, admission)
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("new pause"),
    };
    root.test_set_pause_dispatch_fault(&session, &ticket, PauseDispatchFault::NativePanicAfterCall);
    let unknown = root.dispatch_pause_join(&session, &ticket).unwrap();
    assert_eq!(unknown.as_value()["outcome"]["kind"], "unknown");
    assert_eq!(root.pause_completion(&session, &ticket).unwrap(), None);
    assert_eq!(
        root.dispatch_pause_join(&session, &ticket).unwrap(),
        unknown
    );
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
}

struct RunningRegistryDirectory(PathBuf);
impl Drop for RunningRegistryDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn registry_pause_join_waits_for_running_worker_cleanup_after_lease_expiry() {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let hub = crate::recorder_hub_fixture::Hub::new().await;
    let directory = RunningRegistryDirectory(std::env::temp_dir().join(format!(
        "scada-registry-running-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    let mut store = SqliteStore::create(
        &directory.0,
        StoreIdentity {
            store_id: "running-registry".into(),
            deployment_id: "test-deployment".into(),
        },
    )
    .unwrap();
    let sdk = crate::recorder_hub_fixture::plan(Some(7), Source::Real, false);
    let (plan_ref, binding) =
        crate::recording_host::tests::managed_support::apply(&mut store, sdk.session());
    let mut supervisor = RecordingSupervisor::try_new(store).unwrap();
    let (gate, release) = crate::recording_host::worker::TestShutdownGate::new();
    supervisor.host.shutdown_gate = Some(gate.clone());
    let run = supervisor
        .start_managed(
            sdk,
            RecordingOptions {
                plan: plan_ref,
                slot_count: None,
                max_clock_skew_ms: 1000,
                clock_epoch: "running-registry-clock".into(),
            },
            binding,
            control(),
            hub.client(),
        )
        .unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    socket
        .send(Message::Text(
            json!({"op":"data","id":1,"t":200,
        "values":[{"tag":crate::recorder_hub_fixture::NUMBER,"v":42,"q":"good","t":200}]})
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let mut frames = supervisor.recording_watch();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if frames
                .borrow_and_update()
                .progress
                .as_ref()
                .is_some_and(|p| p.counters.committed_ticks >= 1)
            {
                break;
            }
            frames.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(supervisor.state().recording.phase, RecordingPhase::Running);
    let owner = RecordingOperationsOwner::try_new(supervisor, context(), run).unwrap();
    let scope = registry_scope("epoch-running-pause");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let session = root.test_session("alice", LeaseRole::Mutation);
    let mut change_value = change("running-pause").as_value().clone();
    change_value["apply"]["expectedAppliedRevision"] = json!(1);
    change_value["apply"]["expectedMappingRevision"] = json!(1);
    change_value["apply"]["expectedRetentionAppliedRevision"] = json!(1);
    change_value["apply"]["desired"] = json!({
        "version":1,"kind":"recordingPlan","planId":"desired","revision":1,"enabled":true,
        "group":{"groupId":"group","hubRef":"hub","periodMs":1000,
            "members":[{"memberId":"member:0","externalName":crate::recorder_hub_fixture::NUMBER,"valueType":"number"}]}
    });
    let change = RecordingChangeRequest::from_value(change_value).unwrap();
    let workflow = root.reserve_workflow(&session, change.clone()).unwrap();
    let first = root
        .issue_preflight_lease(
            &session,
            &workflow,
            registry_lease(
                &scope,
                "preflight-lease",
                "preflight-admission",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    let preflight = match root
        .register_preflight(
            &session,
            &workflow,
            registry_preflight(&scope, &change, "preflight-admission", &first),
        )
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new preflight"),
    };
    let accepted = root.dispatch_preflight(&session, &preflight).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if root
                .preflight_completion(&session, &preflight)
                .unwrap()
                .is_some()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        root.preflight_completion(&session, &preflight)
            .unwrap()
            .unwrap()
            .as_value()["outcome"]["kind"],
        "candidate"
    );
    let change_ref = accepted.as_value()["outcome"]["handle"]["changeRef"]
        .as_str()
        .unwrap();
    let lease = root
        .issue_pause_join_lease(
            &session,
            &workflow,
            &preflight,
            "pause:running",
            registry_lease(&scope, "pause-lease", "pause-admission", "mutation", 2000),
        )
        .unwrap();
    let admission = registry_pause_admission(
        &scope,
        &change,
        "pause-admission",
        &lease,
        change_ref,
        "pause:running",
    );
    let ticket = match root
        .register_pause_join(&session, &workflow, &preflight, admission)
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("new pause"),
    };
    let reply = root.dispatch_pause_join(&session, &ticket).unwrap();
    assert_eq!(reply.as_value()["outcome"]["kind"], "accepted");
    tokio::time::timeout(Duration::from_secs(5), gate.entered.notified())
        .await
        .unwrap();
    assert!(root.test_native_client().state().phase == OperationsPhase::Pausing);
    assert!(frames.borrow().stop_requested);
    assert!(root.pause_completion(&session, &ticket).unwrap().is_none());
    let apply_request = registry_lease(&scope, "apply-lease", "apply-admission", "mutation", 1000);
    assert!(matches!(
        root.issue_apply_lease(
            &session,
            &workflow,
            &ticket,
            "apply:running",
            apply_request.clone()
        ),
        Err(LeaseError::Busy)
    ));
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
    tokio::time::sleep(Duration::from_millis(2100)).await;
    assert_eq!(root.dispatch_pause_join(&session, &ticket).unwrap(), reply);
    assert!(root.pause_completion(&session, &ticket).unwrap().is_none());
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
    drop(release);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if root.pause_completion(&session, &ticket).unwrap().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let completion = root.pause_completion(&session, &ticket).unwrap().unwrap();
    assert_eq!(completion.as_value()["outcome"]["kind"], "paused");
    assert_eq!(completion.as_value()["quiescence"], "confirmed");
    assert_eq!(completion.as_value()["recoveryRequired"], false);
    let database = rusqlite::Connection::open_with_flags(
        directory.0.join("store.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let applied_revision = || {
        database
            .query_row(
                "SELECT applied_revision FROM recording_plan_state WHERE singleton=1",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
    };
    let before_apply_lease = applied_revision();
    let bytes = root.test_used_bytes(LeaseRole::Mutation);
    root.issue_apply_lease(&session, &workflow, &ticket, "apply:running", apply_request)
        .unwrap();
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
    assert_eq!(applied_revision(), before_apply_lease);
    assert_eq!(
        root.test_native_client().state().phase,
        OperationsPhase::Paused
    );
    assert!(root.test_native_client().state().last_applied.is_none());
    crate::recorder_hub_fixture::closed(&mut socket).await;
}

#[tokio::test]
async fn registry_pause_lease_binds_confirmed_candidate_without_stopping_native() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-pause-lease");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let session = root.test_session("alice", LeaseRole::Mutation);
    let bob = root.test_session("bob", LeaseRole::Mutation);
    let change = change("pause-lease-candidate");
    let workflow = root.reserve_workflow(&session, change.clone()).unwrap();
    let first_lease = root
        .issue_preflight_lease(
            &session,
            &workflow,
            registry_lease(
                &scope,
                "preflight-lease",
                "preflight-admission",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    let preflight = match root
        .register_preflight(
            &session,
            &workflow,
            registry_preflight(&scope, &change, "preflight-admission", &first_lease),
        )
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new registration expected"),
    };
    let accepted = root.dispatch_preflight(&session, &preflight).unwrap();
    for _ in 0..100 {
        if root
            .preflight_completion(&session, &preflight)
            .unwrap()
            .is_some()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let candidate = root
        .preflight_completion(&session, &preflight)
        .unwrap()
        .unwrap();
    assert_eq!(candidate.as_value()["outcome"]["kind"], "candidate");
    assert_eq!(candidate.as_value()["quiescence"], "confirmed");
    assert_eq!(candidate.as_value()["recoveryRequired"], false);
    assert_eq!(
        root.test_native_client().state().phase,
        OperationsPhase::Candidate
    );
    let bytes = root.test_used_bytes(LeaseRole::Mutation);
    let native_operation_id = accepted.as_value()["outcome"]["handle"]["operationRef"]
        .as_str()
        .unwrap();
    assert!(matches!(
        root.issue_pause_join_lease(
            &session,
            &workflow,
            &preflight,
            native_operation_id,
            registry_lease(&scope, "pause-lease", "pause-admission", "mutation", 100),
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    assert!(matches!(
        root.issue_pause_join_lease(
            &bob,
            &workflow,
            &preflight,
            "pause:operation",
            registry_lease(&scope, "pause-lease", "pause-admission", "mutation", 100),
        ),
        Err(LeaseError::Forbidden)
    ));
    let other_scope = registry_scope("other-epoch-pause-lease");
    for lease_id in ["preflight-lease", "unused-foreign-lease"] {
        assert!(matches!(
            root.issue_pause_join_lease(
                &session,
                &workflow,
                &preflight,
                "pause:operation",
                registry_lease(&other_scope, lease_id, "foreign-admission", "mutation", 100),
            ),
            Err(LeaseError::Forbidden)
        ));
    }
    for reused in [
        registry_lease(
            &scope,
            "preflight-lease",
            "preflight-admission",
            "mutation",
            1000,
        ),
        registry_lease(
            &scope,
            "preflight-lease",
            "fresh-pause-admission",
            "mutation",
            100,
        ),
        registry_lease(
            &scope,
            "fresh-pause-lease",
            "preflight-admission",
            "mutation",
            100,
        ),
    ] {
        assert!(matches!(
            root.issue_pause_join_lease(
                &session,
                &workflow,
                &preflight,
                "pause:operation",
                reused,
            ),
            Err(LeaseError::ProtocolViolation)
        ));
    }
    let oversized_id = "x".repeat(65);
    assert!(matches!(
        root.issue_pause_join_lease(
            &session,
            &workflow,
            &preflight,
            &oversized_id,
            registry_lease(&scope, "pause-lease", "pause-admission", "mutation", 100),
        ),
        Err(LeaseError::InvalidInput)
    ));
    assert_eq!(root.test_lease_consumed("pause-lease"), None);
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
    root.test_set_lease_limit(LeaseRole::Mutation, 1);
    let request = registry_lease(&scope, "pause-lease", "pause-admission", "mutation", 100);
    assert!(matches!(
        root.issue_pause_join_lease(
            &session,
            &workflow,
            &preflight,
            "pause:operation",
            request.clone()
        ),
        Err(LeaseError::Capacity)
    ));
    assert_eq!(root.test_lease_consumed("pause-lease"), None);
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
    root.test_set_lease_limit(LeaseRole::Mutation, 2);
    let reply = root
        .issue_pause_join_lease(
            &session,
            &workflow,
            &preflight,
            "pause:operation",
            request.clone(),
        )
        .unwrap();
    assert_eq!(root.test_lease_consumed("pause-lease"), Some(false));
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
    assert_eq!(root.test_reserved_revisions(), 11);
    assert_eq!(
        root.test_native_client().state().phase,
        OperationsPhase::Candidate
    );
    tokio::time::sleep(Duration::from_millis(110)).await;
    assert_eq!(
        root.issue_pause_join_lease(
            &session,
            &workflow,
            &preflight,
            "pause:operation",
            request.clone()
        )
        .unwrap(),
        reply
    );
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
    assert!(matches!(
        root.issue_pause_join_lease(
            &session,
            &workflow,
            &preflight,
            "another-pause",
            request.clone()
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    assert!(matches!(
        root.issue_pause_join_lease(
            &session,
            &workflow,
            &preflight,
            "pause:operation",
            registry_lease(
                &scope,
                "another-lease",
                "another-admission",
                "mutation",
                100
            )
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    assert_eq!(
        root.test_native_client().state().phase,
        OperationsPhase::Candidate
    );
}

#[tokio::test]
async fn registry_pause_lease_requires_recovered_acceptance_and_real_candidate() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-pause-recovered");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let mutation = root.test_session("alice", LeaseRole::Mutation);
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let change = change("pause-recovered");
    let workflow = root.reserve_workflow(&mutation, change.clone()).unwrap();
    let first_lease = root
        .issue_preflight_lease(
            &mutation,
            &workflow,
            registry_lease(
                &scope,
                "recovered-preflight-lease",
                "recovered-preflight",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    let original = registry_preflight(&scope, &change, "recovered-preflight", &first_lease);
    let preflight = match root
        .register_preflight(&mutation, &workflow, original.clone())
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new registration expected"),
    };
    root.test_set_dispatch_fault(&mutation, &preflight, TestDispatchFault::ProjectionPanic);
    let unknown = root.dispatch_preflight(&mutation, &preflight).unwrap();
    assert_eq!(unknown.as_value()["outcome"]["kind"], "unknown");
    let pause_request = registry_lease(
        &scope,
        "recovered-pause-lease",
        "recovered-pause",
        "mutation",
        1000,
    );
    assert!(matches!(
        root.issue_pause_join_lease(
            &mutation,
            &workflow,
            &preflight,
            "recovered:pause",
            pause_request.clone()
        ),
        Err(LeaseError::Busy)
    ));
    assert_eq!(root.test_lease_consumed("recovered-pause-lease"), None);
    for _ in 0..100 {
        if root
            .preflight_completion(&mutation, &preflight)
            .unwrap()
            .is_some()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        root.preflight_completion(&mutation, &preflight)
            .unwrap()
            .unwrap()
            .as_value()["outcome"]["kind"],
        "candidate"
    );
    assert!(matches!(
        root.issue_pause_join_lease(
            &mutation,
            &workflow,
            &preflight,
            "recovered:pause",
            pause_request.clone()
        ),
        Err(LeaseError::Busy)
    ));
    let inspection = root
        .inspect_preflight_admission(
            &read,
            &workflow,
            registry_inspection(&original, "recovered-inspection"),
        )
        .unwrap();
    assert_eq!(
        inspection.as_value()["outcome"]["reply"]["outcome"]["kind"],
        "accepted"
    );
    let pause_lease = root
        .issue_pause_join_lease(
            &mutation,
            &workflow,
            &preflight,
            "recovered:pause",
            pause_request,
        )
        .unwrap();
    assert_eq!(
        root.preflight_reply(&mutation, &preflight).unwrap(),
        Some(unknown.clone())
    );
    assert_eq!(
        root.test_native_client().state().phase,
        OperationsPhase::Candidate
    );
    let change_ref = inspection.as_value()["outcome"]["reply"]["outcome"]["handle"]["changeRef"]
        .as_str()
        .unwrap();
    let admission = registry_pause_admission(
        &scope,
        &change,
        "recovered-pause",
        &pause_lease,
        change_ref,
        "recovered:pause",
    );
    let pause_ticket = match root
        .register_pause_join(&mutation, &workflow, &preflight, admission)
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("new pause"),
    };
    assert_eq!(
        root.dispatch_pause_join(&mutation, &pause_ticket)
            .unwrap()
            .as_value()["outcome"]["kind"],
        "accepted"
    );
    for _ in 0..100 {
        if root
            .pause_completion(&mutation, &pause_ticket)
            .unwrap()
            .is_some()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        root.pause_completion(&mutation, &pause_ticket)
            .unwrap()
            .unwrap()
            .as_value()["outcome"]["kind"],
        "paused"
    );
    root.issue_apply_lease(
        &mutation,
        &workflow,
        &pause_ticket,
        "recovered:apply",
        registry_lease(
            &scope,
            "recovered-apply-lease",
            "recovered-apply",
            "mutation",
            1000,
        ),
    )
    .unwrap();
    assert_eq!(
        root.preflight_reply(&mutation, &preflight).unwrap(),
        Some(unknown)
    );
    assert_eq!(
        root.test_native_client().state().phase,
        OperationsPhase::Paused
    );
}

#[tokio::test]
async fn registry_pause_lease_waits_for_the_original_handle_completion() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-pause-pending");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let session = root.test_session("alice", LeaseRole::Mutation);
    let change = change("pause-pending");
    let workflow = root.reserve_workflow(&session, change.clone()).unwrap();
    let first_lease = root
        .issue_preflight_lease(
            &session,
            &workflow,
            registry_lease(
                &scope,
                "pending-preflight-lease",
                "pending-preflight",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    let preflight = match root
        .register_preflight(
            &session,
            &workflow,
            registry_preflight(&scope, &change, "pending-preflight", &first_lease),
        )
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new registration expected"),
    };
    let gate = Arc::new(driver::TestGate::default());
    let client = root.test_native_client();
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    drop(client);
    assert_eq!(
        root.dispatch_preflight(&session, &preflight)
            .unwrap()
            .as_value()["outcome"]["kind"],
        "accepted"
    );
    gate.entered.notified().await;
    let bytes = root.test_used_bytes(LeaseRole::Mutation);
    let request = registry_lease(
        &scope,
        "pending-pause-lease",
        "pending-pause",
        "mutation",
        1000,
    );
    assert!(matches!(
        root.issue_pause_join_lease(
            &session,
            &workflow,
            &preflight,
            "pending:pause",
            request.clone()
        ),
        Err(LeaseError::Busy)
    ));
    assert_eq!(root.test_lease_consumed("pending-pause-lease"), None);
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
    gate.release.notify_one();
    for _ in 0..100 {
        if root
            .preflight_completion(&session, &preflight)
            .unwrap()
            .is_some()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(root
        .preflight_completion(&session, &preflight)
        .unwrap()
        .is_some());
    root.issue_pause_join_lease(&session, &workflow, &preflight, "pending:pause", request)
        .unwrap();
    assert_eq!(
        root.test_native_client().state().phase,
        OperationsPhase::Candidate
    );
}

#[tokio::test]
async fn registry_preflight_lease_history_is_partitioned_from_read_history() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-1");
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let mutation = root.test_session("alice", LeaseRole::Mutation);
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let workflow = root
        .reserve_workflow(&mutation, change("workflow-partition"))
        .unwrap();
    root.issue_lease(
        &read,
        registry_lease(&scope, "read-1", "read-admission-1", "reconciliation", 5),
    )
    .unwrap();
    root.test_set_lease_limit(LeaseRole::Mutation, 4);
    assert!(root
        .issue_preflight_lease_at(
            &mutation,
            &workflow,
            registry_lease(&scope, "lease-1", "admission-1", "mutation", 5),
            std::time::Instant::now(),
        )
        .is_ok());
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

#[tokio::test]
async fn registry_reconciliation_reads_only_the_saved_original_apply_once() {
    for (epoch, fault, outcome) in [
        (
            "epoch-reconcile-found",
            driver::TestFault::LostResponse,
            "receiptFound",
        ),
        (
            "epoch-reconcile-missing",
            driver::TestFault::Full,
            "notFound",
        ),
    ] {
        let (mut root, mutation, workflow, pause, apply, _dir) =
            ready_apply_registry(epoch, 1000).await;
        let client = root.test_native_client();
        let apply_ticket = match root
            .register_apply(&mutation, &workflow, &pause, apply.clone())
            .unwrap()
        {
            ApplyRegistration::Registered(ticket) => ticket,
            _ => panic!("new apply"),
        };
        *client.shared.fault.lock().unwrap() = Some(fault);
        let original_reply = root.dispatch_apply(&mutation, &apply_ticket).unwrap();
        let original_completion = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(value) = root.apply_completion(&mutation, &apply_ticket).unwrap() {
                    break value;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(original_completion.as_value()["outcome"]["kind"], "failed");
        let read = root.test_session("alice", LeaseRole::Reconciliation);
        let scope = registry_scope(epoch);
        let lease = root
            .issue_lease(
                &read,
                registry_lease(
                    &scope,
                    "read-lease",
                    "read-admission",
                    "reconciliation",
                    1000,
                ),
            )
            .unwrap();
        let admission = registry_reconciliation_admission(
            &scope,
            &apply,
            "read-admission",
            &lease,
            original_reply.as_value()["outcome"]["handle"]["changeRef"]
                .as_str()
                .unwrap(),
            original_reply.as_value()["outcome"]["handle"]["operationRef"]
                .as_str()
                .unwrap(),
        );
        let foreign = root.test_session("bob", LeaseRole::Reconciliation);
        assert!(matches!(
            root.register_reconciliation(&foreign, &workflow, &apply_ticket, admission.clone()),
            Err(LeaseError::Forbidden)
        ));
        let mut wrong = admission.as_value().clone();
        wrong["action"]["operationRef"] = json!("other-apply");
        assert!(matches!(
            root.register_reconciliation(
                &read,
                &workflow,
                &apply_ticket,
                RecordingAdmissionRequest::from_value(wrong).unwrap()
            ),
            Err(LeaseError::ProtocolViolation)
        ));
        let ticket = match root
            .register_reconciliation(&read, &workflow, &apply_ticket, admission.clone())
            .unwrap()
        {
            ReconciliationRegistration::Registered(ticket) => ticket,
            _ => panic!("new reconciliation"),
        };
        assert!(matches!(
            root.register_reconciliation(&read, &workflow, &apply_ticket, admission)
                .unwrap(),
            ReconciliationRegistration::Existing(_)
        ));
        let accepted = root.dispatch_reconciliation(&read, &ticket).unwrap();
        assert_eq!(accepted.as_value()["outcome"]["kind"], "accepted");
        let delivery = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(value) = root.reconciliation_delivery(&read, &ticket).unwrap() {
                    break value;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(delivery.as_value()["outcome"]["kind"], "result");
        assert_eq!(
            delivery.as_value()["outcome"]["result"]["outcome"]["kind"],
            outcome
        );
        assert_eq!(
            delivery.as_value()["outcome"]["result"]["recoveryRequired"],
            true
        );
        assert_eq!(client.shared.reconcile_calls.load(Ordering::Relaxed), 1);
        assert_eq!(
            root.dispatch_reconciliation(&read, &ticket).unwrap(),
            accepted
        );
        assert_eq!(
            root.reconciliation_reply(&read, &ticket).unwrap(),
            Some(accepted)
        );
        assert_eq!(
            root.apply_reply(&mutation, &apply_ticket).unwrap(),
            Some(original_reply)
        );
        assert_eq!(
            root.apply_completion(&mutation, &apply_ticket)
                .unwrap()
                .unwrap(),
            original_completion
        );
        assert_eq!(client.shared.reconcile_calls.load(Ordering::Relaxed), 1);
        assert!(client.state().recovery_required);
    }
}

#[tokio::test]
async fn registry_reconciliation_expiry_and_one_byte_short_keep_read_lease_unconsumed() {
    let epoch = "epoch-reconcile-limits";
    let (mut root, mutation, workflow, pause, apply, _dir) =
        ready_apply_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let apply_ticket = match root
        .register_apply(&mutation, &workflow, &pause, apply.clone())
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::Full);
    let original_reply = root.dispatch_apply(&mutation, &apply_ticket).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while root
            .apply_completion(&mutation, &apply_ticket)
            .unwrap()
            .is_none()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let scope = registry_scope(epoch);
    let lease = root
        .issue_lease(
            &read,
            registry_lease(
                &scope,
                "read-lease",
                "read-admission",
                "reconciliation",
                1000,
            ),
        )
        .unwrap();
    let admission = registry_reconciliation_admission(
        &scope,
        &apply,
        "read-admission",
        &lease,
        original_reply.as_value()["outcome"]["handle"]["changeRef"]
            .as_str()
            .unwrap(),
        original_reply.as_value()["outcome"]["handle"]["operationRef"]
            .as_str()
            .unwrap(),
    );
    let before = root.test_used_bytes(LeaseRole::Reconciliation);
    let needed = crate::recording_registry::kernel::budget::LifetimeBudget::for_request(&admission)
        .unwrap()
        .bytes()
        .unwrap()
        + crate::recording_registry::kernel::budget::READ_ID_BYTES;
    root.test_set_byte_limit(LeaseRole::Reconciliation, before + needed - 1);
    assert!(matches!(
        root.register_reconciliation(&read, &workflow, &apply_ticket, admission.clone()),
        Err(LeaseError::Capacity)
    ));
    assert_eq!(root.test_lease_consumed("read-lease"), Some(false));
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), before);
    root.test_set_byte_limit(LeaseRole::Reconciliation, before + needed);
    assert!(matches!(
        root.register_reconciliation_at(
            &read,
            &workflow,
            &apply_ticket,
            admission.clone(),
            Instant::now() + Duration::from_secs(2)
        ),
        Err(LeaseError::Expired)
    ));
    assert_eq!(root.test_lease_consumed("read-lease"), Some(false));
    assert_eq!(client.shared.reconcile_calls.load(Ordering::Relaxed), 0);
    assert!(matches!(
        root.register_reconciliation(&read, &workflow, &apply_ticket, admission)
            .unwrap(),
        ReconciliationRegistration::Registered(_)
    ));
}

#[tokio::test]
async fn registry_reconciliation_uses_saved_handle_after_original_reply_projection_failure() {
    let epoch = "epoch-reconcile-unknown-apply";
    let (mut root, mutation, workflow, pause, apply, _dir) =
        ready_apply_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let apply_ticket = match root
        .register_apply(&mutation, &workflow, &pause, apply.clone())
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    root.test_set_apply_dispatch_fault(
        &mutation,
        &apply_ticket,
        ApplyDispatchFault::ProjectionPanic,
    );
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::LostResponse);
    let original_reply = root.dispatch_apply(&mutation, &apply_ticket).unwrap();
    assert_eq!(original_reply.as_value()["outcome"]["kind"], "unknown");
    tokio::time::timeout(Duration::from_secs(5), async {
        while root
            .apply_completion(&mutation, &apply_ticket)
            .unwrap()
            .is_none()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let scope = registry_scope(epoch);
    let lease = root
        .issue_lease(
            &read,
            registry_lease(
                &scope,
                "read-lease",
                "read-admission",
                "reconciliation",
                1000,
            ),
        )
        .unwrap();
    let admission = registry_reconciliation_admission(
        &scope,
        &apply,
        "read-admission",
        &lease,
        apply.as_value()["action"]["changeRef"].as_str().unwrap(),
        apply.as_value()["action"]["operation"]["operationId"]
            .as_str()
            .unwrap(),
    );
    let ticket = match root
        .register_reconciliation(&read, &workflow, &apply_ticket, admission)
        .unwrap()
    {
        ReconciliationRegistration::Registered(ticket) => ticket,
        _ => panic!("new reconciliation"),
    };
    assert_eq!(
        root.dispatch_reconciliation(&read, &ticket)
            .unwrap()
            .as_value()["outcome"]["kind"],
        "accepted"
    );
    let delivery = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(value) = root.reconciliation_delivery(&read, &ticket).unwrap() {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        delivery.as_value()["outcome"]["result"]["outcome"]["kind"],
        "receiptFound"
    );
    assert_eq!(
        root.apply_reply(&mutation, &apply_ticket).unwrap(),
        Some(original_reply)
    );
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert_eq!(client.shared.reconcile_calls.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn registry_reconciliation_worker_panic_remains_read_uncertain() {
    let epoch = "epoch-reconcile-worker-panic";
    let (mut root, mutation, workflow, pause, apply, _dir) =
        ready_apply_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let apply_ticket = match root
        .register_apply(&mutation, &workflow, &pause, apply.clone())
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::Full);
    let original_reply = root.dispatch_apply(&mutation, &apply_ticket).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while root
            .apply_completion(&mutation, &apply_ticket)
            .unwrap()
            .is_none()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let scope = registry_scope(epoch);
    let lease = root
        .issue_lease(
            &read,
            registry_lease(
                &scope,
                "read-lease",
                "read-admission",
                "reconciliation",
                1000,
            ),
        )
        .unwrap();
    let admission = registry_reconciliation_admission(
        &scope,
        &apply,
        "read-admission",
        &lease,
        original_reply.as_value()["outcome"]["handle"]["changeRef"]
            .as_str()
            .unwrap(),
        original_reply.as_value()["outcome"]["handle"]["operationRef"]
            .as_str()
            .unwrap(),
    );
    let ticket = match root
        .register_reconciliation(&read, &workflow, &apply_ticket, admission)
        .unwrap()
    {
        ReconciliationRegistration::Registered(ticket) => ticket,
        _ => panic!("new reconciliation"),
    };
    *client.shared.read_fault.lock().unwrap() =
        Some(reconciliation::driver::TestFault::WorkerPanic);
    assert_eq!(
        root.dispatch_reconciliation(&read, &ticket)
            .unwrap()
            .as_value()["outcome"]["kind"],
        "accepted"
    );
    let delivery = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(value) = root.reconciliation_delivery(&read, &ticket).unwrap() {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(delivery.as_value()["outcome"]["kind"], "readUncertain");
    assert_eq!(
        root.apply_reply(&mutation, &apply_ticket).unwrap(),
        Some(original_reply)
    );
    assert_eq!(client.shared.reconcile_calls.load(Ordering::Relaxed), 1);
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
}

#[tokio::test]
async fn registry_reconciliation_accepts_later_native_recovery_latch() {
    let epoch = "epoch-reconcile-later-latch";
    let (mut root, mutation, workflow, pause, apply, _dir) =
        ready_apply_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let apply_ticket = match root
        .register_apply(&mutation, &workflow, &pause, apply.clone())
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    let original_reply = root.dispatch_apply(&mutation, &apply_ticket).unwrap();
    let completion = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(value) = root.apply_completion(&mutation, &apply_ticket).unwrap() {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(completion.as_value()["outcome"]["kind"], "applied");
    assert_eq!(completion.as_value()["quiescence"], "confirmed");
    assert_eq!(completion.as_value()["recoveryRequired"], false);
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let scope = registry_scope(epoch);
    let lease = root
        .issue_lease(
            &read,
            registry_lease(
                &scope,
                "read-lease",
                "read-admission",
                "reconciliation",
                1000,
            ),
        )
        .unwrap();
    let admission = registry_reconciliation_admission(
        &scope,
        &apply,
        "read-admission",
        &lease,
        original_reply.as_value()["outcome"]["handle"]["changeRef"]
            .as_str()
            .unwrap(),
        original_reply.as_value()["outcome"]["handle"]["operationRef"]
            .as_str()
            .unwrap(),
    );
    assert!(matches!(
        root.register_reconciliation(&read, &workflow, &apply_ticket, admission.clone()),
        Err(LeaseError::Busy)
    ));
    assert_eq!(root.test_lease_consumed("read-lease"), Some(false));
    client
        .shared
        .core
        .lock()
        .unwrap()
        .supervisor
        .as_mut()
        .unwrap()
        .latch_recording_operations_recovery();
    let ticket = match root
        .register_reconciliation(&read, &workflow, &apply_ticket, admission)
        .unwrap()
    {
        ReconciliationRegistration::Registered(ticket) => ticket,
        _ => panic!("new reconciliation"),
    };
    assert_eq!(
        root.dispatch_reconciliation(&read, &ticket)
            .unwrap()
            .as_value()["outcome"]["kind"],
        "accepted"
    );
    let delivery = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(value) = root.reconciliation_delivery(&read, &ticket).unwrap() {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        delivery.as_value()["outcome"]["result"]["outcome"]["kind"],
        "receiptFound"
    );
    assert_eq!(
        root.apply_completion(&mutation, &apply_ticket)
            .unwrap()
            .unwrap(),
        completion
    );
    assert_eq!(
        root.apply_reply(&mutation, &apply_ticket).unwrap(),
        Some(original_reply)
    );
}

#[tokio::test]
async fn registry_reconciliation_rejects_unfinished_apply_and_foreign_ticket() {
    let epoch = "epoch-reconcile-source-gate";
    let (mut root, mutation, workflow, pause, apply, _dir) =
        ready_apply_registry(epoch, 1000).await;
    let apply_ticket = match root
        .register_apply(&mutation, &workflow, &pause, apply.clone())
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let scope = registry_scope(epoch);
    let lease = root
        .issue_lease(
            &read,
            registry_lease(
                &scope,
                "read-lease",
                "read-admission",
                "reconciliation",
                1000,
            ),
        )
        .unwrap();
    let admission = registry_reconciliation_admission(
        &scope,
        &apply,
        "read-admission",
        &lease,
        apply.as_value()["action"]["changeRef"].as_str().unwrap(),
        apply.as_value()["action"]["operation"]["operationId"]
            .as_str()
            .unwrap(),
    );
    assert!(matches!(
        root.register_reconciliation(&read, &workflow, &apply_ticket, admission.clone()),
        Err(LeaseError::Busy)
    ));
    assert_eq!(root.test_lease_consumed("read-lease"), Some(false));
    let (mut foreign_root, foreign_mutation, foreign_workflow, foreign_pause, foreign_apply, _dir) =
        ready_apply_registry("epoch-reconcile-foreign", 1000).await;
    let foreign_ticket = match foreign_root
        .register_apply(
            &foreign_mutation,
            &foreign_workflow,
            &foreign_pause,
            foreign_apply,
        )
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new foreign apply"),
    };
    assert!(matches!(
        root.register_reconciliation(&read, &workflow, &foreign_ticket, admission),
        Err(LeaseError::Forbidden)
    ));
    assert_eq!(root.test_lease_consumed("read-lease"), Some(false));
}

#[tokio::test]
async fn registry_discard_candidate_after_expired_pause_lease_is_one_native_call() {
    let epoch = "epoch-discard-candidate";
    let (mut root, session, workflow, preflight, pause_admission, dir) =
        ready_pause_registry(epoch, 100).await;
    let client = root.test_native_client();
    let before = sqlite_applied_revision(&dir.0);
    let scope = registry_scope(epoch);
    let discard_lease = registry_lease(
        &scope,
        "discard-lease",
        "discard-admission",
        "mutation",
        1000,
    );
    assert!(matches!(
        root.issue_discard_lease(&session, &workflow, &preflight, discard_lease.clone()),
        Err(LeaseError::Busy)
    ));
    tokio::time::sleep(Duration::from_millis(150)).await;
    let change = change("pause-ready");
    let lease = root
        .issue_discard_lease(&session, &workflow, &preflight, discard_lease)
        .unwrap();
    let admission = registry_discard_admission(
        &scope,
        &change,
        "discard-admission",
        &lease,
        pause_admission.as_value()["action"]["changeRef"]
            .as_str()
            .unwrap(),
    );
    let bob = root.test_session("bob", LeaseRole::Mutation);
    assert!(matches!(
        root.register_discard(&bob, &workflow, &preflight, admission.clone()),
        Err(LeaseError::Forbidden)
    ));
    let mut wrong = admission.as_value().clone();
    wrong["action"]["change"]["changeId"] = json!("other");
    assert!(matches!(
        root.register_discard(
            &session,
            &workflow,
            &preflight,
            RecordingAdmissionRequest::from_value(wrong).unwrap()
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    let ticket = match root
        .register_discard(&session, &workflow, &preflight, admission.clone())
        .unwrap()
    {
        DiscardRegistration::Registered(ticket) => ticket,
        _ => panic!("new discard"),
    };
    assert!(matches!(
        root.register_discard(&session, &workflow, &preflight, admission)
            .unwrap(),
        DiscardRegistration::Existing(_)
    ));
    assert_eq!(root.discard_reply(&session, &ticket).unwrap(), None);
    let reserved_before = root.test_used_bytes(LeaseRole::Mutation);
    let reply = root.dispatch_discard(&session, &ticket).unwrap();
    assert_eq!(reply.as_value()["outcome"]["kind"], "completedDiscard");
    let reserved_after = root.test_used_bytes(LeaseRole::Mutation);
    assert!(reserved_after < reserved_before);
    // The issued but expired pause slot remains in history; only unissued apply is returned.
    assert_eq!(root.test_reserved_revisions(), 8);
    assert_eq!(client.state().phase, OperationsPhase::Idle);
    assert_eq!(
        root.discard_reply(&session, &ticket).unwrap(),
        Some(reply.clone())
    );
    assert_eq!(root.dispatch_discard(&session, &ticket).unwrap(), reply);
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), reserved_after);
    assert_eq!(root.test_reserved_revisions(), 8);
    assert_eq!(client.shared.discard_calls.load(Ordering::Relaxed), 1);
    assert_eq!(sqlite_applied_revision(&dir.0), before);
}

#[tokio::test]
async fn registry_discard_paused_candidate_does_not_resume_or_apply() {
    let epoch = "epoch-discard-paused";
    let (mut root, session, workflow, preflight, pause_admission, dir) =
        ready_pause_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let before = sqlite_applied_revision(&dir.0);
    let pause = match root
        .register_pause_join(&session, &workflow, &preflight, pause_admission.clone())
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("new pause"),
    };
    assert_eq!(
        root.dispatch_pause_join(&session, &pause)
            .unwrap()
            .as_value()["outcome"]["kind"],
        "accepted"
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while root.pause_completion(&session, &pause).unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(client.state().phase, OperationsPhase::Paused);
    let scope = registry_scope(epoch);
    let change = change("pause-ready");
    let lease = root
        .issue_discard_lease(
            &session,
            &workflow,
            &preflight,
            registry_lease(
                &scope,
                "discard-lease",
                "discard-admission",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    assert!(matches!(
        root.issue_apply_lease(
            &session,
            &workflow,
            &pause,
            "apply:blocked",
            registry_lease(
                &scope,
                "apply-blocked-lease",
                "apply-blocked-admission",
                "mutation",
                1000
            )
        ),
        Err(LeaseError::Busy)
    ));
    let admission = registry_discard_admission(
        &scope,
        &change,
        "discard-admission",
        &lease,
        pause_admission.as_value()["action"]["changeRef"]
            .as_str()
            .unwrap(),
    );
    let ticket = match root
        .register_discard(&session, &workflow, &preflight, admission)
        .unwrap()
    {
        DiscardRegistration::Registered(ticket) => ticket,
        _ => panic!("new discard"),
    };
    let reserved_before = root.test_used_bytes(LeaseRole::Mutation);
    assert_eq!(
        root.dispatch_discard(&session, &ticket).unwrap().as_value()["outcome"]["kind"],
        "completedDiscard"
    );
    assert!(root.test_used_bytes(LeaseRole::Mutation) < reserved_before);
    assert_eq!(root.test_reserved_revisions(), 8);
    assert_eq!(client.state().phase, OperationsPhase::Idle);
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 0);
    assert_eq!(client.shared.discard_calls.load(Ordering::Relaxed), 1);
    assert_eq!(sqlite_applied_revision(&dir.0), before);
}

#[tokio::test]
async fn registry_discard_after_typed_apply_rejection_keeps_both_original_replies() {
    let epoch = "epoch-discard-rejected-apply";
    let (mut root, session, workflow, pause, apply, dir) = ready_apply_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let before = sqlite_applied_revision(&dir.0);
    let apply_ticket = match root
        .register_apply(&session, &workflow, &pause, apply.clone())
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    client
        .shared
        .core
        .lock()
        .unwrap()
        .registry
        .used
        .insert((true, "apply:ready".into()));
    let rejected = root.dispatch_apply(&session, &apply_ticket).unwrap();
    assert_eq!(rejected.as_value()["outcome"]["kind"], "rejected");
    assert_eq!(client.state().phase, OperationsPhase::Paused);
    let scope = registry_scope(epoch);
    let change = change("pause-ready");
    let preflight = {
        // The first workflow's immutable preflight ticket remains stored after apply rejection.
        root.test_preflight_ticket(&session, &workflow)
    };
    let lease = root
        .issue_discard_lease(
            &session,
            &workflow,
            &preflight,
            registry_lease(
                &scope,
                "discard-lease",
                "discard-admission",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    let admission = registry_discard_admission(
        &scope,
        &change,
        "discard-admission",
        &lease,
        apply.as_value()["action"]["changeRef"].as_str().unwrap(),
    );
    let ticket = match root
        .register_discard(&session, &workflow, &preflight, admission)
        .unwrap()
    {
        DiscardRegistration::Registered(ticket) => ticket,
        _ => panic!("new discard"),
    };
    let discard = root.dispatch_discard(&session, &ticket).unwrap();
    assert_eq!(discard.as_value()["outcome"]["kind"], "completedDiscard");
    assert_eq!(
        root.apply_reply(&session, &apply_ticket).unwrap(),
        Some(rejected)
    );
    assert_eq!(
        root.discard_reply(&session, &ticket).unwrap(),
        Some(discard)
    );
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert_eq!(client.shared.discard_calls.load(Ordering::Relaxed), 1);
    assert_eq!(sqlite_applied_revision(&dir.0), before);
}

#[tokio::test]
async fn registry_discard_lost_response_keeps_unknown_even_after_native_idle() {
    let epoch = "epoch-discard-lost-response";
    let (mut root, session, workflow, preflight, pause_admission, dir) =
        ready_pause_registry(epoch, 1).await;
    let client = root.test_native_client();
    let before = sqlite_applied_revision(&dir.0);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let scope = registry_scope(epoch);
    let change = change("pause-ready");
    let lease = root
        .issue_discard_lease(
            &session,
            &workflow,
            &preflight,
            registry_lease(
                &scope,
                "discard-lease",
                "discard-admission",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    let admission = registry_discard_admission(
        &scope,
        &change,
        "discard-admission",
        &lease,
        pause_admission.as_value()["action"]["changeRef"]
            .as_str()
            .unwrap(),
    );
    let ticket = match root
        .register_discard(&session, &workflow, &preflight, admission)
        .unwrap()
    {
        DiscardRegistration::Registered(ticket) => ticket,
        _ => panic!("new discard"),
    };
    root.test_set_discard_dispatch_fault(
        &session,
        &ticket,
        DiscardDispatchFault::NativePanicAfterCall,
    );
    let reserved_before = root.test_used_bytes(LeaseRole::Mutation);
    let unknown = root.dispatch_discard(&session, &ticket).unwrap();
    assert_eq!(unknown.as_value()["outcome"]["kind"], "unknown");
    assert_eq!(client.state().phase, OperationsPhase::Idle);
    assert_eq!(root.dispatch_discard(&session, &ticket).unwrap(), unknown);
    assert_eq!(
        root.discard_reply(&session, &ticket).unwrap(),
        Some(unknown)
    );
    assert_eq!(client.shared.discard_calls.load(Ordering::Relaxed), 1);
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), reserved_before);
    assert_eq!(root.test_reserved_revisions(), 11);
    assert_eq!(sqlite_applied_revision(&dir.0), before);
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
}

#[tokio::test]
async fn registry_discard_recovered_preflight_unknown_allows_handoff() {
    let epoch = "epoch-discard-recovered-preflight";
    let (owner, _dir) = setup();
    let scope = registry_scope(epoch);
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let mutation = root.test_session("alice", LeaseRole::Mutation);
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let change = change("recovered-discard");
    let workflow = root.reserve_workflow(&mutation, change.clone()).unwrap();
    let preflight_lease = root
        .issue_preflight_lease(
            &mutation,
            &workflow,
            registry_lease(&scope, "preflight-lease", "preflight", "mutation", 1000),
        )
        .unwrap();
    let original = registry_preflight(&scope, &change, "preflight", &preflight_lease);
    let preflight = match root
        .register_preflight(&mutation, &workflow, original.clone())
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new preflight"),
    };
    root.test_set_dispatch_fault(&mutation, &preflight, TestDispatchFault::ProjectionPanic);
    let unknown = root.dispatch_preflight(&mutation, &preflight).unwrap();
    assert_eq!(unknown.as_value()["outcome"]["kind"], "unknown");
    tokio::time::timeout(Duration::from_secs(5), async {
        while root
            .preflight_completion(&mutation, &preflight)
            .unwrap()
            .is_none()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let inspection = root
        .inspect_preflight_admission(
            &read,
            &workflow,
            registry_inspection(&original, "inspect-preflight"),
        )
        .unwrap();
    let recovered = &inspection.as_value()["outcome"]["reply"];
    assert_eq!(recovered["outcome"]["kind"], "accepted");
    let discard_lease = root
        .issue_discard_lease(
            &mutation,
            &workflow,
            &preflight,
            registry_lease(&scope, "discard-lease", "discard", "mutation", 1000),
        )
        .unwrap();
    let admission = registry_discard_admission(
        &scope,
        &change,
        "discard",
        &discard_lease,
        recovered["outcome"]["handle"]["changeRef"]
            .as_str()
            .unwrap(),
    );
    let discard = match root
        .register_discard(&mutation, &workflow, &preflight, admission)
        .unwrap()
    {
        DiscardRegistration::Registered(ticket) => ticket,
        _ => panic!("new discard"),
    };
    assert_eq!(
        root.dispatch_discard(&mutation, &discard)
            .unwrap()
            .as_value()["outcome"]["kind"],
        "completedDiscard"
    );
    assert_eq!(
        root.preflight_reply(&mutation, &preflight).unwrap(),
        Some(unknown)
    );
    assert_eq!(root.test_reserved_revisions(), 5);
    assert!(root.try_handoff().is_ok());
}

#[tokio::test]
async fn registry_discard_lease_blocks_new_pause_and_expired_registration_is_atomic() {
    let epoch = "epoch-discard-intent-gate";
    let (mut root, session, workflow, preflight, accepted, _dir) =
        ready_discard_candidate_registry(epoch).await;
    let client = root.test_native_client();
    let scope = registry_scope(epoch);
    let change = change("pause-ready");
    let lease_request = registry_lease(
        &scope,
        "discard-lease",
        "discard-admission",
        "mutation",
        1000,
    );
    let lease = root
        .issue_discard_lease(&session, &workflow, &preflight, lease_request.clone())
        .unwrap();
    assert_eq!(
        root.issue_discard_lease(&session, &workflow, &preflight, lease_request)
            .unwrap(),
        lease
    );
    assert!(matches!(
        root.issue_pause_join_lease(
            &session,
            &workflow,
            &preflight,
            "pause:blocked",
            registry_lease(&scope, "pause-lease", "pause-admission", "mutation", 1000)
        ),
        Err(LeaseError::Busy)
    ));
    let admission = registry_discard_admission(
        &scope,
        &change,
        "discard-admission",
        &lease,
        accepted.as_value()["outcome"]["handle"]["changeRef"]
            .as_str()
            .unwrap(),
    );
    assert!(matches!(
        root.register_discard_at(
            &session,
            &workflow,
            &preflight,
            admission.clone(),
            Instant::now() + Duration::from_secs(2)
        ),
        Err(LeaseError::Expired)
    ));
    assert_eq!(root.test_lease_consumed("discard-lease"), Some(false));
    assert_eq!(client.shared.discard_calls.load(Ordering::Relaxed), 0);
    let ticket = match root
        .register_discard(&session, &workflow, &preflight, admission)
        .unwrap()
    {
        DiscardRegistration::Registered(ticket) => ticket,
        _ => panic!("new discard"),
    };
    let reserved_before = root.test_used_bytes(LeaseRole::Mutation);
    assert!(matches!(
        root.issue_pause_join_lease(
            &session,
            &workflow,
            &preflight,
            "pause:blocked",
            registry_lease(&scope, "pause-lease", "pause-admission", "mutation", 1000)
        ),
        Err(LeaseError::Busy)
    ));
    assert_eq!(
        root.dispatch_discard(&session, &ticket).unwrap().as_value()["outcome"]["kind"],
        "completedDiscard"
    );
    assert_eq!(client.shared.discard_calls.load(Ordering::Relaxed), 1);
    assert!(root.test_used_bytes(LeaseRole::Mutation) < reserved_before);
    assert_eq!(root.test_reserved_revisions(), 5);
}

#[tokio::test]
async fn registry_discard_after_expired_apply_lease_preserves_paused_candidate() {
    let epoch = "epoch-discard-expired-apply";
    let (mut root, session, workflow, _pause, apply, dir) = ready_apply_registry(epoch, 100).await;
    let client = root.test_native_client();
    let preflight = root.test_preflight_ticket(&session, &workflow);
    let scope = registry_scope(epoch);
    let before = sqlite_applied_revision(&dir.0);
    let request = registry_lease(
        &scope,
        "discard-lease",
        "discard-admission",
        "mutation",
        1000,
    );
    assert!(matches!(
        root.issue_discard_lease(&session, &workflow, &preflight, request.clone()),
        Err(LeaseError::Busy)
    ));
    tokio::time::sleep(Duration::from_millis(150)).await;
    let lease = root
        .issue_discard_lease(&session, &workflow, &preflight, request)
        .unwrap();
    let admission = registry_discard_admission(
        &scope,
        &change("pause-ready"),
        "discard-admission",
        &lease,
        apply.as_value()["action"]["changeRef"].as_str().unwrap(),
    );
    let ticket = match root
        .register_discard(&session, &workflow, &preflight, admission)
        .unwrap()
    {
        DiscardRegistration::Registered(ticket) => ticket,
        _ => panic!("new discard"),
    };
    let reserved_before = root.test_used_bytes(LeaseRole::Mutation);
    assert_eq!(
        root.dispatch_discard(&session, &ticket).unwrap().as_value()["outcome"]["kind"],
        "completedDiscard"
    );
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 0);
    assert_eq!(client.shared.discard_calls.load(Ordering::Relaxed), 1);
    assert_eq!(client.state().phase, OperationsPhase::Idle);
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), reserved_before);
    assert_eq!(root.test_reserved_revisions(), 11);
    assert_eq!(sqlite_applied_revision(&dir.0), before);
}

#[tokio::test]
async fn registry_discard_dispatch_deadline_does_not_call_native() {
    let epoch = "epoch-discard-dispatch-expiry";
    let (mut root, session, workflow, preflight, accepted, dir) =
        ready_discard_candidate_registry(epoch).await;
    let client = root.test_native_client();
    let before = sqlite_applied_revision(&dir.0);
    let scope = registry_scope(epoch);
    let lease = root
        .issue_discard_lease(
            &session,
            &workflow,
            &preflight,
            registry_lease(
                &scope,
                "discard-lease",
                "discard-admission",
                "mutation",
                100,
            ),
        )
        .unwrap();
    let admission = registry_discard_admission(
        &scope,
        &change("pause-ready"),
        "discard-admission",
        &lease,
        accepted.as_value()["outcome"]["handle"]["changeRef"]
            .as_str()
            .unwrap(),
    );
    let ticket = match root
        .register_discard(&session, &workflow, &preflight, admission)
        .unwrap()
    {
        DiscardRegistration::Registered(ticket) => ticket,
        _ => panic!("new discard"),
    };
    tokio::time::sleep(Duration::from_millis(150)).await;
    let reply = root.dispatch_discard(&session, &ticket).unwrap();
    assert_eq!(reply.as_value()["outcome"]["kind"], "rejected");
    assert_eq!(reply.as_value()["outcome"]["error"], "deadlineExceeded");
    assert_eq!(root.discard_reply(&session, &ticket).unwrap(), Some(reply));
    assert_eq!(client.state().phase, OperationsPhase::Candidate);
    assert_eq!(client.shared.discard_calls.load(Ordering::Relaxed), 0);
    assert_eq!(sqlite_applied_revision(&dir.0), before);
}

#[tokio::test]
async fn registry_discard_running_candidate_keeps_the_recorder_running() {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let hub = crate::recorder_hub_fixture::Hub::new().await;
    let directory = RunningRegistryDirectory(std::env::temp_dir().join(format!(
        "scada-registry-discard-running-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed),
    )));
    let mut store = SqliteStore::create(
        &directory.0,
        StoreIdentity {
            store_id: "running-discard".into(),
            deployment_id: "test-deployment".into(),
        },
    )
    .unwrap();
    let sdk = crate::recorder_hub_fixture::plan(Some(7), Source::Real, false);
    let (plan_ref, binding) =
        crate::recording_host::tests::managed_support::apply(&mut store, sdk.session());
    let mut supervisor = RecordingSupervisor::try_new(store).unwrap();
    let run = supervisor
        .start_managed(
            sdk,
            RecordingOptions {
                plan: plan_ref,
                slot_count: None,
                max_clock_skew_ms: 1000,
                clock_epoch: "running-discard-clock".into(),
            },
            binding,
            control(),
            hub.client(),
        )
        .unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    socket
        .send(Message::Text(
            json!({"op":"data","id":1,"t":200,
        "values":[{"tag":crate::recorder_hub_fixture::NUMBER,"v":42,"q":"good","t":200}]})
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    let mut frames = supervisor.recording_watch();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if frames
                .borrow_and_update()
                .progress
                .as_ref()
                .is_some_and(|p| p.counters.committed_ticks >= 1)
            {
                break;
            }
            frames.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    assert_eq!(supervisor.state().recording.phase, RecordingPhase::Running);
    let epoch = "epoch-discard-running";
    let scope = registry_scope(epoch);
    let owner = RecordingOperationsOwner::try_new(supervisor, context(), run).unwrap();
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let session = root.test_session("alice", LeaseRole::Mutation);
    let mut change_value = change("running-discard").as_value().clone();
    change_value["apply"]["expectedAppliedRevision"] = json!(1);
    change_value["apply"]["expectedMappingRevision"] = json!(1);
    change_value["apply"]["expectedRetentionAppliedRevision"] = json!(1);
    change_value["apply"]["desired"] = json!({
        "version":1,"kind":"recordingPlan","planId":"desired","revision":1,"enabled":true,
        "group":{"groupId":"group","hubRef":"hub","periodMs":1000,
            "members":[{"memberId":"member:0","externalName":crate::recorder_hub_fixture::NUMBER,
                "valueType":"number"}]}
    });
    let change = RecordingChangeRequest::from_value(change_value).unwrap();
    let workflow = root.reserve_workflow(&session, change.clone()).unwrap();
    let preflight_lease = root
        .issue_preflight_lease(
            &session,
            &workflow,
            registry_lease(
                &scope,
                "preflight-lease",
                "preflight-admission",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    let preflight = match root
        .register_preflight(
            &session,
            &workflow,
            registry_preflight(&scope, &change, "preflight-admission", &preflight_lease),
        )
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new preflight"),
    };
    let accepted = root.dispatch_preflight(&session, &preflight).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while root
            .preflight_completion(&session, &preflight)
            .unwrap()
            .is_none()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        root.preflight_completion(&session, &preflight)
            .unwrap()
            .unwrap()
            .as_value()["outcome"]["kind"],
        "candidate"
    );
    let client = root.test_native_client();
    let before = sqlite_applied_revision(&directory.0);
    let lease = root
        .issue_discard_lease(
            &session,
            &workflow,
            &preflight,
            registry_lease(
                &scope,
                "discard-lease",
                "discard-admission",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    let admission = registry_discard_admission(
        &scope,
        &change,
        "discard-admission",
        &lease,
        accepted.as_value()["outcome"]["handle"]["changeRef"]
            .as_str()
            .unwrap(),
    );
    let ticket = match root
        .register_discard(&session, &workflow, &preflight, admission)
        .unwrap()
    {
        DiscardRegistration::Registered(ticket) => ticket,
        _ => panic!("new discard"),
    };
    assert_eq!(
        root.dispatch_discard(&session, &ticket).unwrap().as_value()["outcome"]["kind"],
        "completedDiscard"
    );
    assert_eq!(client.state().phase, OperationsPhase::Idle);
    assert_eq!(
        client
            .shared
            .core
            .lock()
            .unwrap()
            .supervisor
            .as_ref()
            .unwrap()
            .state()
            .recording
            .phase,
        RecordingPhase::Running
    );
    assert_eq!(client.shared.discard_calls.load(Ordering::Relaxed), 1);
    assert_eq!(sqlite_applied_revision(&directory.0), before);
}
