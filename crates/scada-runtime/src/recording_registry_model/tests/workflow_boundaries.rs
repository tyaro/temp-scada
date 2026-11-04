use super::*;
use scada_model::recording_operations::RecordingChangeRequest;
fn data() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../examples/recording-workflow-model-cases.json"
    ))
    .unwrap()
}
fn model(limits: ModelLimits) -> (RegistryModel, ModelSession, Value) {
    let f = data();
    let s = session(&f, &Value::Null);
    (
        RegistryModel::new_workflow(s.clone(), limits, SimulatedRunQualification::Running).unwrap(),
        s,
        f,
    )
}
fn reserve(m: &mut RegistryModel, s: &ModelSession, f: &Value) -> WorkflowTicket {
    m.reserve_workflow(
        s,
        RecordingChangeRequest::from_value(f["bases"]["change"].clone()).unwrap(),
    )
    .unwrap()
}
fn issue(m: &mut RegistryModel, t: &WorkflowTicket, f: &Value, k: &str) -> RecordingWireLeaseReply {
    let q = &f["bases"][format!("{k}Admit")];
    let a = WorkflowAction::from_value(&q["action"]["kind"]).unwrap();
    m.issue_workflow_lease(
        t,
        a,
        WorkflowAttemptIds {
            operation_id: q["action"]["operation"]["operationId"]
                .as_str()
                .map(str::to_owned),
        },
        RecordingWireLeaseRequest::from_value(f["bases"][format!("{k}Lease")].clone()).unwrap(),
    )
    .unwrap()
}
fn begin(m: &mut RegistryModel, t: &WorkflowTicket, f: &Value, k: &str) -> SimulationTicket {
    match m
        .begin_workflow_admission(
            t,
            RecordingAdmissionRequest::from_value(f["bases"][format!("{k}Admit")].clone()).unwrap(),
        )
        .unwrap()
    {
        AdmissionStart::Registered { ticket } => ticket,
        _ => panic!("registered"),
    }
}
fn finish_stage(m: &mut RegistryModel, t: &WorkflowTicket, f: &Value, k: &str) {
    issue(m, t, f, k);
    let a = begin(m, t, f, k);
    let p =
        RecordingAdmissionReply::from_value(f["bases"][format!("{k}Accepted")].clone()).unwrap();
    m.observe_native(&a, SimulatedDecision::Accepted(p.clone()))
        .unwrap();
    let h = m.accepted_handle(&a).unwrap();
    m.complete_handle(
        &h,
        SimulatedCompletion::Operation(
            scada_model::recording_operations::RecordingOperationResult::from_value(
                f["bases"][format!("{k}Result")].clone(),
            )
            .unwrap(),
        ),
    )
    .unwrap();
    m.finish_admission_call(&a, p).unwrap();
}
#[test]
fn workflow_capability_is_instance_bound_and_cannot_change_sequence_or_change() {
    let (mut a, s, f) = model(Default::default());
    let t = reserve(&mut a, &s, &f);
    let (mut b, sb, fb) = model(Default::default());
    let _ = reserve(&mut b, &sb, &fb);
    for bad in [
        t.clone(),
        WorkflowTicket {
            identity: b.identity.clone(),
            sequence: t.sequence + 1,
            change_id: t.change_id.clone(),
        },
        WorkflowTicket {
            identity: b.identity.clone(),
            sequence: t.sequence,
            change_id: "other".into(),
        },
    ] {
        let before = b.stats();
        let err = b
            .issue_workflow_lease(
                &bad,
                WorkflowAction::Preflight,
                Default::default(),
                RecordingWireLeaseRequest::from_value(f["bases"]["pLease"].clone()).unwrap(),
            )
            .unwrap_err();
        assert!(matches!(
            err,
            ModelError::Forbidden | ModelError::InvalidInput
        ));
        assert_eq!(b.stats(), before);
    }
}
#[test]
fn all_new_pool_limits_only_shrink() {
    let (_, s, _) = model(Default::default());
    for l in [
        ModelLimits {
            workflow_changes: 4097,
            ..Default::default()
        },
        ModelLimits {
            caller_operation_ids: 4097,
            ..Default::default()
        },
        ModelLimits {
            simulated_native_identities: 4097,
            ..Default::default()
        },
        ModelLimits {
            reconciliation_ids: 4097,
            ..Default::default()
        },
    ] {
        assert!(matches!(
            RegistryModel::new_workflow(s.clone(), l, SimulatedRunQualification::Running),
            Err(ModelError::InvalidInput)
        ));
    }
}
#[test]
fn whole_workflow_projection_exact_and_one_below_are_atomic_in_three_dimensions() {
    let (mut m, s, f) = model(Default::default());
    reserve(&mut m, &s, &f);
    let b = m.projection_bound(m.projection.budget).unwrap();
    for cap in [
        b,
        WireBound {
            bytes: b.bytes - 1,
            ..b
        },
        WireBound {
            nodes: b.nodes - 1,
            ..b
        },
        WireBound {
            depth: b.depth - 1,
            ..b
        },
    ] {
        let (mut m, s, f) = model(ModelLimits {
            projection_limit: cap,
            ..Default::default()
        });
        let old = m.stats();
        let seq = m.sequence;
        let r = m.reserve_workflow(
            &s,
            RecordingChangeRequest::from_value(f["bases"]["change"].clone()).unwrap(),
        );
        if cap == b {
            assert!(r.is_ok());
        } else {
            assert!(matches!(r, Err(ModelError::Capacity)));
            assert_eq!(m.stats(), old);
            assert_eq!(m.sequence, seq);
        }
    }
}
#[test]
fn reservation_sequence_exhaustion_is_atomic() {
    let (mut m, s, f) = model(Default::default());
    m.sequence = u64::MAX;
    let old = m.stats();
    assert!(matches!(
        m.reserve_workflow(
            &s,
            RecordingChangeRequest::from_value(f["bases"]["change"].clone()).unwrap()
        ),
        Err(ModelError::Capacity)
    ));
    assert_eq!(m.stats(), old);
}
#[test]
fn failed_lease_plan_cannot_bind_ids_or_spend_future_bytes() {
    let (mut m, s, f) = model(Default::default());
    let t = reserve(&mut m, &s, &f);
    m.sequence = u64::MAX;
    let before = m.stats();
    assert!(matches!(
        m.issue_workflow_lease(
            &t,
            WorkflowAction::Preflight,
            Default::default(),
            RecordingWireLeaseRequest::from_value(f["bases"]["pLease"].clone()).unwrap()
        ),
        Err(ModelError::Capacity)
    ));
    assert_eq!(m.stats(), before);
    m.sequence = 1;
    m.advance_to(ModelInstant(u64::MAX)).unwrap();
    let before = m.stats();
    assert!(matches!(
        m.issue_workflow_lease(
            &t,
            WorkflowAction::Preflight,
            Default::default(),
            RecordingWireLeaseRequest::from_value(f["bases"]["pLease"].clone()).unwrap()
        ),
        Err(ModelError::InvalidInput)
    ));
    assert_eq!(m.stats(), before);
}
#[test]
fn failed_begin_keeps_previously_bound_ids_used_and_lease_unconsumed() {
    let (mut m, s, f) = model(Default::default());
    let t = reserve(&mut m, &s, &f);
    issue(&mut m, &t, &f, "p");
    m.sequence = u64::MAX;
    let before = m.stats();
    assert!(matches!(
        m.begin_workflow_admission(
            &t,
            RecordingAdmissionRequest::from_value(f["bases"]["pAdmit"].clone()).unwrap()
        ),
        Err(ModelError::Capacity)
    ));
    assert_eq!(m.stats(), before);
    assert_eq!(m.stats().used_mutation_admission_ids, 1);
    assert!(!m.leases.values().next().unwrap().consumed);
}
#[test]
fn caller_id_is_bounded_before_attempt_binding() {
    let (mut m, s, f) = model(Default::default());
    let t = reserve(&mut m, &s, &f);
    finish_stage(&mut m, &t, &f, "p");
    for op in [
        None,
        Some("bad\n".to_owned()),
        Some("a".repeat(65)),
        Some("a".repeat(1_000_000)),
    ] {
        let old = m.stats();
        assert!(matches!(
            m.issue_workflow_lease(
                &t,
                WorkflowAction::PauseJoin,
                WorkflowAttemptIds { operation_id: op },
                RecordingWireLeaseRequest::from_value(f["bases"]["sLease"].clone()).unwrap()
            ),
            Err(ModelError::InvalidInput)
        ));
        assert_eq!(m.stats(), old);
    }
}
#[test]
fn native_generated_operation_id_cannot_be_accepted_again_as_a_caller_id() {
    let (mut m, s, f) = model(Default::default());
    let t = reserve(&mut m, &s, &f);
    finish_stage(&mut m, &t, &f, "p");
    let mut q = f["bases"]["sAdmit"].clone();
    q["action"]["operation"]["operationId"] = json!("native-preflight");
    m.issue_workflow_lease(
        &t,
        WorkflowAction::PauseJoin,
        WorkflowAttemptIds {
            operation_id: Some("native-preflight".into()),
        },
        RecordingWireLeaseRequest::from_value(f["bases"]["sLease"].clone()).unwrap(),
    )
    .unwrap();
    let a = match m
        .begin_workflow_admission(
            &t,
            RecordingAdmissionRequest::from_value(q.clone()).unwrap(),
        )
        .unwrap()
    {
        AdmissionStart::Registered { ticket } => ticket,
        _ => panic!("registered"),
    };
    let mut p = f["bases"]["sAccepted"].clone();
    p["request"] = q.clone();
    p["outcome"]["handle"]["request"] = q["action"]["operation"].clone();
    let old = m.stats();
    assert!(matches!(
        m.observe_native(
            &a,
            SimulatedDecision::Accepted(RecordingAdmissionReply::from_value(p).unwrap())
        ),
        Err(ModelError::ProtocolViolation)
    ));
    assert_eq!(m.stats(), old);
    assert_eq!(m.stats().operation_handles, 1);
    let p=RecordingAdmissionReply::from_value(json!({"version":1,"kind":"recordingAdmissionReply","request":q,"outcome":{"kind":"rejected","error":"consumed"}})).unwrap();
    m.observe_native(&a, SimulatedDecision::Rejected(p.clone()))
        .unwrap();
    m.finish_admission_call(&a, p).unwrap();
    assert_eq!(m.workflow_phase(), Some(WorkflowPhase::Candidate));
}
#[test]
fn expired_attempt_cannot_take_reserved_revision_credit_from_later_stages() {
    let (mut m, s, f) = model(ModelLimits {
        revision_ceiling: 13,
        ..Default::default()
    });
    let t = reserve(&mut m, &s, &f);
    issue(&mut m, &t, &f, "p");
    m.advance_to(ModelInstant(10)).unwrap();
    let old = m.stats();
    assert!(matches!(
        m.issue_workflow_lease(
            &t,
            WorkflowAction::Preflight,
            Default::default(),
            RecordingWireLeaseRequest::from_value(f["bases"]["pRetryLease"].clone()).unwrap()
        ),
        Err(ModelError::Capacity)
    ));
    assert_eq!(m.stats(), old);
    m.close().unwrap();
    assert_eq!(m.stats().published_revision, 2);
}
#[test]
fn reserve_replay_after_close_has_no_new_effect_and_still_checks_principal() {
    let (mut m, s, f) = model(Default::default());
    let t = reserve(&mut m, &s, &f);
    m.close().unwrap();
    let before = m.stats();
    let again = reserve(&mut m, &s, &f);
    assert_eq!(t.sequence, again.sequence);
    assert_eq!(m.stats(), before);
    let other =
        ModelSession::new(s.scope.clone(), SimulatedPrincipal::new("other").unwrap()).unwrap();
    assert!(matches!(
        m.reserve_workflow(
            &other,
            RecordingChangeRequest::from_value(f["bases"]["change"].clone()).unwrap()
        ),
        Err(ModelError::Forbidden)
    ));
    assert_eq!(m.stats(), before);
}
