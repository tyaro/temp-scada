//! Native registry Observation over saved handles (adapter design §7 acceptance 1).
use super::*;
use scada_model::recording_wire::{RecordingWireObservationReply, RecordingWireObservationRequest};

pub(super) fn operation_observation(
    scope: &Value,
    id: &str,
    operation: &Value,
) -> RecordingWireObservationRequest {
    RecordingWireObservationRequest::from_value(json!({
        "version":1, "kind":"recordingWireObservationRequest", "scope":scope,
        "observationId":id,
        "target":{"kind":"operation", "operationRef":operation["operationId"],
            "request":operation}
    }))
    .unwrap()
}

pub(super) fn read_observation(
    scope: &Value,
    id: &str,
    read_ref: &Value,
    read: &Value,
) -> RecordingWireObservationRequest {
    RecordingWireObservationRequest::from_value(json!({
        "version":1, "kind":"recordingWireObservationRequest", "scope":scope,
        "observationId":id,
        "target":{"kind":"reconciliation", "readRef":read_ref, "request":read}
    }))
    .unwrap()
}

pub(super) fn outcome(reply: &RecordingWireObservationReply) -> &Value {
    &reply.as_value()["outcome"]
}

pub(super) async fn observe_terminal(
    root: &mut RecordingRegistryRoot,
    read: &RecordingRegistrySession,
    request: RecordingWireObservationRequest,
) -> RecordingWireObservationReply {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let reply = root.observe_result(read, request.clone()).unwrap();
            if outcome(&reply)["kind"] != "pending" {
                break reply;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

pub(super) fn handle_request(reply: &RecordingAdmissionReply) -> Value {
    reply.as_value()["outcome"]["handle"]["request"].clone()
}

#[tokio::test]
async fn registry_observation_completes_the_chain_on_saved_native_handles() {
    let epoch = "epoch-observe-chain";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, preflight, pause_admission, dir) =
        ready_pause_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let preflight_reply = root
        .preflight_reply(&mutation, &preflight)
        .unwrap()
        .unwrap();
    let preflight_operation = handle_request(&preflight_reply);

    // Preflight: completion already ready, so the new ID is terminal without a pending slot.
    let first = operation_observation(&scope, "observe:preflight", &preflight_operation);
    let candidate = root.observe_result(&read, first.clone()).unwrap();
    assert_eq!(outcome(&candidate)["kind"], "operation");
    assert_eq!(
        outcome(&candidate)["result"]["outcome"]["kind"],
        "candidate"
    );
    assert_eq!(
        outcome(&candidate)["result"]["request"],
        preflight_operation
    );
    assert_eq!(
        root.observe_result(&read, first.clone()).unwrap(),
        candidate
    );
    let mut moved = first.as_value().clone();
    moved["target"]["request"]["operationId"] = json!("other");
    moved["target"]["operationRef"] = json!("other");
    assert!(matches!(
        root.observe_result(
            &read,
            RecordingWireObservationRequest::from_value(moved).unwrap()
        ),
        Err(LeaseError::ProtocolViolation)
    ));

    // Pause/join: observe pending while native join is gated, then the same ID turns terminal.
    let pause = match root
        .register_pause_join(&mutation, &workflow, &preflight, pause_admission)
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("new pause"),
    };
    let gate = Arc::new(driver::TestGate::default());
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    let pause_reply = root.dispatch_pause_join(&mutation, &pause).unwrap();
    assert_eq!(pause_reply.as_value()["outcome"]["kind"], "accepted");
    gate.entered.notified().await;
    let pause_observation =
        operation_observation(&scope, "observe:pause", &handle_request(&pause_reply));
    assert_eq!(
        outcome(
            &root
                .observe_result(&read, pause_observation.clone())
                .unwrap()
        )["kind"],
        "pending"
    );
    assert_eq!(
        outcome(
            &root
                .observe_result(&read, pause_observation.clone())
                .unwrap()
        )["kind"],
        "pending"
    );
    *client.shared.fault.lock().unwrap() = None;
    gate.release.notify_one();
    let paused = observe_terminal(&mut root, &read, pause_observation.clone()).await;
    assert_eq!(outcome(&paused)["result"]["outcome"]["kind"], "paused");
    assert_eq!(
        root.pause_completion(&mutation, &pause)
            .unwrap()
            .unwrap()
            .as_value(),
        &outcome(&paused)["result"]
    );
    assert_eq!(
        root.pause_reply(&mutation, &pause).unwrap(),
        Some(pause_reply.clone())
    );

    // An apply ref observed before dispatch stays unavailable under that ID forever.
    let change_ref = pause_reply.as_value()["outcome"]["handle"]["changeRef"]
        .as_str()
        .unwrap();
    let apply_lease = root
        .issue_apply_lease(
            &mutation,
            &workflow,
            &pause,
            "apply:observed",
            registry_lease(&scope, "apply-lease", "apply-admission", "mutation", 1000),
        )
        .unwrap();
    let apply_admission = registry_apply_admission(
        &scope,
        &change("pause-ready"),
        "apply-admission",
        &apply_lease,
        change_ref,
        "apply:observed",
    );
    let apply_operation = apply_admission.as_value()["action"]["operation"].clone();
    let early = operation_observation(&scope, "observe:apply-early", &apply_operation);
    let unavailable = root.observe_result(&read, early.clone()).unwrap();
    assert_eq!(
        *outcome(&unavailable),
        json!({"kind":"unavailable","error":"ownerUnavailable"})
    );
    let apply = match root
        .register_apply(&mutation, &workflow, &pause, apply_admission)
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    let before = sqlite_applied_revision(&dir.0);
    let apply_reply = root.dispatch_apply(&mutation, &apply).unwrap();
    assert_eq!(apply_reply.as_value()["outcome"]["kind"], "accepted");
    let applied = observe_terminal(
        &mut root,
        &read,
        operation_observation(&scope, "observe:apply", &apply_operation),
    )
    .await;
    assert_eq!(outcome(&applied)["result"]["outcome"]["kind"], "applied");
    assert_eq!(
        outcome(&applied)["result"]["outcome"]["receipt"]["appliedRevision"],
        before + 1
    );
    assert_eq!(root.observe_result(&read, early).unwrap(), unavailable);

    // Repeated observation never redispatches and never rewrites original replies.
    for _ in 0..3 {
        assert_eq!(
            root.observe_result(&read, first.clone()).unwrap(),
            candidate
        );
        assert_eq!(
            root.observe_result(&read, pause_observation.clone())
                .unwrap(),
            paused
        );
    }
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert_eq!(sqlite_applied_revision(&dir.0), before + 1);
    assert_eq!(
        root.preflight_reply(&mutation, &preflight).unwrap(),
        Some(preflight_reply)
    );
    assert_eq!(
        root.apply_reply(&mutation, &apply).unwrap(),
        Some(apply_reply)
    );
    assert_eq!(root.test_observation_count(), 4);
}

