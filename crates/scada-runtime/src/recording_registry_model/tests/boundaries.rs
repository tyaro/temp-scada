use super::*;
#[test]
fn tickets_are_bound_to_model_instance_even_with_identical_scope() {
    let (mut a, s, f) = initial();
    let (mut b, _, _) = initial();
    let ta = start(&mut a, &s, &f);
    let tb = start(&mut b, &s, &f);
    let r = RecordingAdmissionReply::from_value(f["bases"]["accepted"].clone()).unwrap();
    let stats = b.stats();
    assert_eq!(
        b.observe_native(&ta, SimulatedDecision::Accepted(r.clone())),
        Err(ModelError::Forbidden)
    );
    assert_eq!(
        b.finish_admission_call(&ta, r.clone()),
        Err(ModelError::Forbidden)
    );
    assert_eq!(b.stats(), stats);
    b.observe_native(&tb, SimulatedDecision::Accepted(r))
        .unwrap();
}
#[test]
fn all_limits_may_only_shrink_and_invalid_constructor_is_rejected() {
    let (_, s, _) = initial();
    for limits in [
        ModelLimits {
            mutation_admissions: 4097,
            ..Default::default()
        },
        ModelLimits {
            read_admissions: 4097,
            ..Default::default()
        },
        ModelLimits {
            mutation_leases: 4097,
            ..Default::default()
        },
        ModelLimits {
            read_leases: 4097,
            ..Default::default()
        },
        ModelLimits {
            admission_inspections: 4097,
            ..Default::default()
        },
        ModelLimits {
            call_inspections: 4097,
            ..Default::default()
        },
        ModelLimits {
            unconsumed_leases: 5,
            ..Default::default()
        },
        ModelLimits {
            total_bytes: 8 * 1024 * 1024 + 1,
            ..Default::default()
        },
        ModelLimits {
            read_bytes: 2 * 1024 * 1024 + 1,
            ..Default::default()
        },
        ModelLimits {
            total_bytes: 0,
            ..Default::default()
        },
    ] {
        assert!(matches!(
            RegistryModel::new(s.clone(), limits),
            Err(ModelError::InvalidInput)
        ));
    }
    assert!(SimulatedPrincipal::new("bad\n").is_err());
    assert!(SimulatedPrincipal::new("").is_err());
    assert!(SimulatedPrincipal::new(&"a".repeat(65)).is_err());
    assert!(ModelSession::new(json!({}), SimulatedPrincipal::new("p").unwrap()).is_err());
}
#[test]
fn four_unused_leases_per_role_and_expiry_does_not_release_ids() {
    let (mut m, s, f) = initial();
    for n in 0..4 {
        let mut q = f["bases"]["lease"].clone();
        q["leaseRequestId"] = json!(format!("lease:{n}"));
        q["admissionId"] = json!(format!("admission:{n}"));
        m.issue_lease(&s, RecordingWireLeaseRequest::from_value(q).unwrap())
            .unwrap();
    }
    let mut q = f["bases"]["lease"].clone();
    q["leaseRequestId"] = json!("fifth");
    q["admissionId"] = json!("fifth");
    let q = RecordingWireLeaseRequest::from_value(q).unwrap();
    let before = m.stats();
    assert!(matches!(
        m.issue_lease(&s, q.clone()),
        Err(ModelError::Capacity)
    ));
    assert_eq!(m.stats(), before);
    let read = RecordingWireLeaseRequest::from_value(f["bases"]["readLease"].clone()).unwrap();
    m.issue_lease(&s, read).unwrap();
    m.advance_to(ModelInstant(10)).unwrap();
    m.issue_lease(&s, q).unwrap();
    assert_eq!(m.stats().mutation_leases, 5);
}
#[test]
fn failed_registration_does_not_consume_lease_or_sequence() {
    let (mut m, s, f) = initial();
    m.issue_lease(
        &s,
        RecordingWireLeaseRequest::from_value(f["bases"]["lease"].clone()).unwrap(),
    )
    .unwrap();
    m.limits.mutation_admissions = 0;
    let q = RecordingAdmissionRequest::from_value(f["bases"]["admit"].clone()).unwrap();
    let seq = m.sequence;
    assert!(matches!(
        m.begin_admission(&s, q.clone()),
        Err(ModelError::Capacity)
    ));
    assert_eq!(m.sequence, seq);
    assert!(!m.leases.values().next().unwrap().consumed);
    m.limits.mutation_admissions = 1;
    assert!(matches!(
        m.begin_admission(&s, q),
        Ok(AdmissionStart::Registered { .. })
    ));
}
#[test]
fn checked_sequence_exhaustion_is_atomic() {
    let (mut m, s, f) = initial();
    m.sequence = u64::MAX;
    let before = m.stats();
    assert!(matches!(
        m.issue_lease(
            &s,
            RecordingWireLeaseRequest::from_value(f["bases"]["lease"].clone()).unwrap()
        ),
        Err(ModelError::Capacity)
    ));
    assert_eq!(m.stats(), before);
    let (mut m, s, f) = initial();
    m.issue_lease(
        &s,
        RecordingWireLeaseRequest::from_value(f["bases"]["lease"].clone()).unwrap(),
    )
    .unwrap();
    m.sequence = u64::MAX;
    let before = m.stats();
    assert!(matches!(
        m.begin_admission(
            &s,
            RecordingAdmissionRequest::from_value(f["bases"]["admit"].clone()).unwrap()
        ),
        Err(ModelError::Capacity)
    ));
    assert_eq!(m.stats(), before);
    assert!(!m.leases.values().next().unwrap().consumed);
}
#[test]
fn safe_integer_spelling_in_proof_and_terminal_is_semantically_equal() {
    let (mut m, s, f) = initial();
    let t = start(&mut m, &s, &f);
    let r = RecordingAdmissionReply::from_value(f["bases"]["accepted"].clone()).unwrap();
    m.observe_native(&t, SimulatedDecision::Accepted(r.clone()))
        .unwrap();
    m.finish_admission_call(&t, r.clone()).unwrap();
    let mut other = r.as_value().clone();
    other["request"]["context"]["target"]["projectRevision"] = json!(2.0);
    let other = RecordingAdmissionReply::from_value(other).unwrap();
    m.observe_native(&t, SimulatedDecision::Accepted(other.clone()))
        .unwrap();
    m.finish_admission_call(&t, other).unwrap();
}
#[test]
fn member_order_is_not_full_request_equality() {
    let (mut m, s, f) = initial();
    let _ = start(&mut m, &s, &f);
    let mut q = f["bases"]["admit"].clone();
    q["action"]["change"]["apply"]["desired"]["group"]["members"]
        .as_array_mut()
        .unwrap()
        .reverse();
    let stats = m.stats();
    assert!(matches!(
        m.begin_admission(&s, RecordingAdmissionRequest::from_value(q).unwrap()),
        Err(ModelError::ProtocolViolation)
    ));
    assert_eq!(m.stats(), stats);
}
#[test]
fn read_and_mutation_share_admission_identity_namespace() {
    let (mut m, s, f) = initial();
    let t = start(&mut m, &s, &f);
    m.finish_admission_call(
        &t,
        RecordingAdmissionReply::from_value(f["bases"]["unknown"].clone()).unwrap(),
    )
    .unwrap();
    let q = RecordingAdmissionRequest::from_value(f["bases"]["readWrongRole"].clone()).unwrap();
    assert!(matches!(
        m.begin_admission(&s, q),
        Err(ModelError::ProtocolViolation)
    ));
}
#[test]
fn errors_in_known_inspection_original_do_not_poison_binding() {
    let (mut m, s, f) = initial();
    let _ = start(&mut m, &s, &f);
    let mut bad = f["bases"]["call"].clone();
    bad["original"]["deadlineLeaseRef"] = json!("other");
    assert!(matches!(
        m.inspect_call(
            &s,
            RecordingWireCallInspectionRequest::from_value(bad).unwrap()
        ),
        Err(ModelError::ProtocolViolation)
    ));
    assert_eq!(m.stats().call_inspections, 0);
    let good = RecordingWireCallInspectionRequest::from_value(f["bases"]["call"].clone()).unwrap();
    assert!(m.inspect_call(&s, good).is_ok());
}

