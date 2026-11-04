use super::workflow_boundaries as previous;
use super::*;
use scada_model::recording_operations::RecordingChangeRequest;
fn predecessor(
    limits: ModelLimits,
    qualification: SimulatedRunQualification,
) -> (RegistryModel, ModelSession, Value, WorkflowTicket) {
    let f = previous::data();
    let s = session(&f, &Value::Null);
    let mut m = RegistryModel::new_workflow(s.clone(), limits, qualification).unwrap();
    let t = previous::reserve(&mut m, &s, &f);
    previous::finish_stage(&mut m, &t, &f, "p");
    previous::issue(&mut m, &t, &f, "dEarly");
    let a = previous::begin(&mut m, &t, &f, "dEarly");
    let p = RecordingAdmissionReply::from_value(f["bases"]["dEarlyAccepted"].clone()).unwrap();
    m.observe_native(&a, SimulatedDecision::CompletedDiscard(p.clone()))
        .unwrap();
    m.finish_admission_call(&a, p).unwrap();
    (m, s, f, t)
}
fn change(f: &Value, id: &str) -> RecordingChangeRequest {
    let mut c = f["bases"]["change"].clone();
    c["changeId"] = json!(id);
    c["apply"]["requestId"] = json!(format!("apply-{id}"));
    RecordingChangeRequest::from_value(c).unwrap()
}
fn projection(m: &RegistryModel) -> (WireBound, WireBound, WireBound) {
    let b = m.projection.budget;
    (b.admission, b.operation, b.read)
}
#[test]
fn predecessor_tickets_are_instance_bound_and_tampering_cannot_select_a_record() {
    let (mut a, sa, fa, ta) = predecessor(Default::default(), SimulatedRunQualification::Running);
    let (mut b, sb, fb, tb) = predecessor(Default::default(), SimulatedRunQualification::Running);
    let before = b.stats();
    assert!(matches!(
        b.reserve_next_workflow(
            &sb,
            &ta,
            SimulatedRunQualification::Running,
            change(&fb, "next")
        ),
        Err(ModelError::Forbidden)
    ));
    assert_eq!(b.stats(), before);
    for bad in [
        WorkflowTicket {
            sequence: tb.sequence + 1,
            ..tb.clone()
        },
        WorkflowTicket {
            change_id: "missing".into(),
            ..tb.clone()
        },
    ] {
        assert!(matches!(
            b.reserve_next_workflow(
                &sb,
                &bad,
                SimulatedRunQualification::Running,
                change(&fb, "next")
            ),
            Err(ModelError::InvalidInput)
        ));
        assert_eq!(b.stats(), before);
    }
    assert!(a
        .reserve_next_workflow(
            &sa,
            &ta,
            SimulatedRunQualification::Running,
            change(&fa, "next")
        )
        .is_ok());
}
#[test]
fn renewal_always_qualifies_session_even_for_a_cached_result() {
    let (mut m, s, f, t) = predecessor(Default::default(), SimulatedRunQualification::Running);
    let q = change(&f, "next");
    m.reserve_next_workflow(&s, &t, SimulatedRunQualification::Running, q.clone())
        .unwrap();
    let before = m.stats();
    for other in [
        session(&f, &json!({"principal":"other"})),
        session(&f, &json!({"epoch":"other"})),
    ] {
        assert!(matches!(
            m.reserve_next_workflow(&other, &t, SimulatedRunQualification::Running, q.clone()),
            Err(ModelError::Forbidden)
        ));
        assert_eq!(m.stats(), before);
    }
}
#[test]
fn sequence_exhaustion_does_not_switch_current_or_joined_history_or_projection() {
    let (mut m, s, f, t) = predecessor(Default::default(), SimulatedRunQualification::Running);
    m.sequence = u64::MAX;
    let before = m.stats();
    let snapshot = m.owner_snapshot(&s).unwrap();
    let budget = projection(&m);
    assert!(matches!(
        m.reserve_next_workflow(
            &s,
            &t,
            SimulatedRunQualification::CleanJoined,
            change(&f, "next")
        ),
        Err(ModelError::Capacity)
    ));
    assert_eq!(m.stats(), before);
    assert_eq!(m.owner_snapshot(&s).unwrap(), snapshot);
    assert_eq!(projection(&m), budget);
    assert_eq!(m.sequence, u64::MAX);
}
#[test]
fn larger_future_projection_fails_atomically_and_exact_cumulative_bound_is_accepted() {
    let (mut probe, s, f, t) = predecessor(Default::default(), SimulatedRunQualification::Running);
    let first = probe.projection_bound(probe.projection.budget).unwrap();
    let mut q = change(&f, "next").as_value().clone();
    q["apply"]["requestId"] = json!("x".repeat(64));
    let q = RecordingChangeRequest::from_value(q).unwrap();
    probe
        .reserve_next_workflow(&s, &t, SimulatedRunQualification::Running, q.clone())
        .unwrap();
    let both = probe.projection_bound(probe.projection.budget).unwrap();
    assert!(both.bytes > first.bytes);
    for cap in [
        both,
        WireBound {
            bytes: both.bytes - 1,
            ..both
        },
    ] {
        let (mut m, s, _, t) = predecessor(
            ModelLimits {
                projection_limit: cap,
                ..Default::default()
            },
            SimulatedRunQualification::Running,
        );
        let before = m.stats();
        let old = projection(&m);
        let snapshot = m.owner_snapshot(&s).unwrap();
        let result = m.reserve_next_workflow(&s, &t, SimulatedRunQualification::Running, q.clone());
        if cap == both {
            assert!(result.is_ok());
            assert_eq!(m.stats().workflow_changes, 2);
        } else {
            assert!(matches!(result, Err(ModelError::Capacity)));
            assert_eq!(m.stats(), before);
            assert_eq!(projection(&m), old);
            assert_eq!(m.owner_snapshot(&s).unwrap(), snapshot);
        }
    }
}
#[test]
fn all_cumulative_identity_pools_accept_exact_and_reject_one_below() {
    for (resource, exact) in [
        ("changes", 2),
        ("admissions", 6),
        ("leases", 6),
        ("native", 6),
    ] {
        for n in [exact, exact - 1] {
            let mut l = ModelLimits::default();
            match resource {
                "changes" => l.workflow_changes = n,
                "admissions" => l.mutation_admissions = n,
                "leases" => l.mutation_leases = n,
                "native" => l.simulated_native_identities = n,
                _ => unreachable!(),
            };
            let (mut m, s, f, t) = predecessor(l, SimulatedRunQualification::Running);
            let before = m.stats();
            let result = m.reserve_next_workflow(
                &s,
                &t,
                SimulatedRunQualification::Running,
                change(&f, "next"),
            );
            if n == exact {
                assert!(result.is_ok(), "{resource}")
            } else {
                assert!(matches!(result, Err(ModelError::Capacity)), "{resource}");
                assert_eq!(m.stats(), before);
            }
        }
    }
}
#[test]
fn same_change_retry_cannot_change_creation_or_predecessor_and_never_reopens_current() {
    let (mut m, s, f, t) = predecessor(Default::default(), SimulatedRunQualification::Running);
    let q = change(&f, "next");
    let next = m
        .reserve_next_workflow(&s, &t, SimulatedRunQualification::Running, q.clone())
        .unwrap();
    let before = m.stats();
    assert!(matches!(
        m.reserve_workflow(&s, q.clone()),
        Err(ModelError::ProtocolViolation)
    ));
    assert!(matches!(
        m.reserve_next_workflow(&s, &next, SimulatedRunQualification::Running, q.clone()),
        Err(ModelError::ProtocolViolation)
    ));
    assert_eq!(m.stats(), before);
    let replay = m
        .reserve_next_workflow(&s, &t, SimulatedRunQualification::Running, q)
        .unwrap();
    assert_eq!(replay.sequence, next.sequence);
    assert_eq!(m.stats(), before);
    previous::reserve(&mut m, &s, &f);
    assert_eq!(m.stats(), before);
}
#[test]
fn initial_joined_declaration_is_sticky_before_any_stage_has_run() {
    let (mut m, s, f, t) = predecessor(Default::default(), SimulatedRunQualification::CleanJoined);
    let before = m.stats();
    assert!(before.ever_clean_joined);
    assert!(matches!(
        m.reserve_next_workflow(
            &s,
            &t,
            SimulatedRunQualification::Running,
            change(&f, "next")
        ),
        Err(ModelError::Forbidden)
    ));
    assert_eq!(m.stats(), before);
    assert!(m
        .reserve_next_workflow(
            &s,
            &t,
            SimulatedRunQualification::CleanJoined,
            change(&f, "next")
        )
        .is_ok());
}
#[test]
fn retired_ticket_cannot_use_a_fresh_current_lease_but_keeps_its_own_exact_replay() {
    let (mut m, s, f, t) = predecessor(Default::default(), SimulatedRunQualification::Running);
    let next = m
        .reserve_next_workflow(
            &s,
            &t,
            SimulatedRunQualification::Running,
            change(&f, "next"),
        )
        .unwrap();
    let lease=RecordingWireLeaseRequest::from_value(json!({"version":1,"kind":"recordingWireLeaseRequest","scope":s.scope(),"leaseRequestId":"fresh","admissionId":"fresh","role":"mutation","requestedBudgetMs":10})).unwrap();
    let r = m
        .issue_workflow_lease(&next, WorkflowAction::Preflight, Default::default(), lease)
        .unwrap();
    let q=RecordingAdmissionRequest::from_value(json!({"version":1,"kind":"recordingAdmissionRequest","ownerRef":s.scope()["ownerRef"],"context":s.scope()["context"],"admissionId":"fresh","deadlineLeaseRef":r.as_value()["outcome"]["deadlineLeaseRef"],"action":{"kind":"preflight","change":change(&f,"next").as_value()}})).unwrap();
    let before = m.stats();
    assert!(matches!(
        m.begin_workflow_admission(&t, q.clone()),
        Err(ModelError::Busy)
    ));
    assert_eq!(m.stats(), before);
    assert!(matches!(
        m.begin_workflow_admission(&next, q),
        Ok(AdmissionStart::Registered { .. })
    ));
    let before = m.stats();
    assert!(matches!(
        m.begin_workflow_admission(
            &t,
            RecordingAdmissionRequest::from_value(f["bases"]["pAdmit"].clone()).unwrap()
        ),
        Ok(AdmissionStart::Replay { .. })
    ));
    assert_eq!(m.stats(), before);
}
#[test]
fn old_proof_and_completion_replays_cannot_overwrite_a_new_workflow_snapshot() {
    let (mut m, s, f, t) = predecessor(Default::default(), SimulatedRunQualification::Running);
    let id = f["bases"]["pAdmit"]["admissionId"].as_str().unwrap();
    let old = m.ticket(id, m.admissions[id].sequence);
    let handle = m.accepted_handle(&old).unwrap();
    m.reserve_next_workflow(
        &s,
        &t,
        SimulatedRunQualification::Running,
        change(&f, "next"),
    )
    .unwrap();
    let before = m.stats();
    let snapshot = m.owner_snapshot(&s).unwrap();
    m.observe_native(
        &old,
        SimulatedDecision::Accepted(
            RecordingAdmissionReply::from_value(f["bases"]["pAccepted"].clone()).unwrap(),
        ),
    )
    .unwrap();
    m.complete_handle(
        &handle,
        SimulatedCompletion::Operation(
            scada_model::recording_operations::RecordingOperationResult::from_value(
                f["bases"]["pResult"].clone(),
            )
            .unwrap(),
        ),
    )
    .unwrap();
    assert_eq!(m.stats(), before);
    assert_eq!(m.owner_snapshot(&s).unwrap(), snapshot);
}
#[test]
fn standalone_mode_does_not_acquire_a_renewal_authority() {
    let (mut m, s, _) = initial();
    let (other, _, f, t) = predecessor(Default::default(), SimulatedRunQualification::Running);
    let before = m.stats();
    assert!(matches!(
        m.reserve_next_workflow(
            &s,
            &t,
            SimulatedRunQualification::Running,
            change(&f, "next")
        ),
        Err(ModelError::Forbidden)
    ));
    assert_eq!(m.stats(), before);
    assert_eq!(other.stats().workflow_changes, 1);
}