#[tokio::test]
async fn registry_observation_is_read_role_principal_and_scope_bound() {
    let epoch = "epoch-observe-auth";
    let scope = registry_scope(epoch);
    let (mut root, mutation, _workflow, preflight, _pause, _dir) =
        ready_pause_registry(epoch, 1000).await;
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let operation = handle_request(
        &root
            .preflight_reply(&mutation, &preflight)
            .unwrap()
            .unwrap(),
    );
    let request = operation_observation(&scope, "observe:auth", &operation);
    let bytes = root.test_used_bytes(LeaseRole::Reconciliation);
    assert!(matches!(
        root.observe_result(&mutation, request.clone()),
        Err(LeaseError::Forbidden)
    ));
    let bob = root.test_session("bob", LeaseRole::Reconciliation);
    assert!(matches!(
        root.observe_result(&bob, request.clone()),
        Err(LeaseError::Forbidden)
    ));
    let foreign = operation_observation(&registry_scope("other-epoch"), "observe:auth", &operation);
    assert!(matches!(
        root.observe_result(&read, foreign),
        Err(LeaseError::Forbidden)
    ));
    let mut wrong_body = operation.clone();
    wrong_body["stage"] = json!("apply");
    assert!(matches!(
        root.observe_result(
            &read,
            operation_observation(&scope, "observe:auth", &wrong_body)
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    assert_eq!(root.test_observation_count(), 0);
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), bytes);
    root.observe_result(&read, request.clone()).unwrap();
    assert!(root.test_used_bytes(LeaseRole::Reconciliation) > bytes);
    let charged = root.test_used_bytes(LeaseRole::Reconciliation);
    root.observe_result(&read, request).unwrap();
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), charged);
    assert!(matches!(
        root.observe_result(
            &bob,
            operation_observation(&scope, "observe:auth", &operation)
        ),
        Err(LeaseError::Forbidden)
    ));
}

