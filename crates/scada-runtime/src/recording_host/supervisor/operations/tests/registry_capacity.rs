//! Pool boundaries, maximum-size original replies and lease/dispatch deadlines on the real
//! owner (adapter design §7 acceptances 4 and 5).
use super::registry_observation::{
    handle_request, operation_observation, outcome, read_observation,
};
use super::registry_read_retry::{failed_apply, read_admission, registered};
use super::*;
use crate::recording_registry::kernel::budget::{LifetimeBudget, READ_ID_BYTES};
use crate::recording_registry::kernel::workflow::{stage, workflow as workflow_budget};
use crate::recording_registry::CountPool;
use scada_model::recording_wire::{
    RecordingWireAttachRequest, RecordingWireCallInspectionRequest, RecordingWireCancelRequest,
    RecordingWireControlRequest,
};

/// A schema-valid ID of the maximum length (64 characters), distinct per prefix.
fn max_id(prefix: &str) -> String {
    format!("{prefix}{}", "x".repeat(64 - prefix.len()))
}

/// A change whose own ID is of the maximum length (the plan inside keeps its fixture IDs).
fn max_change() -> RecordingChangeRequest {
    let mut value = change("max-reply").as_value().clone();
    value["changeId"] = json!(max_id("change:"));
    RecordingChangeRequest::from_value(value).unwrap()
}

fn cancel(scope: &Value, id: &str, reference: &Value) -> RecordingWireCancelRequest {
    RecordingWireCancelRequest::from_value(json!({
        "version":1, "kind":"recordingWireCancelRequest", "scope":scope,
        "cancelId":id, "target":{"kind":"operation", "ref":reference}
    }))
    .unwrap()
}

fn attach(scope: &Value, id: &str) -> RecordingWireAttachRequest {
    RecordingWireAttachRequest::from_value(json!({
        "version":1, "kind":"recordingWireAttachRequest", "scope":scope,
        "attachId":id, "afterRevision":null
    }))
    .unwrap()
}

fn control(scope: &Value, id: &str, reference: &str, action: &str) -> RecordingWireControlRequest {
    RecordingWireControlRequest::from_value(json!({
        "version":1, "kind":"recordingWireControlRequest", "scope":scope,
        "controlId":id, "subscriptionRef":reference, "action":action
    }))
    .unwrap()
}

fn call(scope: &Value, id: &str, original: &Value) -> RecordingWireCallInspectionRequest {
    RecordingWireCallInspectionRequest::from_value(json!({
        "version":1, "kind":"recordingWireCallInspectionRequest", "scope":scope,
        "callInspectionId":id, "original":original
    }))
    .unwrap()
}

