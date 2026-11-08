//! Read-only original-call inspection (wire-host design §9, adapter acceptance 2).
use super::registry_observation::handle_request;
use super::*;
use scada_model::recording_wire::{
    RecordingWireAttachRequest, RecordingWireCallInspectionReply,
    RecordingWireCallInspectionRequest, RecordingWireCancelRequest, RecordingWireControlRequest,
};

fn inspect(scope: &Value, id: &str, original: &Value) -> RecordingWireCallInspectionRequest {
    RecordingWireCallInspectionRequest::from_value(json!({
        "version":1, "kind":"recordingWireCallInspectionRequest", "scope":scope,
        "callInspectionId":id, "original":original
    }))
    .unwrap()
}

fn outcome(reply: &RecordingWireCallInspectionReply) -> &Value {
    &reply.as_value()["outcome"]
}

fn terminal(reply: &Value) -> Value {
    json!({"kind":"terminal","reply":reply})
}

#[tokio::test]
async fn registry_call_inspection_never_dispatches_and_recovers_the_original_reply() {
    let epoch = "epoch-call-apply";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, pause, admission, dir) =
        ready_apply_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let before = sqlite_applied_revision(&dir.0);
    let original = admission.as_value().clone();

    // Unregistered originals are only looked up: no admission, lease or native apply appears.
    let unseen = inspect(&scope, "call:unseen", &original);
    let not_found = root.inspect_call(&mutation, unseen.clone()).unwrap();
    assert_eq!(*outcome(&not_found), json!({"kind":"notFound"}));
    assert_eq!(not_found.as_value()["request"], *unseen.as_value());
    let lease = registry_lease(&scope, "call:never-leased", "call:never", "mutation", 1000);
    assert_eq!(
        *outcome(
            &root
                .inspect_call(&mutation, inspect(&scope, "call:lease", lease.as_value()))
                .unwrap()
        ),
        json!({"kind":"notFound"})
    );
    assert_eq!(root.test_lease_consumed("call:never-leased"), None);
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 0);

    // A registered, undispatched admission is pending; inspection still never dispatches.
    let ticket = match root
        .register_apply(&mutation, &workflow, &pause, admission)
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    let pending = inspect(&scope, "call:pending", &original);
    for _ in 0..2 {
        assert_eq!(
            *outcome(&root.inspect_call(&mutation, pending.clone()).unwrap()),
            json!({"kind":"pending"})
        );
    }
    assert!(root.apply_reply(&mutation, &ticket).unwrap().is_none());
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 0);
    assert_eq!(sqlite_applied_revision(&dir.0), before);

    // The original reply is lost in transit; the same and earlier IDs now read it as terminal.
    let accepted = root.dispatch_apply(&mutation, &ticket).unwrap();
    assert_eq!(accepted.as_value()["outcome"]["kind"], "accepted");
    let recovered = root.inspect_call(&mutation, pending.clone()).unwrap();
    assert_eq!(*outcome(&recovered), terminal(accepted.as_value()));
    assert_eq!(
        outcome(&root.inspect_call(&mutation, unseen).unwrap())["reply"],
        *accepted.as_value()
    );
    // A new ID registered after the original finished is terminal at once.
    assert_eq!(
        *outcome(
            &root
                .inspect_call(&mutation, inspect(&scope, "call:late", &original))
                .unwrap()
        ),
        terminal(accepted.as_value())
    );
    assert_eq!(root.inspect_call(&mutation, pending).unwrap(), recovered);
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert_eq!(
        root.apply_reply(&mutation, &ticket).unwrap(),
        Some(accepted)
    );

    // Either role of the same principal inspects a lease; another principal cannot.
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let read_lease = registry_lease(
        &scope,
        "call:read-lease",
        "call:read",
        "reconciliation",
        500,
    );
    let issued = root.issue_lease(&read, read_lease.clone()).unwrap();
    let lease_inspection = inspect(&scope, "call:read-lease", read_lease.as_value());
    let bob = root.test_session("bob", LeaseRole::Reconciliation);
    assert!(matches!(
        root.inspect_call(&bob, lease_inspection.clone()),
        Err(LeaseError::Forbidden)
    ));
    assert_eq!(
        *outcome(&root.inspect_call(&read, lease_inspection).unwrap()),
        terminal(issued.as_value())
    );
    assert_eq!(
        *outcome(
            &root
                .inspect_call(
                    &mutation,
                    inspect(&scope, "call:read-lease:mutation", read_lease.as_value())
                )
                .unwrap()
        ),
        terminal(issued.as_value())
    );
}

