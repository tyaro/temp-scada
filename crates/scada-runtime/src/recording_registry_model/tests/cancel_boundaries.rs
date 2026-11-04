use super::*;
fn cancel_fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../examples/recording-cancel-model-cases.json"
    ))
    .unwrap()
}
fn known_cancel() -> (RegistryModel, ModelSession, Value, ModelCancelTicket) {
    let (mut m, s, old) = initial();
    let t = start(&mut m, &s, &old);
    m.observe_native(
        &t,
        SimulatedDecision::Accepted(
            RecordingAdmissionReply::from_value(old["bases"]["accepted"].clone()).unwrap(),
        ),
    )
    .unwrap();
    let f = cancel_fixtures();
    let ticket = match m
        .begin_cancel(
            &s,
            RecordingWireCancelRequest::from_value(f["bases"]["cancel"].clone()).unwrap(),
        )
        .unwrap()
    {
        CancelStart::Registered { ticket } => ticket,
        _ => panic!("register"),
    };
    (m, s, f, ticket)
}
#[test]
fn cancel_tickets_are_bound_to_model_instance_with_identical_wire_identity() {
    let (a, _, _, ta) = known_cancel();
    let (mut b, _, _, tb) = known_cancel();
    let before = b.stats();
    assert_eq!(b.notify_cancel(&ta), Err(ModelError::Forbidden));
    assert_eq!(b.finish_cancel_call(&ta), Err(ModelError::Forbidden));
    assert_eq!(b.stats(), before);
    b.notify_cancel(&tb).unwrap();
    b.finish_cancel_call(&tb).unwrap();
    assert_eq!(b.stats().cancel_notified_handles, 1);
    assert_eq!(a.stats().cancel_notified_handles, 0);
}
#[test]
fn invalid_cancel_sequence_and_id_cannot_notify_or_finish() {
    let (mut m, _, _, t) = known_cancel();
    for bad in [
        ModelCancelTicket {
            sequence: t.sequence + 1,
            ..t.clone()
        },
        ModelCancelTicket {
            cancel_id: "missing".into(),
            ..t.clone()
        },
    ] {
        let before = m.stats();
        assert_eq!(m.notify_cancel(&bad), Err(ModelError::InvalidInput));
        assert_eq!(m.finish_cancel_call(&bad), Err(ModelError::InvalidInput));
        assert_eq!(m.stats(), before);
    }
    m.notify_cancel(&t).unwrap();
    m.finish_cancel_call(&t).unwrap();
}
#[test]
fn cancel_limits_can_only_shrink_and_sequence_overflow_is_atomic() {
    let (_, s, _) = initial();
    for l in [
        ModelLimits {
            cancel_requests: 4097,
            ..Default::default()
        },
        ModelLimits {
            pending_cancel_calls: 2,
            ..Default::default()
        },
    ] {
        assert!(matches!(
            RegistryModel::new(s.clone(), l),
            Err(ModelError::InvalidInput)
        ));
    }
    let (mut m, s, _) = initial();
    m.sequence = u64::MAX;
    let q = RecordingWireCancelRequest::from_value(cancel_fixtures()["bases"]["cancel"].clone())
        .unwrap();
    let before = m.stats();
    assert!(matches!(m.begin_cancel(&s, q), Err(ModelError::Capacity)));
    assert_eq!(m.stats(), before);
    assert_eq!(m.sequence, u64::MAX);
    assert!(m.leases.is_empty());
}
#[test]
fn rejected_cancel_registration_preserves_ids_sequence_and_notification_qualification() {
    let (mut m, s, old) = initial();
    let t = start(&mut m, &s, &old);
    m.observe_native(
        &t,
        SimulatedDecision::Accepted(
            RecordingAdmissionReply::from_value(old["bases"]["accepted"].clone()).unwrap(),
        ),
    )
    .unwrap();
    let q = RecordingWireCancelRequest::from_value(cancel_fixtures()["bases"]["cancel"].clone())
        .unwrap();
    let sequence = m.sequence;
    let before = m.stats();
    m.limits.cancel_requests = 0;
    assert!(matches!(
        m.begin_cancel(&s, q.clone()),
        Err(ModelError::Capacity)
    ));
    assert_eq!(m.sequence, sequence);
    assert_eq!(m.stats(), before);
    m.limits.cancel_requests = 4096;
    let t = match m.begin_cancel(&s, q).unwrap() {
        CancelStart::Registered { ticket } => ticket,
        _ => panic!("register"),
    };
    assert_eq!(t.sequence, sequence + 1);
    let next =
        RecordingWireCancelRequest::from_value(cancel_fixtures()["bases"]["cancel2"].clone())
            .unwrap();
    let sequence = m.sequence;
    assert!(matches!(
        m.begin_cancel(&s, next.clone()),
        Err(ModelError::Busy)
    ));
    assert_eq!(m.sequence, sequence);
    m.notify_cancel(&t).unwrap();
    assert!(matches!(
        m.begin_cancel(&s, next.clone()),
        Err(ModelError::Busy)
    ));
    m.finish_cancel_call(&t).unwrap();
    assert!(matches!(
        m.begin_cancel(&s, next),
        Ok(CancelStart::Registered { .. })
    ));
}
#[test]
fn cancel_changes_only_notification_and_own_dispatcher_axes() {
    let (mut m, s, _, t) = known_cancel();
    let accepted = m
        .admissions
        .values()
        .next()
        .unwrap()
        .proof
        .as_ref()
        .unwrap()
        .as_value();
    let observe=RecordingWireObservationRequest::from_value(json!({"version":1,"kind":"recordingWireObservationRequest","scope":s.scope(),"observationId":"before-cancel","target":{"kind":"operation","operationRef":accepted["outcome"]["handle"]["operationRef"],"request":accepted["outcome"]["handle"]["request"]}})).unwrap();
    m.observe_result(&s, observe).unwrap();
    let mut expected = m.stats();
    assert!(expected.pending_dispatcher);
    assert_eq!(expected.pending_operation_observations, 1);
    expected.cancel_notified_handles = 1;
    m.notify_cancel(&t).unwrap();
    assert_eq!(m.stats(), expected);
    m.notify_cancel(&t).unwrap();
    assert_eq!(m.stats(), expected);
    expected.pending_cancel_calls = 0;
    m.finish_cancel_call(&t).unwrap();
    assert_eq!(m.stats(), expected);
    m.finish_cancel_call(&t).unwrap();
    assert_eq!(m.stats(), expected);
}
