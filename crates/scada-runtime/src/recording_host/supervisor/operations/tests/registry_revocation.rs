//! Authorization revocation (adapter design §2, acceptance 6).
use super::registry_observation::{observe_terminal, operation_observation, outcome};
use super::*;
use crate::recording_registry::RegistryLifecycle;
use scada_model::recording_wire::{RecordingWireAttachRequest, RecordingWireCancelRequest};

fn cancel(scope: &Value, id: &str, operation: &Value) -> RecordingWireCancelRequest {
    RecordingWireCancelRequest::from_value(json!({
        "version":1, "kind":"recordingWireCancelRequest", "scope":scope,
        "cancelId":id, "target":{"kind":"operation", "ref":operation["operationId"]}
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

#[tokio::test]
async fn registry_revocation_rejects_the_grant_and_keeps_monitoring_an_accepted_apply() {
    let epoch = "epoch-revoke-monitor";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, pause, admission, dir) =
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
    let before = sqlite_applied_revision(&dir.0);
    let gate = Arc::new(driver::TestGate::default());
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    let accepted = root.dispatch_apply(&mutation, &ticket).unwrap();
    assert_eq!(accepted.as_value()["outcome"]["kind"], "accepted");
    gate.entered.notified().await;
    let reference = root
        .attach(&read, attach(&scope, "attach:before-revoke"))
        .unwrap()
        .as_value()["outcome"]["subscriptionRef"]
        .as_str()
        .unwrap()
        .to_owned();

    // Revoking one grant revokes every clone of it, idempotently, and never touches native state.
    let mutation_clone = mutation.clone();
    root.revoke_session(&mutation).unwrap();
    root.revoke_session(&mutation_clone).unwrap();
    root.revoke_session(&read).unwrap();
    assert_eq!(root.lifecycle(), RegistryLifecycle::Open);
    assert_eq!(root.test_cancel_notified_handles(), 0);
    for session in [&mutation, &mutation_clone] {
        assert_eq!(
            root.issue_lease(
                session,
                registry_lease(
                    &scope,
                    "lease:revoked",
                    "admission:revoked",
                    "mutation",
                    1000
                )
            ),
            Err(LeaseError::Unauthorized)
        );
        assert!(matches!(
            root.register_apply(session, &workflow, &pause, admission.clone()),
            Err(LeaseError::Unauthorized)
        ));
        assert_eq!(
            root.dispatch_apply(session, &ticket).err(),
            Some(LeaseError::Unauthorized)
        );
        assert_eq!(
            root.apply_reply(session, &ticket).err(),
            Some(LeaseError::Unauthorized)
        );
        assert_eq!(
            root.request_cancel(session, cancel(&scope, "cancel:revoked", &operation))
                .err(),
            Some(LeaseError::Unauthorized)
        );
    }
    let observation = operation_observation(&scope, "observe:revoked", &operation);
    assert_eq!(
        root.observe_result(&read, observation.clone()).err(),
        Some(LeaseError::Unauthorized)
    );
    assert_eq!(
        root.owner_snapshot(&read).err(),
        Some(LeaseError::Unauthorized)
    );
    assert_eq!(
        root.attach(&read, attach(&scope, "attach:revoked")).err(),
        Some(LeaseError::Unauthorized)
    );
    assert_eq!(
        root.take_state_frame(&read, &reference).err(),
        Some(LeaseError::Unauthorized)
    );
    // The revoked caller's failed cancel did not reach the native handle.
    assert_eq!(root.test_cancel_notified_handles(), 0);

    // Accepted native work keeps running; the root still refuses an unsettled handoff.
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
    // A session the host issues again for the same principal keeps serving the evidence.
    let renewed_read = root.test_session("alice", LeaseRole::Reconciliation);
    let renewed_mutation = root.test_session("alice", LeaseRole::Mutation);
    assert_eq!(
        outcome(
            &root
                .observe_result(&renewed_read, observation.clone())
                .unwrap()
        )["kind"],
        "pending"
    );
    assert_eq!(
        root.apply_reply(&renewed_mutation, &ticket).unwrap(),
        Some(accepted.clone())
    );
    assert_eq!(
        root.request_cancel(
            &renewed_mutation,
            cancel(&scope, "cancel:renewed", &operation)
        )
        .unwrap()
        .as_value()["outcome"],
        json!({"kind":"ack","disposition":"requested"})
    );

    *client.shared.fault.lock().unwrap() = None;
    gate.release.notify_one();
    let terminal = observe_terminal(&mut root, &renewed_read, observation).await;
    assert_eq!(outcome(&terminal)["result"]["request"], operation);
    // The subscription attached by the revoked grant stays principal-bound and live.
    assert!(root
        .take_state_frame(&renewed_read, &reference)
        .unwrap()
        .is_some());
    assert_eq!(
        root.dispatch_apply(&renewed_mutation, &ticket).unwrap(),
        accepted
    );
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert_eq!(sqlite_applied_revision(&dir.0), before);
    root.try_handoff().unwrap();
    // Revocation stays in force after close: an original cancel reply that close still serves
    // goes only to the re-issued grant.
    root.revoke_session(&mutation).unwrap();
    assert_eq!(
        root.request_cancel(&mutation, cancel(&scope, "cancel:renewed", &operation))
            .err(),
        Some(LeaseError::Unauthorized)
    );
    assert_eq!(
        root.request_cancel(
            &renewed_mutation,
            cancel(&scope, "cancel:renewed", &operation)
        )
        .unwrap()
        .as_value()["outcome"],
        json!({"kind":"ack","disposition":"requested"})
    );
}

#[tokio::test]
async fn registry_revocation_never_dispatches_a_registered_admission_for_the_revoked_grant() {
    let epoch = "epoch-revoke-undispatched";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, pause, admission, _dir) =
        ready_apply_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let ticket = match root
        .register_apply(&mutation, &workflow, &pause, admission)
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    root.revoke_session(&mutation).unwrap();
    assert_eq!(
        root.dispatch_apply(&mutation, &ticket).err(),
        Some(LeaseError::Unauthorized)
    );
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 0);
    assert_eq!(client.state().phase, OperationsPhase::Paused);

    // A different grant of another root cannot revoke here.
    let (other_owner, _other_dir) = setup();
    let other = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(other_owner).unwrap(),
        registry_scope("epoch-revoke-other"),
    )
    .ok()
    .unwrap();
    let foreign = other.test_session("alice", LeaseRole::Mutation);
    assert_eq!(root.revoke_session(&foreign), Err(LeaseError::Forbidden));

    // Revocation does not settle the registration; a re-issued grant may still dispatch it once.
    let renewed = root.test_session("alice", LeaseRole::Mutation);
    assert_eq!(root.apply_reply(&renewed, &ticket).unwrap(), None);
    let reply = root.dispatch_apply(&renewed, &ticket).unwrap();
    assert_eq!(reply.as_value()["outcome"]["kind"], "accepted");
    assert_eq!(root.dispatch_apply(&renewed, &ticket).unwrap(), reply);
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert_eq!(
        root.issue_lease(
            &mutation,
            registry_lease(&scope, "lease:after", "admission:after", "mutation", 1000)
        ),
        Err(LeaseError::Unauthorized)
    );
}
