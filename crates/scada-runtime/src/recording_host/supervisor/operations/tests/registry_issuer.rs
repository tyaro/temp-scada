//! Product session issuance, read-only quiescence, and recovery after demotion
//! (host-gate design §3, §4, §6; implementation order §9-2).
use super::*;
use crate::recording_registry::{RecordingPrincipal, RecordingSessionIssuer};
use scada_model::recording_wire::RecordingWireCallInspectionRequest;

fn inspect(scope: &Value, id: &str, original: &Value) -> RecordingWireCallInspectionRequest {
    RecordingWireCallInspectionRequest::from_value(json!({
        "version":1, "kind":"recordingWireCallInspectionRequest", "scope":scope,
        "callInspectionId":id, "original":original
    }))
    .unwrap()
}

type Directory = crate::recording_host::retention::tests::Directory;

fn product_root(
    epoch: &str,
) -> (
    RecordingRegistryRoot,
    RecordingSessionIssuer,
    Value,
    Directory,
) {
    let (owner, dir) = setup();
    let scope = registry_scope(epoch);
    let (root, issuer) = RecordingRegistryRoot::try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    (root, issuer, scope, dir)
}

#[test]
fn recording_principals_are_bound_to_the_banto_user_id_or_the_auth_disabled_mode() {
    assert_eq!(RecordingPrincipal::banto_user(7).as_str(), "banto-user:7");
    assert_eq!(
        RecordingPrincipal::auth_disabled_local().as_str(),
        "banto-local:auth-disabled"
    );
    assert_ne!(
        RecordingPrincipal::banto_user(7),
        RecordingPrincipal::banto_user(8)
    );
}

#[tokio::test]
async fn registry_issuer_issues_principal_bound_sessions_for_its_own_root_only() {
    let (mut root, issuer, scope, _dir) = product_root("epoch-issuer");
    let (mut other, other_issuer, _, _other_dir) = product_root("epoch-issuer-other");
    let admin = RecordingPrincipal::banto_user(7);
    assert!(matches!(
        other_issuer.issue(&mut root, admin.clone(), LeaseRole::Mutation),
        Err(LeaseError::Forbidden)
    ));
    assert!(matches!(
        issuer.issue(&mut other, admin.clone(), LeaseRole::Mutation),
        Err(LeaseError::Forbidden)
    ));

    let mutation = issuer
        .issue(&mut root, admin.clone(), LeaseRole::Mutation)
        .unwrap();
    let change = change("issuer");
    let workflow = root.reserve_workflow(&mutation, change.clone()).unwrap();
    // The issued session carries the principal string and the requested role.
    let read = issuer
        .issue(&mut root, admin.clone(), LeaseRole::Reconciliation)
        .unwrap();
    assert!(matches!(
        root.reserve_workflow(&read, change.clone()),
        Err(LeaseError::Forbidden)
    ));
    let other_admin = issuer
        .issue(
            &mut root,
            RecordingPrincipal::banto_user(8),
            LeaseRole::Mutation,
        )
        .unwrap();
    assert!(matches!(
        root.reserve_workflow(&other_admin, change.clone()),
        Err(LeaseError::Forbidden)
    ));
    let local = issuer
        .issue(
            &mut root,
            RecordingPrincipal::auth_disabled_local(),
            LeaseRole::Mutation,
        )
        .unwrap();
    assert!(matches!(
        root.reserve_workflow(&local, change.clone()),
        Err(LeaseError::Forbidden)
    ));

    // Revocation ends that grant only; a fresh session for the principal keeps the workflow.
    root.revoke_session(&mutation).unwrap();
    assert!(matches!(
        root.reserve_workflow(&mutation, change.clone()),
        Err(LeaseError::Unauthorized)
    ));
    let renewed = issuer
        .issue(&mut root, admin.clone(), LeaseRole::Mutation)
        .unwrap();
    let again = root.reserve_workflow(&renewed, change.clone()).unwrap();
    assert_eq!(again.sequence(), workflow.sequence());
    assert_eq!(again.change_id(), workflow.change_id());
    let lease = registry_lease(&scope, "issuer-lease", "issuer-admission", "mutation", 1000);
    assert!(root
        .issue_preflight_lease(&renewed, &workflow, lease)
        .is_ok());

    // Issuing stays possible after close, where only re-fetches and lookups remain open.
    root.begin_shutdown();
    let closing = issuer.issue(&mut root, admin, LeaseRole::Mutation).unwrap();
    assert!(matches!(
        root.reserve_workflow(&closing, change),
        Ok(ticket) if ticket.sequence() == workflow.sequence()
    ));
}