#[tokio::test]
async fn registry_call_inspection_keeps_an_unknown_original_after_accepted_knowledge() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-call-unknown");
    let mut root = RecordingRegistryRoot::test_try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let mutation = root.test_session("alice", LeaseRole::Mutation);
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let change = change("call-unknown");
    let workflow = root.reserve_workflow(&mutation, change.clone()).unwrap();
    let lease_request = registry_lease(
        &scope,
        "call-unknown-lease",
        "call-unknown-admission",
        "mutation",
        1000,
    );
    let lease = root
        .issue_preflight_lease(&mutation, &workflow, lease_request.clone())
        .unwrap();
    // A lost lease reply is recovered by inspection, never by re-issuing.
    assert_eq!(
        *outcome(
            &root
                .inspect_call(
                    &mutation,
                    inspect(&scope, "call:lease", lease_request.as_value())
                )
                .unwrap()
        ),
        terminal(lease.as_value())
    );
    let original = registry_preflight(&scope, &change, "call-unknown-admission", &lease);
    let ticket = match root
        .register_preflight(&mutation, &workflow, original.clone())
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new registration expected"),
    };
    root.test_set_dispatch_fault(&mutation, &ticket, TestDispatchFault::ProjectionPanic);
    let unknown = root.dispatch_preflight(&mutation, &ticket).unwrap();
    assert_eq!(unknown.as_value()["outcome"]["kind"], "unknown");
    let first = inspect(&scope, "call:unknown", original.as_value());
    let saved = root.inspect_call(&mutation, first.clone()).unwrap();
    assert_eq!(*outcome(&saved), terminal(unknown.as_value()));

    // Admission inspection proves acceptance; the original call's reply stays unknown.
    let inspection_request = registry_inspection(&original, "call-unknown-inspection");
    let knowledge = root
        .inspect_preflight_admission(&read, &workflow, inspection_request.clone())
        .unwrap();
    assert_eq!(
        knowledge.as_value()["outcome"]["reply"]["outcome"]["kind"],
        "accepted"
    );
    assert_eq!(root.inspect_call(&mutation, first).unwrap(), saved);
    assert_eq!(
        *outcome(
            &root
                .inspect_call(
                    &mutation,
                    inspect(&scope, "call:unknown-later", original.as_value())
                )
                .unwrap()
        ),
        terminal(unknown.as_value())
    );
    // A lost admission-inspection reply is itself recovered as its saved terminal.
    assert_eq!(
        *outcome(
            &root
                .inspect_call(
                    &read,
                    inspect(&scope, "call:inspection", inspection_request.as_value())
                )
                .unwrap()
        ),
        terminal(knowledge.as_value())
    );
    let unseen_inspection = registry_inspection(&original, "call-unknown-unseen");
    assert_eq!(
        *outcome(
            &root
                .inspect_call(
                    &read,
                    inspect(&scope, "call:unseen", unseen_inspection.as_value())
                )
                .unwrap()
        ),
        json!({"kind":"notFound"})
    );
    assert_eq!(root.test_admission_inspection_count(), 1);
    assert_eq!(
        root.preflight_reply(&mutation, &ticket).unwrap(),
        Some(unknown)
    );
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
}