fn subscription_ref(reply: &scada_model::recording_wire::RecordingWireAttachReply) -> String {
    reply.as_value()["outcome"]["subscriptionRef"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn until<T>(mut probe: impl FnMut() -> Option<T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(value) = probe() {
                break value;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

/// The original reply is the dispatched one, re-fetched unchanged, and fits the bound that
/// was reserved for it before registration (a reply over it would be saved as `unknown`).
fn assert_saved(
    dispatched: &RecordingAdmissionReply,
    saved: Option<RecordingAdmissionReply>,
    budget: LifetimeBudget,
    kind: &str,
) {
    assert_eq!(dispatched.as_value()["outcome"]["kind"], kind);
    assert_eq!(saved.as_ref(), Some(dispatched));
    budget.check_reply(dispatched.as_value()).unwrap();
}

#[tokio::test]
async fn registry_maximum_id_workflow_saves_every_original_reply_within_its_reservation() {
    let (owner, dir) = setup();
    let scope = json!({"ownerRef":max_id("owner:"), "ownerEpoch":max_id("epoch:"),
        "context":context().as_value()});
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let client = root.test_native_client();
    let mutation = root.test_session("alice", LeaseRole::Mutation);
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let planned = max_change();
    let workflow = root.reserve_workflow(&mutation, planned.clone()).unwrap();
    let reserved = root.test_used_bytes(LeaseRole::Mutation);
    let budget = |name: &str| stage(&planned, &scope, name).unwrap().0.storage;

    // Preflight.
    let admission_id = max_id("preflight-admission:");
    let lease = root
        .issue_preflight_lease(
            &mutation,
            &workflow,
            registry_lease(
                &scope,
                &max_id("preflight-lease:"),
                &admission_id,
                "mutation",
                10_000,
            ),
        )
        .unwrap();
    let preflight_request = registry_preflight(&scope, &planned, &admission_id, &lease);
    let preflight = match root
        .register_preflight(&mutation, &workflow, preflight_request.clone())
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new preflight"),
    };
    let preflight_reply = root.dispatch_preflight(&mutation, &preflight).unwrap();
    until(|| root.preflight_completion(&mutation, &preflight).unwrap()).await;
    assert_saved(
        &preflight_reply,
        root.preflight_reply(&mutation, &preflight).unwrap(),
        budget("preflight"),
        "accepted",
    );

    // Pause/join.
    let change_ref = preflight_reply.as_value()["outcome"]["handle"]["changeRef"]
        .as_str()
        .unwrap()
        .to_owned();
    let pause_operation = max_id("pause:");
    let admission_id = max_id("pause-admission:");
    let lease = root
        .issue_pause_join_lease(
            &mutation,
            &workflow,
            &preflight,
            &pause_operation,
            registry_lease(
                &scope,
                &max_id("pause-lease:"),
                &admission_id,
                "mutation",
                10_000,
            ),
        )
        .unwrap();
    let pause = match root
        .register_pause_join(
            &mutation,
            &workflow,
            &preflight,
            registry_pause_admission(
                &scope,
                &planned,
                &admission_id,
                &lease,
                &change_ref,
                &pause_operation,
            ),
        )
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("new pause"),
    };
    let pause_reply = root.dispatch_pause_join(&mutation, &pause).unwrap();
    until(|| root.pause_completion(&mutation, &pause).unwrap()).await;
    assert_saved(
        &pause_reply,
        root.pause_reply(&mutation, &pause).unwrap(),
        budget("pauseJoin"),
        "accepted",
    );

    // Apply whose response is lost after commit, so the original apply can be reconciled.
    let apply_operation = max_id("apply:");
    let admission_id = max_id("apply-admission:");
    let lease = root
        .issue_apply_lease(
            &mutation,
            &workflow,
            &pause,
            &apply_operation,
            registry_lease(
                &scope,
                &max_id("apply-lease:"),
                &admission_id,
                "mutation",
                10_000,
            ),
        )
        .unwrap();
    let apply_request = registry_apply_admission(
        &scope,
        &planned,
        &admission_id,
        &lease,
        pause_reply.as_value()["outcome"]["handle"]["changeRef"]
            .as_str()
            .unwrap(),
        &apply_operation,
    );
    let apply = match root
        .register_apply(&mutation, &workflow, &pause, apply_request.clone())
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::LostResponse);
    let apply_reply = root.dispatch_apply(&mutation, &apply).unwrap();
    until(|| root.apply_completion(&mutation, &apply).unwrap()).await;
    *client.shared.fault.lock().unwrap() = None;
    assert_saved(
        &apply_reply,
        root.apply_reply(&mutation, &apply).unwrap(),
        budget("apply"),
        "accepted",
    );
    // All three stages and their leases were prepaid by the workflow reservation.
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), reserved);

    // Reconciliation of the original apply.
    let admission_id = max_id("read-admission:");
    let lease = root
        .issue_lease(
            &read,
            registry_lease(
                &scope,
                &max_id("read-lease:"),
                &admission_id,
                "reconciliation",
                10_000,
            ),
        )
        .unwrap();
    let handle = &apply_reply.as_value()["outcome"]["handle"];
    let mut value = registry_reconciliation_admission(
        &scope,
        &apply_request,
        &admission_id,
        &lease,
        handle["changeRef"].as_str().unwrap(),
        handle["operationRef"].as_str().unwrap(),
    )
    .as_value()
    .clone();
    value["action"]["reconciliation"]["reconciliationId"] = json!(max_id("read:"));
    let read_request = RecordingAdmissionRequest::from_value(value).unwrap();
    let read_ticket = registered(
        root.register_reconciliation(&read, &workflow, &apply, read_request.clone())
            .unwrap(),
    );
    let read_reply = root.dispatch_reconciliation(&read, &read_ticket).unwrap();
    let delivery = until(|| root.reconciliation_delivery(&read, &read_ticket).unwrap()).await;
    let read_budget = LifetimeBudget::for_request(&read_request).unwrap();
    assert_saved(
        &read_reply,
        root.reconciliation_reply(&read, &read_ticket).unwrap(),
        read_budget,
        "accepted",
    );
    read_budget.check_completion(delivery.as_value()).unwrap();

    // Wire calls with maximum-length IDs are saved and re-fetched unchanged.
    let inspection = registry_inspection(&preflight_request, &max_id("inspect:"));
    let inspected = root
        .inspect_preflight_admission(&read, &workflow, inspection.clone())
        .unwrap();
    assert_eq!(inspected.as_value()["outcome"]["kind"], "found");
    assert_eq!(
        root.inspect_preflight_admission(&read, &workflow, inspection)
            .unwrap(),
        inspected
    );
    let observation = operation_observation(
        &scope,
        &max_id("observe:"),
        &apply_request.as_value()["action"]["operation"],
    );
    let observed = root.observe_result(&read, observation.clone()).unwrap();
    assert_eq!(outcome(&observed)["result"]["outcome"]["kind"], "failed");
    assert_eq!(root.observe_result(&read, observation).unwrap(), observed);
    let cancel_request = cancel(&scope, &max_id("cancel:"), &json!(apply_operation));
    let cancelled = root
        .request_cancel(&mutation, cancel_request.clone())
        .unwrap();
    assert_eq!(
        cancelled.as_value()["outcome"]["disposition"],
        "alreadyCompleted"
    );
    assert_eq!(
        root.request_cancel(&mutation, cancel_request).unwrap(),
        cancelled
    );
    let attach_request = attach(&scope, &max_id("attach:"));
    let attached = root.attach(&read, attach_request.clone()).unwrap();
    assert_eq!(root.attach(&read, attach_request).unwrap(), attached);
    let control_request = control(
        &scope,
        &max_id("control:"),
        &subscription_ref(&attached),
        "snapshot",
    );
    let snapshot = root.control(&read, control_request.clone()).unwrap();
    assert_eq!(snapshot.as_value()["outcome"]["kind"], "snapshot");
    assert_eq!(root.control(&read, control_request).unwrap(), snapshot);
    let inspect_call = call(&scope, &max_id("call:"), apply_request.as_value());
    let found = root.inspect_call(&mutation, inspect_call.clone()).unwrap();
    assert_eq!(found.as_value()["outcome"]["kind"], "terminal");
    assert_eq!(
        &found.as_value()["outcome"]["reply"],
        apply_reply.as_value()
    );
    assert_eq!(root.inspect_call(&mutation, inspect_call).unwrap(), found);

    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert_eq!(client.shared.reconcile_calls.load(Ordering::Relaxed), 1);
    drop(dir);
}