#[tokio::test]
async fn registry_observation_bounds_pending_slots_and_admits_terminal_ids() {
    let epoch = "epoch-observe-slots";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, preflight, pause_admission, _dir) =
        ready_pause_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let pause = match root
        .register_pause_join(&mutation, &workflow, &preflight, pause_admission)
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("new pause"),
    };
    let gate = Arc::new(driver::TestGate::default());
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    let reply = root.dispatch_pause_join(&mutation, &pause).unwrap();
    gate.entered.notified().await;
    let operation = handle_request(&reply);
    let first = operation_observation(&scope, "observe:slot-1", &operation);
    let second = operation_observation(&scope, "observe:slot-2", &operation);
    let third = operation_observation(&scope, "observe:slot-3", &operation);
    for request in [&first, &second] {
        assert_eq!(
            outcome(&root.observe_result(&read, request.clone()).unwrap())["kind"],
            "pending"
        );
    }
    let bytes = root.test_used_bytes(LeaseRole::Reconciliation);
    assert!(matches!(
        root.observe_result(&read, third.clone()),
        Err(LeaseError::Capacity)
    ));
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), bytes);
    // A read ref uses its own pool; an unknown ref never takes a pending slot.
    let unknown = root
        .observe_result(
            &read,
            read_observation(
                &scope,
                "observe:no-read",
                &json!("native-read:999"),
                &json!({"version":1,"kind":"recordingReconciliationRequest",
                    "reconciliationId":"read:none",
                    "operation":{"version":1,"kind":"recordingOperationRequest",
                        "operationId":"apply:none","stage":"apply",
                        "change":operation["change"]}}),
            ),
        )
        .unwrap();
    assert_eq!(outcome(&unknown)["kind"], "unavailable");
    *client.shared.fault.lock().unwrap() = None;
    gate.release.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        while root.pause_completion(&mutation, &pause).unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    // Terminal-ready new IDs never take a pending slot, so the third ID is now admitted.
    assert_eq!(
        outcome(&root.observe_result(&read, third).unwrap())["kind"],
        "operation"
    );
    let terminal = root.observe_result(&read, first.clone()).unwrap();
    assert_eq!(outcome(&terminal)["result"]["outcome"]["kind"], "paused");
    assert_eq!(root.observe_result(&read, first).unwrap(), terminal);
    assert_eq!(
        outcome(&root.observe_result(&read, second).unwrap())["result"],
        outcome(&terminal)["result"]
    );
    assert_eq!(root.test_observation_count(), 4);
}