#[tokio::test]
async fn registry_call_inspection_recovers_lost_cancel_attach_and_control_acks() {
    let epoch = "epoch-call-acks";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, preflight, pause_admission, _dir) =
        ready_pause_registry(epoch, 1000).await;
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let candidate = handle_request(
        &root
            .preflight_reply(&mutation, &preflight)
            .unwrap()
            .unwrap(),
    );
    let cancel = RecordingWireCancelRequest::from_value(json!({
        "version":1, "kind":"recordingWireCancelRequest", "scope":scope,
        "cancelId":"call:cancel", "target":{"kind":"operation","ref":candidate["operationId"]}
    }))
    .unwrap();
    let unseen_cancel = inspect(&scope, "call:cancel", cancel.as_value());
    assert_eq!(
        *outcome(&root.inspect_call(&mutation, unseen_cancel.clone()).unwrap()),
        json!({"kind":"notFound"})
    );
    assert_eq!(root.test_cancel_count(), 0);
    let ack = root.request_cancel(&mutation, cancel).unwrap();
    assert_eq!(
        *outcome(&root.inspect_call(&mutation, unseen_cancel).unwrap()),
        terminal(ack.as_value())
    );
    assert_eq!(root.test_cancel_count(), 1);
    assert_eq!(root.test_cancel_notified_handles(), 0);

    let attach = RecordingWireAttachRequest::from_value(json!({
        "version":1, "kind":"recordingWireAttachRequest", "scope":scope,
        "attachId":"call:attach", "afterRevision":null
    }))
    .unwrap();
    let unseen_attach = inspect(&scope, "call:attach", attach.as_value());
    assert_eq!(
        *outcome(&root.inspect_call(&read, unseen_attach.clone()).unwrap()),
        json!({"kind":"notFound"})
    );
    assert_eq!(root.test_live_subscriptions(), 0);
    let attached = root.attach(&read, attach).unwrap();
    let reference = attached.as_value()["outcome"]["subscriptionRef"]
        .as_str()
        .unwrap()
        .to_owned();
    // A later revision never replaces the first snapshot of the saved attach reply.
    let pause = match root
        .register_pause_join(&mutation, &workflow, &preflight, pause_admission)
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("new pause"),
    };
    root.dispatch_pause_join(&mutation, &pause).unwrap();
    let latest = root.owner_snapshot(&read).unwrap();
    assert_ne!(
        latest["revision"],
        attached.as_value()["outcome"]["snapshot"]["revision"]
    );
    assert_eq!(
        *outcome(&root.inspect_call(&read, unseen_attach).unwrap()),
        terminal(attached.as_value())
    );

    let control = RecordingWireControlRequest::from_value(json!({
        "version":1, "kind":"recordingWireControlRequest", "scope":scope,
        "controlId":"call:control", "subscriptionRef":reference, "action":"snapshot"
    }))
    .unwrap();
    let unseen_control = inspect(&scope, "call:control", control.as_value());
    assert_eq!(
        *outcome(&root.inspect_call(&read, unseen_control.clone()).unwrap()),
        json!({"kind":"notFound"})
    );
    let snapshot = root.control(&read, control).unwrap();
    assert_eq!(
        *outcome(&root.inspect_call(&read, unseen_control).unwrap()),
        terminal(snapshot.as_value())
    );
    assert_eq!(root.test_live_subscriptions(), 1);
}