#[test]
fn raw_session_scope_is_bounded_before_building_validation_envelope() {
    for scope in [
        (0..65).fold(Value::Null, |v, _| json!([v])),
        json!("x".repeat(256 * 1024)),
        json!(vec![Value::Null; 8192]),
    ] {
        assert!(matches!(
            ModelSession::new(scope, SimulatedPrincipal::new("p").unwrap()),
            Err(ModelError::InvalidInput)
        ));
    }
}
#[test]
fn reduced_admission_and_lease_id_caps_preserve_existing_replay() {
    let (mut m, s, f) = initial();
    m.limits.mutation_admissions = 1;
    let t = start(&mut m, &s, &f);
    let rejected = RecordingAdmissionReply::from_value(f["bases"]["rejected"].clone()).unwrap();
    m.observe_native(&t, SimulatedDecision::Rejected(rejected.clone()))
        .unwrap();
    m.finish_admission_call(&t, rejected).unwrap();
    m.issue_lease(
        &s,
        RecordingWireLeaseRequest::from_value(f["bases"]["nextLease"].clone()).unwrap(),
    )
    .unwrap();
    let next = RecordingAdmissionRequest::from_value(f["bases"]["nextAdmit"].clone()).unwrap();
    assert!(matches!(
        m.begin_admission(&s, next),
        Err(ModelError::Capacity)
    ));
    assert!(matches!(
        m.begin_admission(
            &s,
            RecordingAdmissionRequest::from_value(f["bases"]["admit"].clone()).unwrap()
        ),
        Ok(AdmissionStart::Replay { .. })
    ));
    for role in [Role::Mutation, Role::Read] {
        let (mut m, s, f) = initial();
        match role {
            Role::Mutation => m.limits.mutation_leases = 1,
            Role::Read => m.limits.read_leases = 1,
        };
        let mut first = f["bases"]["lease"].clone();
        if role == Role::Read {
            first["role"] = json!("reconciliation");
        }
        m.issue_lease(
            &s,
            RecordingWireLeaseRequest::from_value(first.clone()).unwrap(),
        )
        .unwrap();
        m.advance_to(ModelInstant(10)).unwrap();
        let mut second = first.clone();
        second["leaseRequestId"] = json!("new");
        second["admissionId"] = json!("new");
        assert!(matches!(
            m.issue_lease(&s, RecordingWireLeaseRequest::from_value(second).unwrap()),
            Err(ModelError::Capacity)
        ));
        assert!(m
            .issue_lease(&s, RecordingWireLeaseRequest::from_value(first).unwrap())
            .is_ok());
    }
}
#[test]
fn reduced_read_admission_id_cap_is_separate_and_retains_knowledge() {
    let (mut m, s, f) = initial();
    m.limits.read_admissions = 1;
    let mut lease = f["bases"]["readLease"].clone();
    m.issue_lease(
        &s,
        RecordingWireLeaseRequest::from_value(lease.clone()).unwrap(),
    )
    .unwrap();
    let request =
        RecordingAdmissionRequest::from_value(f["bases"]["readAdmitFirst"].clone()).unwrap();
    let ticket = match m.begin_admission(&s, request.clone()).unwrap() {
        AdmissionStart::Registered { ticket } => ticket,
        _ => panic!("register"),
    };
    let rejected=RecordingAdmissionReply::from_value(json!({"version":1,"kind":"recordingAdmissionReply","request":request.as_value(),"outcome":{"kind":"rejected","error":"busy"}})).unwrap();
    m.observe_native(&ticket, SimulatedDecision::Rejected(rejected.clone()))
        .unwrap();
    m.finish_admission_call(&ticket, rejected).unwrap();
    lease["leaseRequestId"] = json!("another-read");
    lease["admissionId"] = json!("another-read");
    m.issue_lease(&s, RecordingWireLeaseRequest::from_value(lease).unwrap())
        .unwrap();
    let mut next = request.as_value().clone();
    next["admissionId"] = json!("another-read");
    next["deadlineLeaseRef"] = json!("model-lease:3");
    assert!(matches!(
        m.begin_admission(&s, RecordingAdmissionRequest::from_value(next).unwrap()),
        Err(ModelError::Capacity)
    ));
    assert!(matches!(
        m.begin_admission(&s, request),
        Ok(AdmissionStart::Replay { .. })
    ));
}