#[tokio::test]
async fn registry_maximum_id_discard_saves_its_original_reply_within_its_reservation() {
    let (owner, _dir) = setup();
    let scope = json!({"ownerRef":max_id("owner:"), "ownerEpoch":max_id("epoch:"),
        "context":context().as_value()});
    let mut root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let mutation = root.test_session("alice", LeaseRole::Mutation);
    let planned = max_change();
    let workflow = root.reserve_workflow(&mutation, planned.clone()).unwrap();
    let admission_id = max_id("preflight-admission:");
    let lease = root
        .issue_preflight_lease(
            &mutation,
            &workflow,
            registry_lease(
                &scope,
                &max_id("preflight-lease:"),
                &admission_id,
                "mutation",
                10_000,
            ),
        )
        .unwrap();
    let preflight = match root
        .register_preflight(
            &mutation,
            &workflow,
            registry_preflight(&scope, &planned, &admission_id, &lease),
        )
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new preflight"),
    };
    let accepted = root.dispatch_preflight(&mutation, &preflight).unwrap();
    until(|| root.preflight_completion(&mutation, &preflight).unwrap()).await;
    let admission_id = max_id("discard-admission:");
    let lease = root
        .issue_discard_lease(
            &mutation,
            &workflow,
            &preflight,
            registry_lease(
                &scope,
                &max_id("discard-lease:"),
                &admission_id,
                "mutation",
                10_000,
            ),
        )
        .unwrap();
    let ticket = match root
        .register_discard(
            &mutation,
            &workflow,
            &preflight,
            registry_discard_admission(
                &scope,
                &planned,
                &admission_id,
                &lease,
                accepted.as_value()["outcome"]["handle"]["changeRef"]
                    .as_str()
                    .unwrap(),
            ),
        )
        .unwrap()
    {
        DiscardRegistration::Registered(ticket) => ticket,
        _ => panic!("new discard"),
    };
    let reply = root.dispatch_discard(&mutation, &ticket).unwrap();
    assert_saved(
        &reply,
        root.discard_reply(&mutation, &ticket).unwrap(),
        stage(&planned, &scope, "discard").unwrap().0.storage,
        "completedDiscard",
    );
}