#[tokio::test]
async fn registry_call_inspection_is_role_principal_scope_and_capacity_bound() {
    let epoch = "epoch-call-auth";
    let scope = registry_scope(epoch);
    let (mut root, mutation, _workflow, preflight, _pause, _dir) =
        ready_pause_registry(epoch, 1000).await;
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let bob = root.test_session("bob", LeaseRole::Mutation);
    let original = root
        .preflight_reply(&mutation, &preflight)
        .unwrap()
        .unwrap()
        .as_value()["request"]
        .clone();
    let request = inspect(&scope, "call:auth", &original);
    let base = root.test_used_bytes(LeaseRole::Reconciliation);

    // The workflow principal and the root scope are required; the original's role is not.
    assert!(matches!(
        root.inspect_call(&bob, request.clone()),
        Err(LeaseError::Forbidden)
    ));
    assert!(matches!(
        root.inspect_call(
            &mutation,
            inspect(&registry_scope("other-epoch"), "call:auth", &original)
        ),
        Err(LeaseError::Forbidden)
    ));
    let lease = registry_lease(
        &scope,
        "preflight-lease",
        "preflight-admission",
        "mutation",
        1000,
    );
    let bob_lease = inspect(&scope, "call:bob-lease", lease.as_value());
    assert!(matches!(
        root.inspect_call(&bob, bob_lease),
        Err(LeaseError::Forbidden)
    ));
    // A saved original under the same ID with another body is a protocol violation.
    let changed = registry_lease(
        &scope,
        "preflight-lease",
        "preflight-admission",
        "mutation",
        999,
    );
    assert!(matches!(
        root.inspect_call(
            &mutation,
            inspect(&scope, "call:changed", changed.as_value())
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    assert_eq!(root.test_call_inspection_count(), 0);
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), base);

    // Only the request is retained in the read pool: exact fits, one short is refused.
    let cost = crate::recording_registry::kernel::budget::measured(request.as_value())
        .unwrap()
        .bytes;
    root.test_set_byte_limit(LeaseRole::Reconciliation, base + cost - 1);
    assert!(matches!(
        root.inspect_call(&mutation, request.clone()),
        Err(LeaseError::Capacity)
    ));
    assert_eq!(root.test_call_inspection_count(), 0);
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), base);
    root.test_set_byte_limit(LeaseRole::Reconciliation, base + cost);
    let saved = root.inspect_call(&mutation, request.clone()).unwrap();
    assert_eq!(outcome(&saved)["kind"], "terminal");
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), base + cost);
    assert_eq!(
        root.inspect_call(&mutation, request.clone()).unwrap(),
        saved
    );
    assert_eq!(root.test_used_bytes(LeaseRole::Reconciliation), base + cost);

    // The same ID is fixed to its original and principal.
    assert!(matches!(
        root.inspect_call(&mutation, inspect(&scope, "call:auth", lease.as_value())),
        Err(LeaseError::ProtocolViolation)
    ));
    let bob_read = root.test_session("bob", LeaseRole::Mutation);
    assert!(matches!(
        root.inspect_call(&bob_read, request.clone()),
        Err(LeaseError::Forbidden)
    ));
    assert_eq!(root.test_call_inspection_count(), 1);

    // A read session of the same principal recovers the mutation original under its own ID.
    root.test_set_byte_limit(LeaseRole::Reconciliation, 2 * 1024 * 1024);
    assert_eq!(
        *outcome(
            &root
                .inspect_call(&read, inspect(&scope, "call:auth:read", &original))
                .unwrap()
        ),
        *outcome(&saved)
    );

    // A revoked grant is unauthorized.
    let revoked = root.test_session("alice", LeaseRole::Mutation);
    root.revoke_session(&revoked).unwrap();
    assert!(matches!(
        root.inspect_call(&revoked, request.clone()),
        Err(LeaseError::Unauthorized)
    ));
    assert_eq!(
        root.inspect_call(&mutation, request.clone()).unwrap(),
        saved
    );
}

#[tokio::test]
async fn registry_call_inspection_keeps_serving_after_handoff_closes_the_root() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-call-closed");
    let mut root = RecordingRegistryRoot::test_try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let lease = registry_lease(
        &scope,
        "call:closed-lease",
        "call:closed",
        "reconciliation",
        500,
    );
    let request = inspect(&scope, "call:closed", lease.as_value());
    let original = root.issue_lease(&read, lease.clone()).unwrap();
    let before = root.inspect_call(&read, request.clone()).unwrap();
    assert_eq!(*outcome(&before), terminal(original.as_value()));
    root.try_handoff().unwrap();
    // Close keeps every lookup of the immutable records (adapter acceptance 6): the same ID,
    // a new ID first sent after close, and the original call itself return the saved reply.
    assert_eq!(root.inspect_call(&read, request).unwrap(), before);
    let late = root
        .inspect_call(&read, inspect(&scope, "call:after-close", lease.as_value()))
        .unwrap();
    assert_eq!(*outcome(&late), terminal(original.as_value()));
    assert_eq!(root.issue_lease(&read, lease).unwrap(), original);
    // Nothing new starts: an unseen original stays `notFound` and a new lease is `Closed`.
    let unseen = registry_lease(
        &scope,
        "call:unseen-lease",
        "call:unseen",
        "reconciliation",
        500,
    );
    assert_eq!(
        *outcome(
            &root
                .inspect_call(&read, inspect(&scope, "call:unseen", unseen.as_value()))
                .unwrap()
        ),
        json!({"kind":"notFound"})
    );
    assert_eq!(root.issue_lease(&read, unseen), Err(LeaseError::Closed));
    assert_eq!(root.test_lease_consumed("call:unseen-lease"), None);
}