#[tokio::test]
async fn registry_observation_separates_rejection_unknown_reply_and_failed_completion() {
    // Typed native rejection saves no handle: its operation ref is unavailable.
    let epoch = "epoch-observe-rejected";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, pause, admission, _dir) =
        ready_apply_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let operation = admission.as_value()["action"]["operation"].clone();
    let ticket = match root
        .register_apply(&mutation, &workflow, &pause, admission)
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    client.shared.core.lock().unwrap().recovery = true;
    let rejected = root.dispatch_apply(&mutation, &ticket).unwrap();
    assert_eq!(rejected.as_value()["outcome"]["kind"], "rejected");
    assert_eq!(
        outcome(
            &root
                .observe_result(
                    &read,
                    operation_observation(&scope, "observe:r", &operation)
                )
                .unwrap()
        )["kind"],
        "unavailable"
    );

    // A panic before the handle is saved leaves no native handle to observe.
    let epoch = "epoch-observe-panic";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, pause, admission, _dir) =
        ready_apply_registry(epoch, 1000).await;
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let operation = admission.as_value()["action"]["operation"].clone();
    let ticket = match root
        .register_apply(&mutation, &workflow, &pause, admission)
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    root.test_set_apply_dispatch_fault(
        &mutation,
        &ticket,
        ApplyDispatchFault::NativePanicAfterCall,
    );
    let unknown = root.dispatch_apply(&mutation, &ticket).unwrap();
    assert_eq!(unknown.as_value()["outcome"]["kind"], "unknown");
    assert_eq!(
        outcome(
            &root
                .observe_result(
                    &read,
                    operation_observation(&scope, "observe:p", &operation)
                )
                .unwrap()
        )["kind"],
        "unavailable"
    );
    assert_eq!(root.apply_reply(&mutation, &ticket).unwrap(), Some(unknown));
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));

    // A projection panic after the handle save keeps the original unknown reply, while
    // Observation reads the saved handle's real completion.
    let epoch = "epoch-observe-unknown";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, pause, admission, _dir) =
        ready_apply_registry(epoch, 1000).await;
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let operation = admission.as_value()["action"]["operation"].clone();
    let ticket = match root
        .register_apply(&mutation, &workflow, &pause, admission)
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    root.test_set_apply_dispatch_fault(&mutation, &ticket, ApplyDispatchFault::ProjectionPanic);
    let unknown = root.dispatch_apply(&mutation, &ticket).unwrap();
    assert_eq!(unknown.as_value()["outcome"]["kind"], "unknown");
    let applied = observe_terminal(
        &mut root,
        &read,
        operation_observation(&scope, "observe:u", &operation),
    )
    .await;
    assert_eq!(outcome(&applied)["result"]["outcome"]["kind"], "applied");
    assert_eq!(root.apply_reply(&mutation, &ticket).unwrap(), Some(unknown));
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));

    // A failed write after acceptance is a completion; the read is observed separately and
    // does not clear the original apply's recovery.
    let epoch = "epoch-observe-failed";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, pause, admission, _dir) =
        ready_apply_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let operation = admission.as_value()["action"]["operation"].clone();
    let ticket = match root
        .register_apply(&mutation, &workflow, &pause, admission.clone())
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::Full);
    let accepted = root.dispatch_apply(&mutation, &ticket).unwrap();
    let apply_observation = operation_observation(&scope, "observe:f", &operation);
    let failed = observe_terminal(&mut root, &read, apply_observation.clone()).await;
    assert_eq!(outcome(&failed)["result"]["outcome"]["kind"], "failed");
    assert_eq!(outcome(&failed)["result"]["recoveryRequired"], true);
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
    let read_admission = registry_reconciliation_admission(
        &scope,
        &admission,
        "read-admission",
        &lease,
        accepted.as_value()["outcome"]["handle"]["changeRef"]
            .as_str()
            .unwrap(),
        accepted.as_value()["outcome"]["handle"]["operationRef"]
            .as_str()
            .unwrap(),
    );
    let read_request = read_admission.as_value()["action"]["reconciliation"].clone();
    let read_ticket = match root
        .register_reconciliation(&read, &workflow, &ticket, read_admission)
        .unwrap()
    {
        ReconciliationRegistration::Registered(ticket) => ticket,
        _ => panic!("new reconciliation"),
    };
    let read_reply = root.dispatch_reconciliation(&read, &read_ticket).unwrap();
    assert_eq!(read_reply.as_value()["outcome"]["kind"], "accepted");
    let read_ref = read_reply.as_value()["outcome"]["handle"]["readRef"].clone();
    let mut wrong = read_request.clone();
    wrong["reconciliationId"] = json!("read:other");
    assert!(matches!(
        root.observe_result(
            &read,
            read_observation(&scope, "observe:w", &read_ref, &wrong)
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    let delivery = observe_terminal(
        &mut root,
        &read,
        read_observation(&scope, "observe:read", &read_ref, &read_request),
    )
    .await;
    assert_eq!(outcome(&delivery)["kind"], "reconciliation");
    assert_eq!(
        outcome(&delivery)["delivery"],
        *root
            .reconciliation_delivery(&read, &read_ticket)
            .unwrap()
            .unwrap()
            .as_value()
    );
    assert_eq!(
        outcome(&delivery)["delivery"]["outcome"]["result"]["outcome"]["kind"],
        "notFound"
    );
    assert_eq!(
        root.observe_result(&read, apply_observation).unwrap(),
        failed
    );
    assert_eq!(client.shared.reconcile_calls.load(Ordering::Relaxed), 1);
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert!(client.state().recovery_required);
}

#[tokio::test]
async fn registry_observation_reads_not_dispatched_completion_after_acceptance() {
    // Apply: the native handle is accepted, then the lease deadline passes before the owner
    // loan starts. The completion is failed/notDispatched on the saved handle, not a rejection.
    let epoch = "epoch-observe-not-dispatched-apply";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, pause, admission, dir) =
        ready_apply_registry(epoch, 200).await;
    let client = root.test_native_client();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let operation = admission.as_value()["action"]["operation"].clone();
    let ticket = match root
        .register_apply(&mutation, &workflow, &pause, admission)
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    let before = sqlite_applied_revision(&dir.0);
    let gate = Arc::new(driver::TestGate::default());
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    let accepted = root.dispatch_apply(&mutation, &ticket).unwrap();
    assert_eq!(accepted.as_value()["outcome"]["kind"], "accepted");
    gate.entered.notified().await;
    let observation = operation_observation(&scope, "observe:nd-apply", &operation);
    assert_eq!(
        outcome(&root.observe_result(&read, observation.clone()).unwrap())["kind"],
        "pending"
    );
    tokio::time::sleep(Duration::from_millis(250)).await;
    gate.release.notify_one();
    let failed = observe_terminal(&mut root, &read, observation.clone()).await;
    let result = &outcome(&failed)["result"];
    assert_eq!(result["request"], operation);
    assert_eq!(result["outcome"]["kind"], "failed");
    assert_eq!(result["outcome"]["error"], "deadlineExceeded");
    assert_eq!(result["outcome"]["effect"], "notDispatched");
    assert_eq!(result["recoveryRequired"], true);
    assert_eq!(
        root.apply_completion(&mutation, &ticket)
            .unwrap()
            .unwrap()
            .as_value(),
        result
    );
    // The original Accepted reply is unchanged, native apply ran once and SQLite is untouched.
    assert_eq!(
        root.apply_reply(&mutation, &ticket).unwrap(),
        Some(accepted)
    );
    for _ in 0..3 {
        assert_eq!(
            root.observe_result(&read, observation.clone()).unwrap(),
            failed
        );
    }
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert_eq!(sqlite_applied_revision(&dir.0), before);
    assert_eq!(client.state().phase, OperationsPhase::Blocked);
    assert!(client.state().recovery_required);
    // A confirmed notDispatched is not an uncertain dispatch: handoff carries its recovery.
    let handoff = root.try_handoff().unwrap();
    assert!(handoff.evidence.owner_recovery_required);
    assert_eq!(handoff.evidence.latest.unwrap().as_value(), result);
    assert!(handoff.evidence.last_applied.is_none());

    // Pause/join: the same post-acceptance notDispatched completion leaves the recorder
    // unpaused and is observed on the saved pause handle.
    let epoch = "epoch-observe-not-dispatched-pause";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, preflight, pause_admission, _dir) =
        ready_pause_registry(epoch, 200).await;
    let client = root.test_native_client();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let pause = match root
        .register_pause_join(&mutation, &workflow, &preflight, pause_admission)
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("new pause"),
    };
    let gate = Arc::new(driver::TestGate::default());
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    let accepted = root.dispatch_pause_join(&mutation, &pause).unwrap();
    assert_eq!(accepted.as_value()["outcome"]["kind"], "accepted");
    gate.entered.notified().await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    gate.release.notify_one();
    let observation = operation_observation(&scope, "observe:nd-pause", &handle_request(&accepted));
    let failed = observe_terminal(&mut root, &read, observation.clone()).await;
    let result = &outcome(&failed)["result"];
    assert_eq!(result["outcome"]["kind"], "failed");
    assert_eq!(result["outcome"]["error"], "deadlineExceeded");
    assert_eq!(result["outcome"]["effect"], "notDispatched");
    assert_eq!(result["recoveryRequired"], true);
    assert_eq!(
        root.pause_completion(&mutation, &pause)
            .unwrap()
            .unwrap()
            .as_value(),
        result
    );
    assert_eq!(root.pause_reply(&mutation, &pause).unwrap(), Some(accepted));
    assert_eq!(root.observe_result(&read, observation).unwrap(), failed);
    assert_eq!(client.state().phase, OperationsPhase::Blocked);
    let handoff = root.try_handoff().unwrap();
    assert!(handoff.evidence.owner_recovery_required);
    assert_eq!(handoff.evidence.latest.unwrap().as_value(), result);
}