/// Same-ID leases and dispatch waiting in one apply stage: a re-fetch after a delay keeps the
/// original deadline, a changed body, a reused admission ID or the other role is refused, and
/// a registered apply that waited past that deadline never reaches native.
#[tokio::test]
async fn registry_same_id_lease_and_dispatch_wait_keep_the_original_deadline() {
    let epoch = "epoch-deadline-scenario";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, pause, admission, dir) =
        ready_apply_registry(epoch, 300).await;
    let client = root.test_native_client();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let before = sqlite_applied_revision(&dir.0);
    let request = registry_lease(&scope, "apply-lease", "apply-admission", "mutation", 300);
    let original = root
        .issue_apply_lease(&mutation, &workflow, &pause, "apply:ready", request.clone())
        .unwrap();

    // A delayed re-fetch returns the original reply; the deadline is not extended.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        root.issue_apply_lease(&mutation, &workflow, &pause, "apply:ready", request)
            .unwrap(),
        original
    );
    // Same lease ID with another budget, the same admission under another lease ID, and the
    // read role are refused without issuing anything.
    let leases = root.test_lease_count(LeaseRole::Mutation);
    assert!(matches!(
        root.issue_apply_lease(
            &mutation,
            &workflow,
            &pause,
            "apply:ready",
            registry_lease(&scope, "apply-lease", "apply-admission", "mutation", 299)
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    assert!(matches!(
        root.issue_apply_lease(
            &mutation,
            &workflow,
            &pause,
            "apply:ready",
            registry_lease(&scope, "apply-lease-2", "apply-admission", "mutation", 300)
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    assert_eq!(
        root.issue_lease(
            &read,
            registry_lease(
                &scope,
                "apply-lease",
                "apply-admission",
                "reconciliation",
                300
            )
        ),
        Err(LeaseError::Forbidden)
    );
    assert_eq!(root.test_lease_count(LeaseRole::Mutation), leases);
    assert_eq!(root.test_lease_count(LeaseRole::Reconciliation), 0);

    // Registered before the deadline, dispatched after it: rejected, native never called.
    let ticket = match root
        .register_apply(&mutation, &workflow, &pause, admission)
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    assert_eq!(root.test_lease_consumed("apply-lease"), Some(true));
    tokio::time::sleep(Duration::from_millis(250)).await;
    let reply = root.dispatch_apply(&mutation, &ticket).unwrap();
    assert_eq!(reply.as_value()["outcome"]["kind"], "rejected");
    assert_eq!(reply.as_value()["outcome"]["error"], "deadlineExceeded");
    assert_eq!(root.dispatch_apply(&mutation, &ticket).unwrap(), reply);
    assert!(root.apply_completion(&mutation, &ticket).unwrap().is_none());
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 0);
    assert_eq!(sqlite_applied_revision(&dir.0), before);
}

/// Every byte and count pool of the root. `count_pools` ties the count rows to `CountPool`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Pool {
    WorkflowBytes,
    MutationLeaseBytes,
    ReadLeaseBytes,
    ReconciliationBytes,
    AdmissionInspectionBytes,
    ObservationBytes,
    CancelBytes,
    AttachBytes,
    ControlBytes,
    CallInspectionBytes,
    MutationLeaseCount,
    ReadLeaseCount,
    AdmissionInspectionCount,
    CallInspectionCount,
    CancelCount,
    OperationObservationCount,
    ReadObservationCount,
    PendingObservationCount,
    LiveSubscriptionCount,
    AttachCount,
    ControlCount,
}

const POOLS: [Pool; 21] = [
    Pool::WorkflowBytes,
    Pool::MutationLeaseBytes,
    Pool::ReadLeaseBytes,
    Pool::ReconciliationBytes,
    Pool::AdmissionInspectionBytes,
    Pool::ObservationBytes,
    Pool::CancelBytes,
    Pool::AttachBytes,
    Pool::ControlBytes,
    Pool::CallInspectionBytes,
    Pool::MutationLeaseCount,
    Pool::ReadLeaseCount,
    Pool::AdmissionInspectionCount,
    Pool::CallInspectionCount,
    Pool::CancelCount,
    Pool::OperationObservationCount,
    Pool::ReadObservationCount,
    Pool::PendingObservationCount,
    Pool::LiveSubscriptionCount,
    Pool::AttachCount,
    Pool::ControlCount,
];

/// Exhaustive: a new count limit on the root must be added to the table to compile.
fn count_pools(pool: CountPool) -> &'static [Pool] {
    match pool {
        CountPool::AdmissionInspections => &[Pool::AdmissionInspectionCount],
        CountPool::CallInspections => &[Pool::CallInspectionCount],
        CountPool::Cancels => &[Pool::CancelCount],
        CountPool::ObservationsPerKind => {
            &[Pool::OperationObservationCount, Pool::ReadObservationCount]
        }
        CountPool::PendingObservationsPerKind => &[Pool::PendingObservationCount],
        CountPool::LiveSubscriptions => &[Pool::LiveSubscriptionCount],
        CountPool::Attaches => &[Pool::AttachCount],
        CountPool::Controls => &[Pool::ControlCount],
    }
}

type Root = RecordingRegistryRoot;
type Add<'a> = Box<dyn FnMut(&mut Root, &str) -> Result<(), LeaseError> + 'a>;

/// The next same-shaped entry costs what the previous one did: one byte short is refused with
/// nothing charged, the exact limit fits, and a saved ID is re-fetched without a new charge.
fn bytes_boundary(root: &mut Root, role: LeaseRole, mut add: Add<'_>) {
    let before = root.test_used_bytes(role);
    add(root, "a").unwrap();
    let cost = root.test_used_bytes(role) - before;
    assert!(cost > 0);
    let used = before + cost;
    root.test_set_byte_limit(role, used + cost - 1);
    assert_eq!(add(root, "b"), Err(LeaseError::Capacity));
    assert_eq!(root.test_used_bytes(role), used);
    root.test_set_byte_limit(role, used + cost);
    add(root, "b").unwrap();
    assert_eq!(root.test_used_bytes(role), used + cost);
    add(root, "a").unwrap();
    assert_eq!(root.test_used_bytes(role), used + cost);
}

/// A one-shot entry whose retained cost is the reserved upper bound.
fn reserved_boundary(
    root: &mut Root,
    role: LeaseRole,
    cost: usize,
    mut add: impl FnMut(&mut Root) -> Result<(), LeaseError>,
) {
    let before = root.test_used_bytes(role);
    root.test_set_byte_limit(role, before + cost - 1);
    assert_eq!(add(root), Err(LeaseError::Capacity));
    assert_eq!(root.test_used_bytes(role), before);
    root.test_set_byte_limit(role, before + cost);
    add(root).unwrap();
    assert_eq!(root.test_used_bytes(role), before + cost);
}

/// With the limit one above the current count, one new ID fits and the next is refused with
/// no bytes charged; the saved ID stays readable at the limit.
fn count_boundary(
    root: &mut Root,
    set_limit: impl FnOnce(&mut Root, usize),
    count: impl Fn(&Root) -> usize,
    mut add: Add<'_>,
) {
    let n = count(root);
    set_limit(root, n + 1);
    add(root, "a").unwrap();
    assert_eq!(count(root), n + 1);
    let bytes = (
        root.test_used_bytes(LeaseRole::Mutation),
        root.test_used_bytes(LeaseRole::Reconciliation),
    );
    assert_eq!(add(root, "b"), Err(LeaseError::Capacity));
    assert_eq!(count(root), n + 1);
    assert_eq!(
        (
            root.test_used_bytes(LeaseRole::Mutation),
            root.test_used_bytes(LeaseRole::Reconciliation),
        ),
        bytes
    );
    add(root, "a").unwrap();
}

fn fresh_root(epoch: &str) -> (Root, crate::recording_host::retention::tests::Directory) {
    let (owner, dir) = setup();
    let root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        registry_scope(epoch),
    )
    .ok()
    .unwrap();
    (root, dir)
}

fn lease_add<'a>(
    scope: &'a Value,
    session: &'a RecordingRegistrySession,
    role: &'a str,
) -> Add<'a> {
    Box::new(move |root, s| {
        root.issue_lease(
            session,
            registry_lease(
                scope,
                &format!("lease:{s}"),
                &format!("admission:{s}"),
                role,
                1000,
            ),
        )
        .map(drop)
    })
}