#[tokio::test]
async fn registry_quiescence_reports_unsettled_workflows_without_changing_anything() {
    let (owner, _dir) = setup();
    let scope = registry_scope("epoch-quiescence");
    let mut root = RecordingRegistryRoot::test_try_new(
        RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap(),
        scope.clone(),
    )
    .ok()
    .unwrap();
    let alice = RecordingPrincipal::banto_user(1);
    let bob = RecordingPrincipal::banto_user(2);
    let session = root.test_session(alice.as_str(), LeaseRole::Mutation);
    let client = root.test_native_client();
    let quiet = root.quiescence();
    assert!(quiet.is_quiescent());
    assert!(!quiet.holds(&alice) && !quiet.holds(&bob));

    // A reservation alone strands nothing.
    let change = change("quiescence");
    let workflow = root.reserve_workflow(&session, change.clone()).unwrap();
    assert!(root.quiescence().is_quiescent());

    // A registered, undispatched preflight is unsettled and held by the workflow principal.
    let lease = root
        .issue_preflight_lease(
            &session,
            &workflow,
            registry_lease(&scope, "q-lease", "q-admission", "mutation", 1000),
        )
        .unwrap();
    let request = registry_preflight(&scope, &change, "q-admission", &lease);
    let ticket = match root
        .register_preflight(&session, &workflow, request)
        .unwrap()
    {
        PreflightRegistration::Registered(ticket) => ticket,
        _ => panic!("new registration expected"),
    };
    let bytes = root.test_used_bytes(LeaseRole::Mutation);
    let unsettled = root.quiescence();
    assert!(!unsettled.is_quiescent());
    assert!(unsettled.holds(&alice));
    assert!(!unsettled.holds(&bob));
    // Asking changed nothing: no dispatch, native call, lease, or byte.
    assert_eq!(root.quiescence(), unsettled);
    assert!(root.preflight_reply(&session, &ticket).unwrap().is_none());
    assert!(client.shared.core.lock().unwrap().workflow.is_none());
    assert_eq!(root.test_used_bytes(LeaseRole::Mutation), bytes);
    assert_eq!(root.test_lease_count(LeaseRole::Mutation), 1);

    // A Candidate change still needs a discard or the rest of the workflow.
    let reply = root.dispatch_preflight(&session, &ticket).unwrap();
    assert_eq!(reply.as_value()["outcome"]["kind"], "accepted");
    tokio::time::timeout(Duration::from_secs(5), async {
        while root
            .preflight_completion(&session, &ticket)
            .unwrap()
            .is_none()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let candidate = root.quiescence();
    assert!(!candidate.is_quiescent());
    assert!(candidate.holds(&alice) && !candidate.holds(&bob));
    assert!(matches!(root.try_handoff(), Err(OwnerError::Busy)));
}

#[tokio::test]
async fn registry_quiescence_follows_apply_from_registration_to_confirmed_completion() {
    let epoch = "epoch-quiescence-apply";
    let (mut root, session, workflow, pause, admission, _dir) =
        ready_apply_registry(epoch, 1000).await;
    // `ready_apply_registry` reserved the workflow as "alice", so other principals are free.
    let paused = root.quiescence();
    assert!(!paused.is_quiescent());
    assert!(!paused.holds(&RecordingPrincipal::auth_disabled_local()));
    let ticket = match root
        .register_apply(&session, &workflow, &pause, admission)
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    assert!(!root.quiescence().is_quiescent());
    let accepted = root.dispatch_apply(&session, &ticket).unwrap();
    assert_eq!(accepted.as_value()["outcome"]["kind"], "accepted");
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
    assert!(root.quiescence().is_quiescent());
    root.try_handoff().unwrap();
    assert!(root.quiescence().is_quiescent());
}

#[tokio::test]
async fn registry_demoted_admin_recovers_a_lost_apply_reply_with_a_read_session() {
    let epoch = "epoch-demoted";
    let scope = registry_scope(epoch);
    let (mut root, _alice, workflow, pause, admission, _dir) =
        ready_apply_registry(epoch, 1000).await;
    // The helper's sessions belong to "alice"; the host issues by principal string alike.
    let admin = root.test_session("alice", LeaseRole::Mutation);
    let admin_read = root.test_session("alice", LeaseRole::Reconciliation);
    let client = root.test_native_client();
    let original = admission.as_value().clone();
    let ticket = match root
        .register_apply(&admin, &workflow, &pause, admission)
        .unwrap()
    {
        ApplyRegistration::Registered(ticket) => ticket,
        _ => panic!("new apply"),
    };
    // The original reply is lost in transit.
    let accepted = root.dispatch_apply(&admin, &ticket).unwrap();
    assert_eq!(accepted.as_value()["outcome"]["kind"], "accepted");

    // Demotion to Viewer: the host revokes every session of the desktop session and issues
    // a read session only.
    root.revoke_session(&admin).unwrap();
    root.revoke_session(&admin_read).unwrap();
    let viewer = root.test_session("alice", LeaseRole::Reconciliation);
    let recovered = root
        .inspect_call(&viewer, inspect(&scope, "call:demoted", &original))
        .unwrap();
    assert_eq!(
        recovered.as_value()["outcome"],
        json!({"kind":"terminal","reply":accepted.as_value()})
    );
    // The same-ID re-fetch keeps the original role, and nothing was dispatched again.
    assert!(matches!(
        root.apply_reply(&viewer, &ticket),
        Err(LeaseError::Forbidden)
    ));
    assert!(matches!(
        root.dispatch_apply(&viewer, &ticket),
        Err(LeaseError::Forbidden)
    ));
    assert!(matches!(
        root.inspect_call(&admin, inspect(&scope, "call:revoked", &original)),
        Err(LeaseError::Unauthorized)
    ));
    // Another principal sees nothing even with a fresh read session.
    let other = root.test_session("bob", LeaseRole::Reconciliation);
    assert!(matches!(
        root.inspect_call(&other, inspect(&scope, "call:other", &original)),
        Err(LeaseError::Forbidden)
    ));
    assert_eq!(client.shared.apply_calls.load(Ordering::Relaxed), 1);
}
