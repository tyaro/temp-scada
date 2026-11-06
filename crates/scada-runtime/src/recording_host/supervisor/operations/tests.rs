use super::*;
use crate::recording_host::retention::tests::control;
use crate::recording_host::{RecordingPhase, RecordingPlanTurnIntent};
use crate::recording_registry::{
    LeaseError, LeaseRole, PreflightRegistration, RecordingRegistryOwnerSeed,
    RecordingRegistryRoot, TestDispatchFault,
};
use scada_model::recording_admission::{
    RecordingAdmissionInspectionReply, RecordingAdmissionInspectionRequest,
    RecordingAdmissionRequest,
};
use scada_model::recording_wire::{RecordingWireLeaseReply, RecordingWireLeaseRequest};
use serde_json::{json, Value};
use std::time::Duration;
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