/// A Candidate workflow (preflight accepted and complete) and its sessions.
struct Ready {
    root: Root,
    scope: Value,
    mutation: RecordingRegistrySession,
    read: RecordingRegistrySession,
    workflow: RecordingRegistryWorkflowTicket,
    preflight: RecordingRegistryAdmissionTicket,
    preflight_request: RecordingAdmissionRequest,
    preflight_operation: Value,
    pause_admission: RecordingAdmissionRequest,
    _dir: crate::recording_host::retention::tests::Directory,
}

async fn ready(epoch: &str) -> Ready {
    let (root, mutation, workflow, preflight, pause_admission, dir) =
        ready_pause_registry(epoch, 10_000).await;
    let reply = root
        .preflight_reply(&mutation, &preflight)
        .unwrap()
        .unwrap();
    Ready {
        read: root.test_session("alice", LeaseRole::Reconciliation),
        scope: registry_scope(epoch),
        preflight_request: RecordingAdmissionRequest::from_value(
            reply.as_value()["request"].clone(),
        )
        .unwrap(),
        preflight_operation: handle_request(&reply),
        root,
        mutation,
        workflow,
        preflight,
        pause_admission,
        _dir: dir,
    }
}

/// An observation of a read ref the root never issued: terminal `unavailable`.
fn unknown_read_observation(
    scope: &Value,
    id: &str,
) -> scada_model::recording_wire::RecordingWireObservationRequest {
    let read = json!({"version":1, "kind":"recordingReconciliationRequest",
        "reconciliationId":"read:unknown",
        "operation":{"version":1, "kind":"recordingOperationRequest",
            "operationId":"apply:unknown", "stage":"apply",
            "change":change("pause-ready").as_value()}});
    read_observation(scope, id, &json!("native-read:unknown"), &read)
}

