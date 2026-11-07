//! Native registry OwnerSnapshot and subscriptions over saved evidence (adapter design §7).
use super::registry_read_retry::{failed_apply, read_admission, registered};
use super::*;
use scada_model::recording_wire::{
    RecordingWireAttachReply, RecordingWireAttachRequest, RecordingWireControlRequest,
};

fn attach(scope: &Value, id: &str, after: Value) -> RecordingWireAttachRequest {
    RecordingWireAttachRequest::from_value(json!({
        "version":1, "kind":"recordingWireAttachRequest", "scope":scope,
        "attachId":id, "afterRevision":after
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

fn attached(reply: &RecordingWireAttachReply) -> (String, Value) {
    let outcome = &reply.as_value()["outcome"];
    assert_eq!(outcome["kind"], "attached");
    (
        outcome["subscriptionRef"].as_str().unwrap().to_owned(),
        outcome["snapshot"].clone(),
    )
}

fn fresh_root(
    epoch: &str,
) -> (
    RecordingRegistryRoot,
    crate::recording_host::retention::tests::Directory,
) {
    let (owner, dir) = setup();
    let root = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        registry_scope(epoch),
    )
    .ok()
    .unwrap();
    (root, dir)
}

#[tokio::test]
async fn registry_subscription_fixes_attach_snapshot_and_slots_later_revisions() {
    let epoch = "epoch-subscribe-chain";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, preflight, pause_admission, _dir) =
        ready_pause_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let preflight_reply = root
        .preflight_reply(&mutation, &preflight)
        .unwrap()
        .unwrap();

    // Registration, acceptance and the Candidate completion fold into one revision.
    let snapshot = root.owner_snapshot(&read).unwrap();
    assert_eq!(snapshot["revision"], 2);
    assert_eq!(snapshot["scope"], scope);
    assert_eq!(snapshot["closed"], false);
    assert_eq!(snapshot["ownerBlocked"], false);
    assert_eq!(&snapshot["admission"], preflight_reply.as_value());
    assert_eq!(
        snapshot["operation"]["operationRef"],
        preflight_reply.as_value()["outcome"]["handle"]["operationRef"]
    );
    assert_eq!(
        snapshot["operation"]["result"]["outcome"]["kind"],
        "candidate"
    );
    assert!(snapshot["reconciliation"].is_null());
    // Unchanged evidence never increments the revision.
    assert_eq!(root.owner_snapshot(&read).unwrap(), snapshot);

    let first = attach(&scope, "attach:1", Value::Null);
    let reply = root.attach(&read, first.clone()).unwrap();
    let (reference, fixed) = attached(&reply);
    assert_eq!(reference, "native-subscription:1");
    assert_eq!(fixed, snapshot);
    assert!(root.take_state_frame(&read, &reference).unwrap().is_none());

    // The pause is accepted but gated: the new head operation has no completion yet.
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
    let frame = root.take_state_frame(&read, &reference).unwrap().unwrap();
    let pending = &frame.as_value()["snapshot"];
    assert_eq!(frame.as_value()["subscriptionRef"], reference);
    assert_eq!(pending["revision"], 3);
    assert_eq!(&pending["admission"], pause_reply.as_value());
    assert!(pending["operation"].is_null());
    assert!(root.take_state_frame(&read, &reference).unwrap().is_none());

    // The original attach reply is immutable; only a new explicit control sees the latest.
    assert_eq!(root.attach(&read, first.clone()).unwrap(), reply);
    let latest = root
        .control(&read, control(&scope, "control:1", &reference, "snapshot"))
        .unwrap();
    assert_eq!(latest.as_value()["outcome"]["snapshot"], *pending);

    *client.shared.fault.lock().unwrap() = None;
    gate.release.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        while root.pause_completion(&mutation, &pause).unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let frame = root.take_state_frame(&read, &reference).unwrap().unwrap();
    let paused = &frame.as_value()["snapshot"];
    assert_eq!(paused["revision"], 4);
    assert_eq!(&paused["admission"], pause_reply.as_value());
    assert_eq!(paused["operation"]["result"]["outcome"]["kind"], "paused");
    assert_eq!(
        paused["operation"]["operationRef"],
        pause_reply.as_value()["outcome"]["handle"]["operationRef"]
    );
    assert_eq!(
        root.control(&read, control(&scope, "control:1", &reference, "snapshot"))
            .unwrap(),
        latest
    );

    // afterRevision may name the current revision but never a future one.
    assert!(matches!(
        root.attach(&read, attach(&scope, "attach:future", json!(5))),
        Err(LeaseError::ProtocolViolation)
    ));
    let (second, at) = attached(
        &root
            .attach(&read, attach(&scope, "attach:2", json!(4.0)))
            .unwrap(),
    );
    assert_eq!(second, "native-subscription:2");
    assert_eq!(at, *paused);
    let mut moved = first.as_value().clone();
    moved["afterRevision"] = json!(1);
    assert!(matches!(
        root.attach(
            &read,
            RecordingWireAttachRequest::from_value(moved).unwrap()
        ),
        Err(LeaseError::ProtocolViolation)
    ));
}

#[tokio::test]
async fn registry_subscription_detach_frees_only_the_slot_and_is_principal_bound() {
    let epoch = "epoch-subscribe-detach";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, preflight, pause_admission, _dir) =
        ready_pause_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let mut references = Vec::new();
    for index in 0..4 {
        let (reference, _) = attached(
            &root
                .attach(
                    &read,
                    attach(&scope, &format!("attach:{index}"), Value::Null),
                )
                .unwrap(),
        );
        references.push(reference);
    }
    assert_eq!(root.test_live_subscriptions(), 4);
    let bytes = root.test_used_bytes(LeaseRole::Reconciliation);
    assert!(matches!(
        root.attach(&read, attach(&scope, "attach:full", Value::Null)),
        Err(LeaseError::Capacity)
    ));
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), bytes);

    // Other principals, roles, scopes and refs cannot reach this subscription.
    let bob = root.test_session("bob", LeaseRole::Reconciliation);
    assert!(matches!(
        root.control(
            &bob,
            control(&scope, "control:bob", &references[0], "detach")
        ),
        Err(LeaseError::Forbidden)
    ));
    assert!(matches!(
        root.attach(&bob, attach(&scope, "attach:0", Value::Null)),
        Err(LeaseError::Forbidden)
    ));
    assert!(matches!(
        root.take_state_frame(&bob, &references[0]),
        Err(LeaseError::Forbidden)
    ));
    assert!(matches!(
        root.attach(&mutation, attach(&scope, "attach:mutation", Value::Null)),
        Err(LeaseError::Forbidden)
    ));
    assert!(matches!(
        root.attach(
            &read,
            attach(&registry_scope("epoch-other"), "attach:epoch", Value::Null)
        ),
        Err(LeaseError::Forbidden)
    ));
    assert!(matches!(
        root.control(
            &read,
            control(
                &scope,
                "control:unknown",
                "native-subscription:9",
                "snapshot"
            )
        ),
        Err(LeaseError::InvalidInput)
    ));
    assert!(matches!(
        root.take_state_frame(&read, "native-subscription:9"),
        Err(LeaseError::InvalidInput)
    ));

    // A gated native join keeps running across detach; detach frees the live slot only.
    let pause = match root
        .register_pause_join(&mutation, &workflow, &preflight, pause_admission)
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("new pause"),
    };
    let gate = Arc::new(driver::TestGate::default());
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    root.dispatch_pause_join(&mutation, &pause).unwrap();
    gate.entered.notified().await;
    let detach = control(&scope, "control:detach", &references[0], "detach");
    let detached = root.control(&read, detach.clone()).unwrap();
    assert_eq!(detached.as_value()["outcome"]["kind"], "detached");
    assert_eq!(root.control(&read, detach).unwrap(), detached);
    assert_eq!(root.test_live_subscriptions(), 3);
    assert!(matches!(
        root.take_state_frame(&read, &references[0]),
        Err(LeaseError::InvalidInput)
    ));
    assert!(matches!(
        root.control(
            &read,
            control(&scope, "control:late", &references[0], "snapshot")
        ),
        Err(LeaseError::InvalidInput)
    ));
    let again = root
        .control(
            &read,
            control(&scope, "control:again", &references[0], "detach"),
        )
        .unwrap();
    assert_eq!(again.as_value()["outcome"]["kind"], "detached");
    assert_eq!(root.test_live_subscriptions(), 3);
    *client.shared.fault.lock().unwrap() = None;
    gate.release.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        while root.pause_completion(&mutation, &pause).unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        root.pause_completion(&mutation, &pause)
            .unwrap()
            .unwrap()
            .as_value()["outcome"]["kind"],
        "paused"
    );

    // Reconnect is a new explicit attach with a new ID and the latest complete snapshot.
    let (reconnected, latest) = attached(
        &root
            .attach(&read, attach(&scope, "attach:reconnect", Value::Null))
            .unwrap(),
    );
    assert_eq!(reconnected, "native-subscription:5");
    assert_eq!(latest["operation"]["result"]["outcome"]["kind"], "paused");
    let frame = root
        .take_state_frame(&read, &references[1])
        .unwrap()
        .unwrap();
    assert_eq!(frame.as_value()["snapshot"], latest);
}

