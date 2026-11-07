//! Native registry cancel over saved handles (adapter design §7 acceptance 3).
use super::registry_observation::{
    handle_request, observe_terminal, operation_observation, outcome, read_observation,
};
use super::*;
use scada_model::recording_wire::{RecordingWireCancelReply, RecordingWireCancelRequest};

fn cancel(scope: &Value, id: &str, kind: &str, reference: &Value) -> RecordingWireCancelRequest {
    RecordingWireCancelRequest::from_value(json!({
        "version":1, "kind":"recordingWireCancelRequest", "scope":scope,
        "cancelId":id, "target":{"kind":kind, "ref":reference}
    }))
    .unwrap()
}

fn cancel_outcome(reply: &RecordingWireCancelReply) -> &Value {
    &reply.as_value()["outcome"]
}

fn ack(disposition: &str) -> Value {
    json!({"kind":"ack","disposition":disposition})
}

#[tokio::test]
async fn registry_cancel_notifies_an_in_flight_apply_once_and_keeps_its_reply_after_late_result() {
    let epoch = "epoch-cancel-apply";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, pause, admission, dir) =
        ready_apply_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let operation = admission.as_value()["action"]["operation"].clone();
    let reference = operation["operationId"].clone();

    // A ref without a saved handle is rejected for that ID forever.
    let early = cancel(&scope, "cancel:early", "operation", &reference);
    let unknown = root.request_cancel(&mutation, early.clone()).unwrap();
    assert_eq!(
        *cancel_outcome(&unknown),
        json!({"kind":"rejected","error":"ownerUnavailable"})
    );

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
    assert_eq!(root.request_cancel(&mutation, early).unwrap(), unknown);

    let observation = operation_observation(&scope, "observe:cancel-apply", &operation);
    assert_eq!(
        outcome(&root.observe_result(&read, observation.clone()).unwrap())["kind"],
        "pending"
    );
    let first = cancel(&scope, "cancel:1", "operation", &reference);
    let requested = root.request_cancel(&mutation, first.clone()).unwrap();
    assert_eq!(*cancel_outcome(&requested), ack("requested"));
    assert_eq!(requested.as_value()["request"], *first.as_value());
    assert_eq!(root.test_cancel_notified_handles(), 1);
    // Duplicate ID replays; another ID to the same handle never notifies twice.
    assert_eq!(
        root.request_cancel(&mutation, first.clone()).unwrap(),
        requested
    );
    let second = root
        .request_cancel(
            &mutation,
            cancel(&scope, "cancel:2", "operation", &reference),
        )
        .unwrap();
    assert_eq!(*cancel_outcome(&second), ack("requested"));
    assert_eq!(root.test_cancel_notified_handles(), 1);
    assert!(matches!(
        root.request_cancel(
            &mutation,
            cancel(&scope, "cancel:1", "operation", &json!("other"))
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    // The cancel ack is not a completion: the observation stays pending on explicit repeat.
    for _ in 0..2 {
        assert_eq!(
            outcome(&root.observe_result(&read, observation.clone()).unwrap())["kind"],
            "pending"
        );
    }
    assert!(root.apply_completion(&mutation, &ticket).unwrap().is_none());

    *client.shared.fault.lock().unwrap() = None;
    gate.release.notify_one();
    let late = observe_terminal(&mut root, &read, observation.clone()).await;
    let result = &outcome(&late)["result"];
    assert_eq!(result["request"], operation);
    assert_eq!(result["outcome"]["kind"], "failed");
    assert_eq!(result["outcome"]["error"], "cancelled");
    // The late result never rewrites the saved cancel or the original admission replies.
    assert_eq!(root.request_cancel(&mutation, first).unwrap(), requested);
    let third = cancel(&scope, "cancel:3", "operation", &reference);
    let after = root.request_cancel(&mutation, third.clone()).unwrap();
    assert_eq!(*cancel_outcome(&after), ack("alreadyCompleted"));
    assert_eq!(
        root.apply_reply(&mutation, &ticket).unwrap(),
        Some(accepted)
    );
    assert_eq!(root.observe_result(&read, observation).unwrap(), late);
    assert_eq!(root.test_cancel_notified_handles(), 1);
    assert_eq!(root.test_cancel_count(), 4);
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert_eq!(sqlite_applied_revision(&dir.0), before);

    // After handoff closes the root, saved IDs replay and new IDs are refused.
    root.try_handoff().unwrap();
    assert_eq!(root.request_cancel(&mutation, third).unwrap(), after);
    assert!(matches!(
        root.request_cancel(
            &mutation,
            cancel(&scope, "cancel:4", "operation", &reference)
        ),
        Err(LeaseError::Closed)
    ));
}

#[tokio::test]
async fn registry_cancel_reports_pause_join_not_supported_without_withdrawing_the_stop() {
    let epoch = "epoch-cancel-pause";
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
    let reference = operation["operationId"].clone();
    let pending = root
        .request_cancel(
            &mutation,
            cancel(&scope, "cancel:pause", "operation", &reference),
        )
        .unwrap();
    assert_eq!(*cancel_outcome(&pending), ack("notSupported"));
    assert_eq!(root.test_cancel_notified_handles(), 0);
    *client.shared.fault.lock().unwrap() = None;
    gate.release.notify_one();
    let paused = observe_terminal(
        &mut root,
        &read,
        operation_observation(&scope, "observe:cancel-pause", &operation),
    )
    .await;
    assert_eq!(outcome(&paused)["result"]["outcome"]["kind"], "paused");
    assert_eq!(client.state().phase, OperationsPhase::Paused);
    // Completion does not turn pause/join into alreadyCompleted.
    let completed = root
        .request_cancel(
            &mutation,
            cancel(&scope, "cancel:pause-done", "operation", &reference),
        )
        .unwrap();
    assert_eq!(*cancel_outcome(&completed), ack("notSupported"));
    assert_eq!(root.pause_reply(&mutation, &pause).unwrap(), Some(reply));

    // A completed preflight is alreadyCompleted and keeps its Candidate result.
    let preflight_reply = root
        .preflight_reply(&mutation, &preflight)
        .unwrap()
        .unwrap();
    let candidate = handle_request(&preflight_reply);
    let done = root
        .request_cancel(
            &mutation,
            cancel(
                &scope,
                "cancel:preflight",
                "operation",
                &candidate["operationId"],
            ),
        )
        .unwrap();
    assert_eq!(*cancel_outcome(&done), ack("alreadyCompleted"));
    assert_eq!(root.test_cancel_notified_handles(), 0);
    assert_eq!(
        root.preflight_completion(&mutation, &preflight)
            .unwrap()
            .unwrap()
            .as_value()["outcome"]["kind"],
        "candidate"
    );
    // An operation ref never resolves in the reconciliation namespace.
    let crossed = root
        .request_cancel(
            &read,
            cancel(&scope, "cancel:crossed", "reconciliation", &reference),
        )
        .unwrap();
    assert_eq!(cancel_outcome(&crossed)["kind"], "rejected");
}

#[tokio::test]
async fn registry_cancel_is_role_principal_scope_and_capacity_bound() {
    let epoch = "epoch-cancel-auth";
    let scope = registry_scope(epoch);
    let (mut root, mutation, _workflow, preflight, _pause, _dir) =
        ready_pause_registry(epoch, 1000).await;
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let reference = handle_request(
        &root
            .preflight_reply(&mutation, &preflight)
            .unwrap()
            .unwrap(),
    )["operationId"]
        .clone();
    let request = cancel(&scope, "cancel:a", "operation", &reference);
    let bytes = root.test_used_bytes(LeaseRole::Reconciliation);
    assert!(matches!(
        root.request_cancel(&read, request.clone()),
        Err(LeaseError::Forbidden)
    ));
    let bob = root.test_session("bob", LeaseRole::Mutation);
    assert!(matches!(
        root.request_cancel(&bob, request.clone()),
        Err(LeaseError::Forbidden)
    ));
    assert!(matches!(
        root.request_cancel(
            &mutation,
            cancel(
                &registry_scope("other-epoch"),
                "cancel:a",
                "operation",
                &reference
            )
        ),
        Err(LeaseError::Forbidden)
    ));
    assert_eq!(root.test_cancel_count(), 0);
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), bytes);

    // Request plus the reply upper bound is charged once to the read pool: exact and 1 short.
    let saved = root.request_cancel(&mutation, request.clone()).unwrap();
    let cost = root.test_used_bytes(LeaseRole::Reconciliation) - bytes;
    assert!(cost > 0);
    assert_eq!(
        root.request_cancel(&mutation, request.clone()).unwrap(),
        saved
    );
    assert_eq!(
        root.test_used_bytes(LeaseRole::Reconciliation),
        bytes + cost
    );
    assert!(matches!(
        root.request_cancel(&bob, request.clone()),
        Err(LeaseError::Forbidden)
    ));
    root.test_set_byte_limit(LeaseRole::Reconciliation, bytes + 2 * cost - 1);
    let next = cancel(&scope, "cancel:b", "operation", &reference);
    assert!(matches!(
        root.request_cancel(&mutation, next.clone()),
        Err(LeaseError::Capacity)
    ));
    assert_eq!(root.test_cancel_count(), 1);
    root.test_set_byte_limit(LeaseRole::Reconciliation, bytes + 2 * cost);
    assert_eq!(
        *cancel_outcome(&root.request_cancel(&mutation, next).unwrap()),
        ack("alreadyCompleted")
    );
    assert_eq!(
        root.test_used_bytes(LeaseRole::Reconciliation),
        bytes + 2 * cost
    );
}

