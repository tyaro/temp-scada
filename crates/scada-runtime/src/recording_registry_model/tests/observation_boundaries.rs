use super::*;
fn observation_fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../examples/recording-observation-model-cases.json"
    ))
    .unwrap()
}
fn operation_model() -> (
    RegistryModel,
    ModelSession,
    Value,
    SimulationTicket,
    SimulatedHandleTicket,
) {
    let f = observation_fixtures();
    let s = session(&f, &Value::Null);
    let mut m = RegistryModel::new(s.clone(), Default::default()).unwrap();
    m.issue_lease(
        &s,
        RecordingWireLeaseRequest::from_value(f["bases"]["opLease"].clone()).unwrap(),
    )
    .unwrap();
    let t = match m
        .begin_admission(
            &s,
            RecordingAdmissionRequest::from_value(f["bases"]["opAdmit"].clone()).unwrap(),
        )
        .unwrap()
    {
        AdmissionStart::Registered { ticket } => ticket,
        _ => panic!("register"),
    };
    m.observe_native(
        &t,
        SimulatedDecision::Accepted(
            RecordingAdmissionReply::from_value(f["bases"]["opAdmitAccepted"].clone()).unwrap(),
        ),
    )
    .unwrap();
    let h = m.accepted_handle(&t).unwrap();
    (m, s, f, t, h)
}
fn result(f: &Value) -> SimulatedCompletion {
    SimulatedCompletion::Operation(
        scada_model::recording_operations::RecordingOperationResult::from_value(
            f["bases"]["opResult"].clone(),
        )
        .unwrap(),
    )
}
#[test]
fn opaque_handle_tickets_cannot_cross_models_with_identical_json_refs() {
    let (a, _, f, _, ha) = operation_model();
    let (mut b, _, _, _, hb) = operation_model();
    let before = b.stats();
    assert_eq!(
        b.complete_handle(&ha, result(&f)),
        Err(ModelError::Forbidden)
    );
    assert_eq!(b.stats(), before);
    b.complete_handle(&hb, result(&f)).unwrap();
    assert_eq!(b.stats().completed_handles, 1);
    assert_eq!(a.stats().completed_handles, 0);
}
#[test]
fn tampered_model_handle_metadata_is_rejected_without_side_effects() {
    let (mut m, _, f, _, h) = operation_model();
    for bad in [
        SimulatedHandleTicket {
            sequence: h.sequence + 1,
            ..h.clone()
        },
        SimulatedHandleTicket {
            key: (Role::Read, h.key.1.clone()),
            ..h.clone()
        },
        SimulatedHandleTicket {
            admission_id: "other".into(),
            ..h.clone()
        },
    ] {
        let before = m.stats();
        assert_eq!(
            m.complete_handle(&bad, result(&f)),
            Err(ModelError::InvalidInput)
        );
        assert_eq!(m.stats(), before);
    }
    m.complete_handle(&h, result(&f)).unwrap();
}
#[test]
fn observation_limits_can_only_shrink_adopted_caps() {
    let (_, s, _) = initial();
    for l in [
        ModelLimits {
            operation_observations: 4097,
            ..Default::default()
        },
        ModelLimits {
            read_observations: 4097,
            ..Default::default()
        },
        ModelLimits {
            pending_operation_observations: 3,
            ..Default::default()
        },
        ModelLimits {
            pending_read_observations: 3,
            ..Default::default()
        },
    ] {
        assert!(matches!(
            RegistryModel::new(s.clone(), l),
            Err(ModelError::InvalidInput)
        ));
    }
}
#[test]
fn reference_collision_rejection_preserves_existing_owner_and_proof() {
    // Direct defensive registration guard: current public workflow/byte gates already
    // prevent a second same-kind accepted handle. No phase progression is enabled here.
    let (mut m, _, f, t, h) = operation_model();
    let before = m.stats();
    let mut other = t.clone();
    other.admission_id = "different-admission".into();
    other.sequence += 1;
    let reply = RecordingAdmissionReply::from_value(f["bases"]["opAdmitAccepted"].clone()).unwrap();
    assert_eq!(
        m.register_handle(&other, &reply),
        Err(ModelError::ProtocolViolation)
    );
    assert_eq!(m.stats(), before);
    assert_eq!(m.accepted_handle(&t).unwrap().sequence, h.sequence);
    m.complete_handle(&h, result(&f)).unwrap();
}
#[test]
fn pending_and_replayed_observation_do_not_reexecute_or_recharge() {
    let (mut m, s, f, _, h) = operation_model();
    let q = RecordingWireObservationRequest::from_value(f["bases"]["observe"].clone()).unwrap();
    m.observe_result(&s, q.clone()).unwrap();
    let pending = m.stats();
    m.observe_result(&s, q.clone()).unwrap();
    assert_eq!(m.stats(), pending);
    m.complete_handle(&h, result(&f)).unwrap();
    assert_eq!(m.stats().pending_operation_observations, 1);
    m.observe_result(&s, q.clone()).unwrap();
    let terminal = m.stats();
    assert_eq!(terminal.pending_operation_observations, 0);
    m.observe_result(&s, q).unwrap();
    m.complete_handle(&h, result(&f)).unwrap();
    assert_eq!(m.stats(), terminal);
}
