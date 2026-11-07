//! Management-side registry shutdown (adapter design §6, acceptance 6).
use super::registry_observation::{observe_terminal, operation_observation, outcome};
use super::*;
use crate::recording_registry::RegistryLifecycle;
use scada_model::recording_wire::RecordingWireCancelRequest;

#[tokio::test]
async fn registry_shutdown_settles_an_undispatched_pause_and_drains_only_through_discard() {
    let epoch = "epoch-shutdown-undispatched";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, preflight, pause_admission, dir) =
        ready_pause_registry(epoch, 1000).await;
    let client = root.test_native_client();
    let read = root.test_session("alice", LeaseRole::Reconciliation);
    let pause = match root
        .register_pause_join(&mutation, &workflow, &preflight, pause_admission.clone())
        .unwrap()
    {
        PauseRegistration::Registered(ticket) => ticket,
        _ => panic!("new pause"),
    };
    let before = sqlite_applied_revision(&dir.0);
    assert_eq!(root.lifecycle(), RegistryLifecycle::Open);

    root.begin_shutdown();
    root.begin_shutdown();
    assert_eq!(root.lifecycle(), RegistryLifecycle::Draining);
    // The registered admission is settled once, certain and not accepted, with no native call.
    let reply = root.dispatch_pause_join(&mutation, &pause).unwrap();
    assert_eq!(
        reply.as_value()["outcome"],
        json!({"kind":"rejected","error":"cancelled"})
    );
    assert_eq!(root.dispatch_pause_join(&mutation, &pause).unwrap(), reply);
    assert_eq!(root.pause_reply(&mutation, &pause).unwrap(), Some(reply));
    assert!(matches!(
        root.register_pause_join(&mutation, &workflow, &preflight, pause_admission.clone()),
        Ok(PauseRegistration::Existing(_))
    ));
    assert!(root.pause_completion(&mutation, &pause).unwrap().is_none());
    assert_eq!(client.state().phase, OperationsPhase::Candidate);

    // No new general lease of either role; the root keeps native ownership.
    for (session, role) in [(&mutation, "mutation"), (&read, "reconciliation")] {
        let lease = registry_lease(
            &scope,
            &format!("lease:{role}"),
            &format!("admission:{role}"),
            role,
            1000,
        );
        assert!(matches!(
            root.issue_lease(session, lease),
            Err(LeaseError::Closed)
        ));
    }
    // The native Candidate still refuses handoff; the root and resources stay held.
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
    assert_eq!(root.lifecycle(), RegistryLifecycle::Draining);

    // Discard only returns the owner toward quiescence, so it remains open while draining.
    let lease = root
        .issue_discard_lease(
            &mutation,
            &workflow,
            &preflight,
            registry_lease(&scope, "drain-lease", "drain-admission", "mutation", 1000),
        )
        .unwrap();
    let admission = registry_discard_admission(
        &scope,
        &change("pause-ready"),
        "drain-admission",
        &lease,
        pause_admission.as_value()["action"]["changeRef"]
            .as_str()
            .unwrap(),
    );
    let ticket = match root
        .register_discard(&mutation, &workflow, &preflight, admission)
        .unwrap()
    {
        DiscardRegistration::Registered(ticket) => ticket,
        _ => panic!("new discard"),
    };
    assert_eq!(
        root.dispatch_discard(&mutation, &ticket)
            .unwrap()
            .as_value()["outcome"]["kind"],
        "completedDiscard"
    );
    assert_eq!(client.state().phase, OperationsPhase::Idle);
    assert_eq!(client.shared.discard_calls.load(Ordering::Relaxed), 1);
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 0);
    assert_eq!(sqlite_applied_revision(&dir.0), before);
    root.try_handoff().unwrap();
    assert_eq!(root.lifecycle(), RegistryLifecycle::Closed);
}

#[tokio::test]
async fn registry_shutdown_keeps_monitoring_an_accepted_apply_until_handoff() {
    let epoch = "epoch-shutdown-monitor";
    let scope = registry_scope(epoch);
    let (mut root, mutation, workflow, pause, admission, dir) =
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
    let before = sqlite_applied_revision(&dir.0);
    let gate = Arc::new(driver::TestGate::default());
    *client.shared.fault.lock().unwrap() = Some(driver::TestFault::Gate(gate.clone()));
    let accepted = root.dispatch_apply(&mutation, &ticket).unwrap();
    assert_eq!(accepted.as_value()["outcome"]["kind"], "accepted");
    gate.entered.notified().await;

    // Shutdown neither cancels nor joins the accepted native apply.
    root.begin_shutdown();
    let observation = operation_observation(&scope, "observe:shutdown", &operation);
    assert_eq!(
        outcome(&root.observe_result(&read, observation.clone()).unwrap())["kind"],
        "pending"
    );
    assert_eq!(root.test_cancel_notified_handles(), 0);
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
    assert_eq!(root.lifecycle(), RegistryLifecycle::Draining);

    // A caller may still cancel a registered handle while the root drains.
    let cancel = RecordingWireCancelRequest::from_value(json!({
        "version":1, "kind":"recordingWireCancelRequest", "scope":scope,
        "cancelId":"cancel:draining", "target":{"kind":"operation", "ref":operation["operationId"]}
    }))
    .unwrap();
    let requested = root.request_cancel(&mutation, cancel).unwrap();
    assert_eq!(
        requested.as_value()["outcome"],
        json!({"kind":"ack","disposition":"requested"})
    );

    *client.shared.fault.lock().unwrap() = None;
    gate.release.notify_one();
    let terminal = observe_terminal(&mut root, &read, observation).await;
    assert_eq!(outcome(&terminal)["result"]["request"], operation);
    assert_eq!(
        root.apply_reply(&mutation, &ticket).unwrap(),
        Some(accepted)
    );
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
    assert_eq!(sqlite_applied_revision(&dir.0), before);
    root.try_handoff().unwrap();
    assert_eq!(root.lifecycle(), RegistryLifecycle::Closed);
}
