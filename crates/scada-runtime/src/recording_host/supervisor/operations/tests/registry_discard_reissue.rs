//! Re-issuing a discard lease that expired unregistered (product owner design §6.1).
use super::*;

fn discard_admission_for(
    epoch: &str,
    admission: &str,
    lease: &RecordingWireLeaseReply,
    accepted: &RecordingAdmissionReply,
) -> RecordingAdmissionRequest {
    registry_discard_admission(
        &registry_scope(epoch),
        &change("pause-ready"),
        admission,
        lease,
        accepted.as_value()["outcome"]["handle"]["changeRef"]
            .as_str()
            .unwrap(),
    )
}

#[tokio::test]
async fn registry_discard_lease_expired_unregistered_is_reissued_under_new_ids_once() {
    let epoch = "epoch-discard-reissue";
    let scope = registry_scope(epoch);
    let (mut root, session, workflow, preflight, accepted, _dir) =
        ready_discard_candidate_registry(epoch).await;
    let client = root.test_native_client();
    let first_request = registry_lease(&scope, "discard-lease-1", "discard-1", "mutation", 100);
    let first = root
        .issue_discard_lease(&session, &workflow, &preflight, first_request.clone())
        .unwrap();
    let bytes = root.test_used_bytes(LeaseRole::Mutation);
    let revisions = root.test_reserved_revisions();
    let leases = root.test_lease_count(LeaseRole::Mutation);
    tokio::time::sleep(Duration::from_millis(150)).await;

    // The same IDs re-fetch the saved reply without extending it; its registration is Expired.
    assert_eq!(
        root.issue_discard_lease(&session, &workflow, &preflight, first_request.clone())
            .unwrap(),
        first
    );
    let stale = discard_admission_for(epoch, "discard-1", &first, &accepted);
    assert!(matches!(
        root.register_discard(&session, &workflow, &preflight, stale.clone()),
        Err(LeaseError::Expired)
    ));
    // A new lease ID cannot reuse the old admission ID.
    assert!(matches!(
        root.issue_discard_lease(
            &session,
            &workflow,
            &preflight,
            registry_lease(&scope, "discard-lease-x", "discard-1", "mutation", 1000)
        ),
        Err(LeaseError::ProtocolViolation)
    ));

    let second_request = registry_lease(&scope, "discard-lease-2", "discard-2", "mutation", 1000);
    let second = root
        .issue_discard_lease(&session, &workflow, &preflight, second_request.clone())
        .unwrap();
    assert_ne!(
        second.as_value()["outcome"]["deadlineLeaseRef"],
        first.as_value()["outcome"]["deadlineLeaseRef"]
    );
    // The same reserved slot: no new bytes or revisions, one more lease in history.
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
    assert_eq!(root.test_reserved_revisions(), revisions);
    assert_eq!(root.test_lease_count(LeaseRole::Mutation), leases + 1);
    // A live lease keeps its IDs; the replaced one still re-fetches its own reply.
    assert!(matches!(
        root.issue_discard_lease(
            &session,
            &workflow,
            &preflight,
            registry_lease(&scope, "discard-lease-3", "discard-3", "mutation", 1000)
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    assert_eq!(
        root.issue_discard_lease(&session, &workflow, &preflight, first_request)
            .unwrap(),
        first
    );
    assert_eq!(
        root.issue_discard_lease(&session, &workflow, &preflight, second_request.clone())
            .unwrap(),
        second
    );
    assert!(matches!(
        root.register_discard(&session, &workflow, &preflight, stale),
        Err(LeaseError::ProtocolViolation)
    ));

    let admission = discard_admission_for(epoch, "discard-2", &second, &accepted);
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
    assert_eq!(client.shared.discard_calls.load(Ordering::Relaxed), 1);
    assert_eq!(client.state().phase, OperationsPhase::Idle);
    assert!(root.try_handoff().is_ok());
}

#[tokio::test]
async fn registry_discard_lease_registered_then_expired_is_never_reissued() {
    let epoch = "epoch-discard-registered";
    let scope = registry_scope(epoch);
    let (mut root, session, workflow, preflight, accepted, _dir) =
        ready_discard_candidate_registry(epoch).await;
    let client = root.test_native_client();
    let lease = root
        .issue_discard_lease(
            &session,
            &workflow,
            &preflight,
            registry_lease(&scope, "discard-lease-1", "discard-1", "mutation", 100),
        )
        .unwrap();
    let admission = discard_admission_for(epoch, "discard-1", &lease, &accepted);
    assert!(matches!(
        root.register_discard(&session, &workflow, &preflight, admission)
            .unwrap(),
        DiscardRegistration::Registered(_)
    ));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(matches!(
        root.issue_discard_lease(
            &session,
            &workflow,
            &preflight,
            registry_lease(&scope, "discard-lease-2", "discard-2", "mutation", 1000)
        ),
        Err(LeaseError::ProtocolViolation)
    ));
    assert_eq!(client.shared.discard_calls.load(Ordering::Relaxed), 0);
}