#[tokio::test]
async fn registry_cancel_reaches_a_read_without_touching_the_original_apply() {
    let epoch = "epoch-cancel-read";
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
    let apply_observation = operation_observation(&scope, "observe:apply", &operation);
    let failed = observe_terminal(&mut root, &read, apply_observation.clone()).await;
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
    let handle = &accepted.as_value()["outcome"]["handle"];
    let read_admission = registry_reconciliation_admission(
        &scope,
        &admission,
        "read-admission",
        &lease,
        handle["changeRef"].as_str().unwrap(),
        handle["operationRef"].as_str().unwrap(),
    );
    let read_request = read_admission.as_value()["action"]["reconciliation"].clone();
    let read_ticket = match root
        .register_reconciliation(&read, &workflow, &ticket, read_admission)
        .unwrap()
    {
        ReconciliationRegistration::Registered(ticket) => ticket,
        _ => panic!("new reconciliation"),
    };
    let gate = Arc::new(driver::TestGate::default());
    *client.shared.read_fault.lock().unwrap() =
        Some(reconciliation::driver::TestFault::Gate(gate.clone()));
    let read_reply = root.dispatch_reconciliation(&read, &read_ticket).unwrap();
    assert_eq!(read_reply.as_value()["outcome"]["kind"], "accepted");
    gate.entered.notified().await;
    let read_ref = read_reply.as_value()["outcome"]["handle"]["readRef"].clone();

    // A mutation session cannot cancel a read; the read session reaches only the read handle.
    let request = cancel(&scope, "cancel:read", "reconciliation", &read_ref);
    assert!(matches!(
        root.request_cancel(&mutation, request.clone()),
        Err(LeaseError::Forbidden)
    ));
    let requested = root.request_cancel(&read, request.clone()).unwrap();
    assert_eq!(*cancel_outcome(&requested), ack("requested"));
    let applied_ref = cancel(
        &scope,
        "cancel:apply-done",
        "operation",
        &operation["operationId"],
    );
    assert_eq!(
        *cancel_outcome(&root.request_cancel(&mutation, applied_ref).unwrap()),
        ack("alreadyCompleted")
    );
    assert_eq!(root.test_cancel_notified_handles(), 1);
    let read_observation = read_observation(&scope, "observe:read", &read_ref, &read_request);
    assert_eq!(
        outcome(
            &root
                .observe_result(&read, read_observation.clone())
                .unwrap()
        )["kind"],
        "pending"
    );
    *client.shared.read_fault.lock().unwrap() = None;
    gate.release.notify_one();
    let delivery = observe_terminal(&mut root, &read, read_observation).await;
    assert_eq!(outcome(&delivery)["kind"], "reconciliation");
    assert_eq!(root.request_cancel(&read, request).unwrap(), requested);
    // The read cancel never clears the original apply's failure or native recovery.
    assert_eq!(
        root.observe_result(&read, apply_observation).unwrap(),
        failed
    );
    assert_eq!(
        root.apply_reply(&mutation, &ticket).unwrap(),
        Some(accepted)
    );
    assert!(client.state().recovery_required);
    assert_eq!(client.shared.reconcile_calls.load(Ordering::Relaxed), 1);
}