async fn check(pool: Pool) {
    let epoch = format!("epoch-pool-{pool:?}");
    match pool {
        Pool::WorkflowBytes => {
            let (mut root, _dir) = fresh_root(&epoch);
            let session = root.test_session("alice", LeaseRole::Mutation);
            let planned = change("pool-workflow");
            let cost = workflow_budget(&planned, &registry_scope(&epoch))
                .unwrap()
                .total_bytes;
            reserved_boundary(&mut root, LeaseRole::Mutation, cost, |root| {
                root.reserve_workflow(&session, planned.clone()).map(drop)
            });
        }
        Pool::MutationLeaseBytes | Pool::ReadLeaseBytes => {
            let (mut root, _dir) = fresh_root(&epoch);
            let scope = registry_scope(&epoch);
            let (role, name) = if pool == Pool::MutationLeaseBytes {
                (LeaseRole::Mutation, "mutation")
            } else {
                (LeaseRole::Reconciliation, "reconciliation")
            };
            let session = root.test_session("alice", role);
            bytes_boundary(&mut root, role, lease_add(&scope, &session, name));
        }
        Pool::MutationLeaseCount | Pool::ReadLeaseCount => {
            let (mut root, _dir) = fresh_root(&epoch);
            let scope = registry_scope(&epoch);
            let (role, name) = if pool == Pool::MutationLeaseCount {
                (LeaseRole::Mutation, "mutation")
            } else {
                (LeaseRole::Reconciliation, "reconciliation")
            };
            let session = root.test_session("alice", role);
            count_boundary(
                &mut root,
                |root, limit| root.test_set_lease_limit(role, limit),
                |root| root.test_lease_count(role),
                lease_add(&scope, &session, name),
            );
        }
        Pool::ReconciliationBytes => {
            let (mut root, workflow, apply, request, accepted, _dir) =
                failed_apply(&epoch, driver::TestFault::LostResponse).await;
            let scope = registry_scope(&epoch);
            let read = root.test_session("alice", LeaseRole::Reconciliation);
            let admission = read_admission(
                &mut root,
                &read,
                &scope,
                &request,
                &accepted,
                "pool",
                "read:pool",
            );
            let cost = LifetimeBudget::for_request(&admission)
                .unwrap()
                .bytes()
                .unwrap()
                + READ_ID_BYTES;
            reserved_boundary(&mut root, LeaseRole::Reconciliation, cost, |root| {
                root.register_reconciliation(&read, &workflow, &apply, admission.clone())
                    .map(drop)
            });
        }
        Pool::AdmissionInspectionBytes | Pool::AdmissionInspectionCount => {
            let mut r = ready(&epoch).await;
            let (read, workflow, original) = (&r.read, &r.workflow, &r.preflight_request);
            let add: Add<'_> = Box::new(move |root, s| {
                root.inspect_preflight_admission(
                    read,
                    workflow,
                    registry_inspection(original, &format!("inspect:{s}")),
                )
                .map(drop)
            });
            if pool == Pool::AdmissionInspectionBytes {
                bytes_boundary(&mut r.root, LeaseRole::Reconciliation, add);
            } else {
                count_boundary(
                    &mut r.root,
                    |root, n| root.test_set_count_limit(CountPool::AdmissionInspections, n),
                    |root| root.test_admission_inspection_count(),
                    add,
                );
            }
        }
        Pool::ObservationBytes | Pool::OperationObservationCount => {
            let mut r = ready(&epoch).await;
            let (scope, read, operation) = (&r.scope, &r.read, &r.preflight_operation);
            let add: Add<'_> = Box::new(move |root, s| {
                root.observe_result(
                    read,
                    operation_observation(scope, &format!("observe:{s}"), operation),
                )
                .map(drop)
            });
            if pool == Pool::ObservationBytes {
                bytes_boundary(&mut r.root, LeaseRole::Reconciliation, add);
            } else {
                count_boundary(
                    &mut r.root,
                    |root, n| root.test_set_count_limit(CountPool::ObservationsPerKind, n),
                    |root| root.test_observation_count(),
                    add,
                );
            }
        }
        Pool::ReadObservationCount => {
            let mut r = ready(&epoch).await;
            let (scope, read) = (&r.scope, &r.read);
            let add: Add<'_> = Box::new(move |root, s| {
                let reply = root
                    .observe_result(read, unknown_read_observation(scope, &format!("read:{s}")))?;
                assert_eq!(outcome(&reply)["kind"], "unavailable");
                Ok(())
            });
            count_boundary(
                &mut r.root,
                |root, n| root.test_set_count_limit(CountPool::ObservationsPerKind, n),
                |root| root.test_observation_count(),
                add,
            );
        }
        Pool::PendingObservationCount => {
            // The production limit (two open IDs per kind) is small enough to reach directly.
            let mut r = ready(&epoch).await;
            let client = r.root.test_native_client();
            let pause = match r
                .root
                .register_pause_join(
                    &r.mutation,
                    &r.workflow,
                    &r.preflight,
                    r.pause_admission.clone(),
                )
                .unwrap()
            {
                PauseRegistration::Registered(ticket) => ticket,
                _ => panic!("new pause"),
            };
            let gate = Arc::new(driver::TestGate::default());
            *client.shared.fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
            let reply = r.root.dispatch_pause_join(&r.mutation, &pause).unwrap();
            gate.entered.notified().await;
            let operation = handle_request(&reply);
            for id in ["pending:1", "pending:2"] {
                let observed = r
                    .root
                    .observe_result(&r.read, operation_observation(&r.scope, id, &operation))
                    .unwrap();
                assert_eq!(outcome(&observed)["kind"], "pending");
            }
            let bytes = r.root.test_used_bytes(LeaseRole::Reconciliation);
            assert_eq!(
                r.root.observe_result(
                    &r.read,
                    operation_observation(&r.scope, "pending:3", &operation)
                ),
                Err(LeaseError::Capacity)
            );
            assert_eq!(r.root.test_observation_count(), 2);
            assert_eq!(r.root.test_used_bytes(LeaseRole::Reconciliation), bytes);
            // A new ID that is terminal at once never takes a pending slot.
            let terminal = r
                .root
                .observe_result(
                    &r.read,
                    operation_observation(&r.scope, "terminal:1", &r.preflight_operation),
                )
                .unwrap();
            assert_eq!(outcome(&terminal)["kind"], "operation");
            *client.shared.fault.lock().unwrap() = None;
            gate.release.notify_one();
            until(|| r.root.pause_completion(&r.mutation, &pause).unwrap()).await;
            // A pending ID frees its slot only when it reports terminal.
            let settled = r
                .root
                .observe_result(
                    &r.read,
                    operation_observation(&r.scope, "pending:1", &operation),
                )
                .unwrap();
            assert_eq!(outcome(&settled)["kind"], "operation");
            assert!(r
                .root
                .observe_result(
                    &r.read,
                    operation_observation(&r.scope, "pending:3", &operation)
                )
                .is_ok());
        }
        Pool::CancelBytes | Pool::CancelCount => {
            let mut r = ready(&epoch).await;
            let (scope, mutation) = (&r.scope, &r.mutation);
            let add: Add<'_> = Box::new(move |root, s| {
                let reply = root.request_cancel(
                    mutation,
                    cancel(scope, &format!("cancel:{s}"), &json!("unknown-operation")),
                )?;
                assert_eq!(reply.as_value()["outcome"]["kind"], "rejected");
                Ok(())
            });
            if pool == Pool::CancelBytes {
                bytes_boundary(&mut r.root, LeaseRole::Reconciliation, add);
            } else {
                count_boundary(
                    &mut r.root,
                    |root, n| root.test_set_count_limit(CountPool::Cancels, n),
                    |root| root.test_cancel_count(),
                    add,
                );
            }
        }
        Pool::AttachBytes | Pool::AttachCount => {
            let mut r = ready(&epoch).await;
            let (scope, read) = (&r.scope, &r.read);
            let add: Add<'_> = Box::new(move |root, s| {
                root.attach(read, attach(scope, &format!("attach:{s}")))
                    .map(drop)
            });
            if pool == Pool::AttachBytes {
                bytes_boundary(&mut r.root, LeaseRole::Reconciliation, add);
            } else {
                count_boundary(
                    &mut r.root,
                    |root, n| root.test_set_count_limit(CountPool::Attaches, n),
                    |root| root.test_attach_count(),
                    add,
                );
            }
        }
        Pool::LiveSubscriptionCount => {
            // The production limit (four live subscriptions) is reached directly.
            let mut r = ready(&epoch).await;
            let mut references = Vec::new();
            for index in 1..=4 {
                let reply = r
                    .root
                    .attach(&r.read, attach(&r.scope, &format!("live:{index}")))
                    .unwrap();
                references.push(subscription_ref(&reply));
            }
            let bytes = r.root.test_used_bytes(LeaseRole::Reconciliation);
            assert_eq!(
                r.root.attach(&r.read, attach(&r.scope, "live:5")),
                Err(LeaseError::Capacity)
            );
            assert_eq!(r.root.test_live_subscriptions(), 4);
            assert_eq!(r.root.test_attach_count(), 4);
            assert_eq!(r.root.test_used_bytes(LeaseRole::Reconciliation), bytes);
            r.root
                .control(
                    &r.read,
                    control(&r.scope, "detach:1", &references[0], "detach"),
                )
                .unwrap();
            r.root.attach(&r.read, attach(&r.scope, "live:5")).unwrap();
            assert_eq!(r.root.test_live_subscriptions(), 4);
        }
        Pool::ControlBytes | Pool::ControlCount => {
            let mut r = ready(&epoch).await;
            let reference = subscription_ref(
                &r.root
                    .attach(&r.read, attach(&r.scope, "attach:control"))
                    .unwrap(),
            );
            let (scope, read) = (&r.scope, &r.read);
            let add: Add<'_> = Box::new(move |root, s| {
                root.control(
                    read,
                    control(scope, &format!("control:{s}"), &reference, "snapshot"),
                )
                .map(drop)
            });
            if pool == Pool::ControlBytes {
                bytes_boundary(&mut r.root, LeaseRole::Reconciliation, add);
            } else {
                count_boundary(
                    &mut r.root,
                    |root, n| root.test_set_count_limit(CountPool::Controls, n),
                    |root| root.test_control_count(),
                    add,
                );
            }
        }
        Pool::CallInspectionBytes | Pool::CallInspectionCount => {
            let mut r = ready(&epoch).await;
            let (scope, mutation, original) = (&r.scope, &r.mutation, &r.preflight_request);
            let add: Add<'_> = Box::new(move |root, s| {
                root.inspect_call(
                    mutation,
                    call(scope, &format!("call:{s}"), original.as_value()),
                )
                .map(drop)
            });
            if pool == Pool::CallInspectionBytes {
                bytes_boundary(&mut r.root, LeaseRole::Reconciliation, add);
            } else {
                count_boundary(
                    &mut r.root,
                    |root, n| root.test_set_count_limit(CountPool::CallInspections, n),
                    |root| root.test_call_inspection_count(),
                    add,
                );
            }
        }
    }
}

#[tokio::test]
async fn registry_every_pool_accepts_exact_and_rejects_one_short() {
    for pool in [
        CountPool::AdmissionInspections,
        CountPool::CallInspections,
        CountPool::Cancels,
        CountPool::ObservationsPerKind,
        CountPool::PendingObservationsPerKind,
        CountPool::LiveSubscriptions,
        CountPool::Attaches,
        CountPool::Controls,
    ] {
        for row in count_pools(pool) {
            assert!(POOLS.contains(row), "{pool:?} is missing {row:?}");
        }
    }
    for pool in POOLS {
        check(pool).await;
    }
}