#[tokio::test]
async fn registry_subscription_unknown_admission_head_keeps_fixed_replies() {
    let epoch = "epoch-subscribe-unknown";
    let (mut root, _dir) = fresh_root(epoch);
    let scope = registry_scope(epoch);
    let mutation = root.test_session("alice", LeaseRole::Mutation);
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let (reference, initial) = attached(
        &root
            .attach(&read, attach(&scope, "attach:0", json!(0)))
            .unwrap(),
    );
    assert_eq!(initial["revision"], 1);
    assert!(initial["admission"].is_null());

    let change = change("subscribe-unknown");
    let workflow = root.reserve_workflow(&mutation, change.clone()).unwrap();
    let lease = root
        .issue_preflight_lease(
            &mutation,
            &workflow,
            registry_lease(
                &scope,
                "unknown-lease",
                "unknown-admission",
                "mutation",
                1000,
            ),
        )
        .unwrap();
    let original = registry_preflight(&scope, &change, "unknown-admission", &lease);
    let ticket = match root
        .register_preflight(&mutation, &workflow, original.clone())
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new registration expected"),
    };
    // A registered, undispatched admission is published as the unknown head.
    let frame = root.take_state_frame(&read, &reference).unwrap().unwrap();
    let registered_head = frame.as_value()["snapshot"].clone();
    assert_eq!(registered_head["revision"], 2);
    assert_eq!(
        &registered_head["admission"]["request"],
        original.as_value()
    );
    assert_eq!(registered_head["admission"]["outcome"]["kind"], "unknown");
    assert_eq!(
        registered_head["admission"]["outcome"]["error"],
        "workerFailure"
    );
    let (fixed_ref, fixed) = attached(
        &root
            .attach(&read, attach(&scope, "attach:unknown", Value::Null))
            .unwrap(),
    );

    root.test_set_dispatch_fault(&mutation, &ticket, TestDispatchFault::ProjectionPanic);
    let original_reply = root.dispatch_preflight(&mutation, &ticket).unwrap();
    assert_eq!(original_reply.as_value()["outcome"]["kind"], "unknown");
    tokio::time::timeout(Duration::from_secs(5), async {
        while root
            .preflight_completion(&mutation, &ticket)
            .unwrap()
            .is_none()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    // The original unknown stays unknown; the completion of the saved handle is published.
    let completed = root.owner_snapshot(&read).unwrap();
    assert_eq!(completed["revision"], 3);
    assert_eq!(completed["admission"], registered_head["admission"]);
    assert_eq!(
        completed["operation"]["result"]["outcome"]["kind"],
        "candidate"
    );

    // Accepted inspection knowledge becomes the head proof, without changing old replies.
    let inspection = root
        .inspect_preflight_admission(
            &read,
            &workflow,
            registry_inspection(&original, "subscribe-inspection"),
        )
        .unwrap();
    let knowledge = inspection.as_value()["outcome"]["reply"].clone();
    assert_eq!(knowledge["outcome"]["kind"], "accepted");
    let proven = root.owner_snapshot(&read).unwrap();
    assert_eq!(proven["revision"], 4);
    assert_eq!(proven["admission"], knowledge);
    assert_eq!(
        root.attach(&read, attach(&scope, "attach:unknown", Value::Null))
            .unwrap()
            .as_value()["outcome"]["snapshot"],
        fixed
    );
    assert_eq!(
        root.preflight_reply(&mutation, &ticket).unwrap(),
        Some(original_reply)
    );
    // Slots coalesce to the latest complete state.
    let frame = root.take_state_frame(&read, &fixed_ref).unwrap().unwrap();
    assert_eq!(frame.as_value()["snapshot"], proven);
    let frame = root.take_state_frame(&read, &reference).unwrap().unwrap();
    assert_eq!(frame.as_value()["snapshot"], proven);
}

#[tokio::test]
async fn registry_subscription_read_head_keeps_operation_and_owner_recovery() {
    let epoch = "epoch-subscribe-read";
    let scope = registry_scope(epoch);
    let (mut root, workflow, apply_ticket, apply, accepted, _dir) =
        failed_apply(epoch, driver::TestFault::LostResponse).await;
    let client = root.test_native_client();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let before = root.owner_snapshot(&read).unwrap();
    assert_eq!(&before["admission"], accepted.as_value());
    let apply_result = before["operation"].clone();
    assert_eq!(
        apply_result["operationRef"],
        accepted.as_value()["outcome"]["handle"]["operationRef"]
    );
    assert_eq!(
        before["ownerBlocked"],
        client.shared.view.borrow().recovery_required
    );
    // The lost commit response latches native recovery; the snapshot reports it as blocked.
    assert_eq!(before["ownerBlocked"], true);
    assert!(before["reconciliation"].is_null());
    let (reference, _) = attached(
        &root
            .attach(&read, attach(&scope, "attach:read", Value::Null))
            .unwrap(),
    );

    let admission = read_admission(
        &mut root,
        &read,
        &scope,
        &apply,
        &accepted,
        "s",
        "read:subscribe",
    );
    let ticket = registered(
        root.register_reconciliation(&read, &workflow, &apply_ticket, admission)
            .unwrap(),
    );
    let read_reply = root.dispatch_reconciliation(&read, &ticket).unwrap();
    assert_eq!(read_reply.as_value()["outcome"]["kind"], "accepted");
    let delivery = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(delivery) = root.reconciliation_delivery(&read, &ticket).unwrap() {
                break delivery;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let frame = root.take_state_frame(&read, &reference).unwrap().unwrap();
    let snapshot = &frame.as_value()["snapshot"];
    assert_eq!(&snapshot["admission"], read_reply.as_value());
    assert_eq!(&snapshot["reconciliation"], delivery.as_value());
    // A read never replaces or re-derives the original apply result, nor clears recovery.
    assert_eq!(snapshot["operation"], apply_result);
    assert_eq!(
        snapshot["ownerBlocked"],
        client.shared.view.borrow().recovery_required
    );
    assert_eq!(snapshot["ownerBlocked"], before["ownerBlocked"]);
}

#[tokio::test]
async fn registry_subscription_close_publishes_closed_and_owner_closed_once() {
    let epoch = "epoch-subscribe-close";
    let scope = registry_scope(epoch);
    let (mut root, _dir) = fresh_root(epoch);
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let first = attach(&scope, "attach:close", Value::Null);
    let reply = root.attach(&read, first.clone()).unwrap();
    let (reference, open) = attached(&reply);
    assert_eq!(open["closed"], false);
    let handoff = root.try_handoff().unwrap();

    let frame = root.take_state_frame(&read, &reference).unwrap().unwrap();
    assert_eq!(frame.as_value()["snapshot"]["closed"], true);
    assert_eq!(frame.as_value()["snapshot"]["revision"], 2);
    let control_frame = root.take_control_frame(&read, &reference).unwrap().unwrap();
    assert_eq!(control_frame.as_value()["reason"], "ownerClosed");
    assert_eq!(control_frame.as_value()["scope"], scope);
    assert!(root
        .take_control_frame(&read, &reference)
        .unwrap()
        .is_none());
    assert!(root.take_state_frame(&read, &reference).unwrap().is_none());
    assert_eq!(root.owner_snapshot(&read).unwrap()["revision"], 2);

    // A closed root replays original calls and allows explicit snapshot/detach only.
    assert_eq!(root.attach(&read, first).unwrap(), reply);
    assert!(matches!(
        root.attach(&read, attach(&scope, "attach:after-close", Value::Null)),
        Err(LeaseError::Closed)
    ));
    let latest = root
        .control(
            &read,
            control(&scope, "control:closed", &reference, "snapshot"),
        )
        .unwrap();
    assert_eq!(latest.as_value()["outcome"]["snapshot"]["closed"], true);
    let detached = root
        .control(
            &read,
            control(&scope, "control:detach", &reference, "detach"),
        )
        .unwrap();
    assert_eq!(detached.as_value()["outcome"]["kind"], "detached");
    drop(handoff);
}

#[tokio::test]
async fn registry_subscription_read_bytes_accept_exact_and_reject_one_short_atomically() {
    let epoch = "epoch-subscribe-bytes";
    let scope = registry_scope(epoch);
    let (mut root, _dir) = fresh_root(epoch);
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let base = root.test_used_bytes(LeaseRole::Reconciliation);
    assert_eq!(base, 1024);
    let request = attach(&scope, "attach:bytes", Value::Null);
    let cost = crate::recording_registry::kernel::budget::measured(request.as_value())
        .unwrap()
        .bytes
        + 2 * 1024;
    root.test_set_byte_limit(LeaseRole::Reconciliation, base + cost - 1);
    assert!(matches!(
        root.attach(&read, request.clone()),
        Err(LeaseError::Capacity)
    ));
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), base);
    assert_eq!(root.test_live_subscriptions(), 0);
    root.test_set_byte_limit(LeaseRole::Reconciliation, base + cost);
    let (reference, _) = attached(&root.attach(&read, request.clone()).unwrap());
    // The retry did not consume a subscription sequence number.
    assert_eq!(reference, "native-subscription:1");
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), base + cost);
    root.attach(&read, request).unwrap();
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), base + cost);

    // Detach returns exactly the live slot while keeping the request and reply metadata.
    let detach = control(&scope, "control:bytes", &reference, "detach");
    let detach_cost = crate::recording_registry::kernel::budget::measured(detach.as_value())
        .unwrap()
        .bytes
        + 1024;
    root.test_set_byte_limit(
        LeaseRole::Reconciliation,
        base + cost - 1024 + detach_cost - 1,
    );
    assert!(matches!(
        root.control(&read, detach.clone()),
        Err(LeaseError::Capacity)
    ));
    assert_eq!(root.test_live_subscriptions(), 1);
    root.test_set_byte_limit(LeaseRole::Reconciliation, base + cost - 1024 + detach_cost);
    root.control(&read, detach).unwrap();
    assert_eq!(root.test_live_subscriptions(), 0);
    assert_eq!(
        root.test_used_bytes(LeaseRole::Reconciliation),
        base + cost - 1024 + detach_cost
    );
}
