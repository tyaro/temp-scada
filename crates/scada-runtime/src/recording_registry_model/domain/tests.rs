use super::*;
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../examples/recording-registry-model-cases.json"
    ))
    .unwrap()
}
fn registration(n: usize) -> DomainRegistration {
    let mut scope = fixture()["scope"].clone();
    scope["ownerRef"] = json!(format!("owner:{n}"));
    DomainRegistration {
        resource: SimulatedResourceId::new(&format!("resource:{n}")).unwrap(),
        session: ModelSession::new(scope, SimulatedPrincipal::new("principal").unwrap()).unwrap(),
        limits: ModelLimits::default(),
        mode: DomainMode::Standalone,
    }
}
fn rebind(mut v: Value, s: &ModelSession) -> Value {
    fn visit(v: &mut Value, owner: &Value) {
        match v {
            Value::Object(o) => {
                for (k, v) in o {
                    if k == "ownerRef" {
                        *v = owner.clone();
                    } else {
                        visit(v, owner);
                    }
                }
            }
            Value::Array(a) => {
                for v in a {
                    visit(v, owner);
                }
            }
            _ => {}
        }
    }
    visit(&mut v, &s.scope["ownerRef"]);
    v
}
fn start(
    d: &mut RegistryDomain,
    t: &DomainScopeTicket,
    r: &DomainRegistration,
) -> SimulationTicket {
    let f = fixture();
    let mut scope = d.scope(t, &r.session).unwrap();
    let reply = scope
        .issue_lease(
            &r.session,
            RecordingWireLeaseRequest::from_value(rebind(f["bases"]["lease"].clone(), &r.session))
                .unwrap(),
        )
        .unwrap();
    let mut q = rebind(f["bases"]["admit"].clone(), &r.session);
    q["deadlineLeaseRef"] = reply.as_value()["outcome"]["deadlineLeaseRef"].clone();
    match scope
        .begin_admission(
            &r.session,
            RecordingAdmissionRequest::from_value(q).unwrap(),
        )
        .unwrap()
    {
        AdmissionStart::Registered { ticket } => ticket,
        _ => panic!("registered"),
    }
}
#[test]
fn default_partitions_are_reserved_before_any_payload_and_never_lent() {
    let mut d = RegistryDomain::new(Default::default()).unwrap();
    let a = registration(1);
    let t = d.register(a.clone()).unwrap();
    let b = registration(2);
    d.register(b).unwrap();
    let before = d.stats();
    assert_eq!(before.reserved_total, 16 * 1024 * 1024);
    assert_eq!(before.reserved_read, 4 * 1024 * 1024);
    assert_eq!(before.reserved_mutation, 12 * 1024 * 1024);
    assert!(matches!(
        d.register(registration(3)),
        Err(ModelError::Capacity)
    ));
    assert_eq!(d.stats(), before);
    assert_eq!(d.scope(&t, &a.session).unwrap().stats().mutation_bytes, 0);
    d.scope(&t, &a.session).unwrap().close().unwrap();
    assert_eq!(d.stats(), before);
    assert!(matches!(
        d.register(registration(3)),
        Err(ModelError::Capacity)
    ));
}
#[test]
fn global_bytes_accept_exact_and_reject_one_short_without_owner_binding() {
    for short in [false, true] {
        let mut d = RegistryDomain::new(DomainLimits {
            total_bytes: 4096 - usize::from(short),
            ..Default::default()
        })
        .unwrap();
        let mut a = registration(1);
        a.limits.total_bytes = 2048;
        a.limits.read_bytes = 1024;
        d.register(a).unwrap();
        let mut b = registration(2);
        b.limits.total_bytes = 2048;
        b.limits.read_bytes = 1024;
        let before = d.stats();
        if short {
            assert!(matches!(d.register(b.clone()), Err(ModelError::Capacity)));
            assert_eq!(d.stats(), before);
            b.limits.total_bytes -= 1;
        }
        d.register(b).unwrap();
        assert_eq!(d.stats().reserved_total, 4096 - usize::from(short));
    }
}
#[test]
fn subscription_reservations_bound_live_use_and_detach_never_refunds_the_domain() {
    let mut d = RegistryDomain::new(Default::default()).unwrap();
    let mut tickets = vec![];
    for n in 0..8 {
        let mut r = registration(n);
        r.limits.total_bytes = 1024 * 1024;
        r.limits.read_bytes = 64 * 1024;
        let t = d.register(r.clone()).unwrap();
        tickets.push((t, r));
    }
    assert_eq!(d.stats().reserved_subscriptions, 32);
    let before = d.stats();
    let mut ninth = registration(9);
    ninth.limits.total_bytes = 1024 * 1024;
    ninth.limits.read_bytes = 64 * 1024;
    assert!(matches!(d.register(ninth), Err(ModelError::Capacity)));
    assert_eq!(d.stats(), before);
    for (t, r) in &tickets {
        let mut scope = d.scope(t, &r.session).unwrap();
        for n in 0..4 {
            let q=RecordingWireAttachRequest::from_value(json!({"version":1,"kind":"recordingWireAttachRequest","scope":r.session.scope(),"attachId":format!("attach:{n}"),"afterRevision":null})).unwrap();
            let reply = scope.attach(&r.session, q).unwrap();
            if n == 0 {
                scope.control(&r.session,RecordingWireControlRequest::from_value(json!({"version":1,"kind":"recordingWireControlRequest","scope":r.session.scope(),"controlId":"detach","subscriptionRef":reply.as_value()["outcome"]["subscriptionRef"],"action":"detach"})).unwrap()).unwrap();
            }
        }
        assert_eq!(scope.stats().live_subscriptions, 3);
    }
    assert_eq!(d.stats(), before);
}
#[test]
fn thirty_two_small_scopes_are_finite_even_with_zero_subscription_reservations() {
    let mut d = RegistryDomain::new(Default::default()).unwrap();
    for n in 0..32 {
        let mut r = registration(n);
        r.limits.total_bytes = 2048;
        r.limits.read_bytes = 1024;
        r.limits.live_subscriptions = 0;
        d.register(r).unwrap();
    }
    let before = d.stats();
    let mut r = registration(32);
    r.limits.total_bytes = 2048;
    r.limits.read_bytes = 1024;
    r.limits.live_subscriptions = 0;
    assert!(matches!(d.register(r), Err(ModelError::Capacity)));
    assert_eq!(d.stats(), before);
    assert_eq!(before.registered_scopes, 32);
}
#[test]
fn limits_and_resource_id_validation_include_zero_and_exact_endpoints() {
    for bad in [
        DomainLimits {
            total_bytes: 16 * 1024 * 1024 + 1,
            ..Default::default()
        },
        DomainLimits {
            scopes: 33,
            ..Default::default()
        },
        DomainLimits {
            live_subscriptions: 33,
            ..Default::default()
        },
    ] {
        assert!(matches!(
            RegistryDomain::new(bad),
            Err(ModelError::InvalidInput)
        ));
    }
    for l in [
        DomainLimits {
            total_bytes: 0,
            ..Default::default()
        },
        DomainLimits {
            scopes: 0,
            ..Default::default()
        },
        DomainLimits {
            live_subscriptions: 0,
            ..Default::default()
        },
    ] {
        let mut d = RegistryDomain::new(l).unwrap();
        let before = d.stats();
        assert!(matches!(
            d.register(registration(1)),
            Err(ModelError::Capacity)
        ));
        assert_eq!(d.stats(), before);
    }
    let mut d = RegistryDomain::new(DomainLimits {
        live_subscriptions: 0,
        ..Default::default()
    })
    .unwrap();
    let mut r = registration(1);
    r.limits.live_subscriptions = 0;
    d.register(r).unwrap();
    for bad in ["", "not a resource", "日本語", &"r".repeat(65)] {
        assert_eq!(SimulatedResourceId::new(bad), Err(ModelError::InvalidInput));
    }
    assert!(SimulatedResourceId::new(&"r".repeat(64)).is_ok());
}
#[test]
fn both_identity_indexes_and_principal_binding_survive_close_and_seal() {
    let mut d = RegistryDomain::new(Default::default()).unwrap();
    let a = registration(1);
    let t = d.register(a.clone()).unwrap();
    d.scope(&t, &a.session).unwrap().close().unwrap();
    d.seal();
    let before = d.stats();
    for change in 0..5 {
        let mut b = a.clone();
        match change {
            0 => b.resource = SimulatedResourceId::new("other").unwrap(),
            1 => b.session.scope["ownerRef"] = json!("other"),
            2 => b.session.scope["ownerEpoch"] = json!("other"),
            3 => b.session.scope["context"]["sessionId"] = json!("other"),
            _ => {
                b.mode = DomainMode::Workflow {
                    qualification: SimulatedRunQualification::Running,
                }
            }
        };
        assert!(matches!(d.register(b), Err(ModelError::ProtocolViolation)));
        assert_eq!(d.stats(), before);
    }
    let mut wrong = a.clone();
    wrong.session.principal = SimulatedPrincipal::new("other").unwrap();
    assert!(matches!(
        d.register(wrong.clone()),
        Err(ModelError::Forbidden)
    ));
    assert!(matches!(
        d.scope(&t, &wrong.session),
        Err(ModelError::Forbidden)
    ));
    let replay = d.register(a.clone()).unwrap();
    assert_eq!(replay.sequence, t.sequence);
    assert_eq!(d.stats(), before);
    assert!(d.scope(&replay, &a.session).unwrap().stats().closed);
}
#[test]
fn registration_replay_compares_every_limit_and_validates_before_cache() {
    let mut d = RegistryDomain::new(Default::default()).unwrap();
    let a = registration(1);
    d.register(a.clone()).unwrap();
    let before = d.stats();
    macro_rules! changed {($($field:ident),*)=>{$(let mut b=a.clone();b.limits.$field-=1;assert!(matches!(d.register(b),Err(ModelError::ProtocolViolation)),stringify!($field));)*}}
    changed!(
        workflow_changes,
        caller_operation_ids,
        simulated_native_identities,
        reconciliation_ids,
        mutation_admissions,
        read_admissions,
        mutation_leases,
        read_leases,
        unconsumed_leases,
        admission_inspections,
        call_inspections,
        operation_observations,
        read_observations,
        pending_operation_observations,
        pending_read_observations,
        cancel_requests,
        pending_cancel_calls,
        live_subscriptions,
        attach_requests,
        control_requests,
        revision_ceiling,
        total_bytes,
        read_bytes
    );
    for dimension in 0..3 {
        let mut b = a.clone();
        match dimension {
            0 => b.limits.projection_limit.bytes -= 1,
            1 => b.limits.projection_limit.nodes -= 1,
            _ => b.limits.projection_limit.depth -= 1,
        };
        assert!(matches!(d.register(b), Err(ModelError::ProtocolViolation)));
    }
    let mut invalid = a;
    invalid.limits.read_bytes = invalid.limits.total_bytes + 1;
    assert!(matches!(d.register(invalid), Err(ModelError::InvalidInput)));
    assert_eq!(d.stats(), before);
}
#[test]
fn constructor_and_sequence_failure_do_not_consume_bindings_or_quotas() {
    let mut d = RegistryDomain::new(Default::default()).unwrap();
    let mut bad = registration(1);
    bad.limits.total_bytes = 1023;
    bad.limits.read_bytes = 1023;
    let before = d.stats();
    assert!(matches!(d.register(bad), Err(ModelError::Capacity)));
    assert_eq!(d.stats(), before);
    d.sequence = u64::MAX;
    assert!(matches!(
        d.register(registration(1)),
        Err(ModelError::Capacity)
    ));
    assert_eq!(d.stats(), before);
    assert!(d.records.is_empty());
    d.sequence = 0;
    d.register(registration(1)).unwrap();
}
#[test]
fn opaque_tickets_and_two_stage_session_checks_prevent_cross_scope_use() {
    let mut d = RegistryDomain::new(Default::default()).unwrap();
    let a = registration(1);
    let t = d.register(a.clone()).unwrap();
    let mut other = RegistryDomain::new(Default::default()).unwrap();
    let ot = other.register(a.clone()).unwrap();
    assert!(matches!(
        d.scope(&ot, &a.session),
        Err(ModelError::Forbidden)
    ));
    let bad = DomainScopeTicket {
        identity: t.identity.clone(),
        sequence: 99,
    };
    assert!(matches!(
        d.scope(&bad, &a.session),
        Err(ModelError::InvalidInput)
    ));
    let b = registration(2);
    let bt = d.register(b.clone()).unwrap();
    assert!(matches!(
        d.scope(&t, &b.session),
        Err(ModelError::Forbidden)
    ));
    let before = d.stats();
    let mut facade = d.scope(&t, &a.session).unwrap();
    let q = RecordingWireLeaseRequest::from_value(rebind(
        fixture()["bases"]["lease"].clone(),
        &b.session,
    ))
    .unwrap();
    assert!(matches!(
        facade.issue_lease(&b.session, q),
        Err(ModelError::Forbidden)
    ));
    assert_eq!(d.stats(), before);
    let at = start(&mut d, &t, &a);
    let _bt = start(&mut d, &bt, &b);
    let proof = RecordingAdmissionReply::from_value(rebind(
        fixture()["bases"]["accepted"].clone(),
        &b.session,
    ))
    .unwrap();
    let before = d.scope(&bt, &b.session).unwrap().stats();
    assert_eq!(
        d.scope(&bt, &b.session)
            .unwrap()
            .observe_native(&at, SimulatedDecision::Accepted(proof)),
        Err(ModelError::Forbidden)
    );
    assert_eq!(d.scope(&bt, &b.session).unwrap().stats(), before);
}
#[test]
fn common_clock_applies_to_existing_and_late_scopes_without_publishing_frames() {
    let mut d = RegistryDomain::new(Default::default()).unwrap();
    let a = registration(1);
    let t = d.register(a.clone()).unwrap();
    d.advance_to(ModelInstant(500)).unwrap();
    let b = registration(2);
    let bt = d.register(b.clone()).unwrap();
    let mut saved = vec![];
    for (t, r) in [(&t, &a), (&bt, &b)] {
        let scope = d.scope(t, &r.session).unwrap();
        assert_eq!(scope.now(), ModelInstant(500));
        saved.push(scope.owner_snapshot(&r.session).unwrap());
    }
    assert_eq!(d.advance_to(ModelInstant(499)), Err(ModelError::ClockFault));
    assert_eq!(d.stats().now, ModelInstant(500));
    assert!(d.stats().clock_fault);
    for ((t, r), snapshot) in [(&t, &a), (&bt, &b)].into_iter().zip(saved) {
        let scope = d.scope(t, &r.session).unwrap();
        assert!(scope.stats().clock_fault);
        assert_eq!(scope.now(), ModelInstant(500));
        assert_eq!(scope.owner_snapshot(&r.session).unwrap(), snapshot);
    }
    d.advance_to(ModelInstant(501)).unwrap();
    assert!(d.stats().clock_fault);
    let before = d.stats();
    d.register(a).unwrap();
    assert_eq!(d.stats(), before);
    assert!(matches!(
        d.register(registration(3)),
        Err(ModelError::ClockFault)
    ));
}
#[test]
fn clock_fault_in_an_empty_domain_is_sticky_and_cannot_create_a_fresh_scope() {
    let mut d = RegistryDomain::new(Default::default()).unwrap();
    d.advance_to(ModelInstant(u64::MAX)).unwrap();
    assert_eq!(d.advance_to(ModelInstant(0)), Err(ModelError::ClockFault));
    assert!(matches!(
        d.register(registration(1)),
        Err(ModelError::ClockFault)
    ));
    assert_eq!(d.stats().registered_scopes, 0);
}
#[test]
fn seal_and_client_lifetime_do_not_stop_existing_calls_or_release_capacity() {
    let mut d = RegistryDomain::new(Default::default()).unwrap();
    let a = registration(1);
    let t = d.register(a.clone()).unwrap();
    let call = start(&mut d, &t, &a);
    drop(t);
    d.seal();
    let t = d.register(a.clone()).unwrap();
    let before = d.stats();
    let p = RecordingAdmissionReply::from_value(rebind(
        fixture()["bases"]["accepted"].clone(),
        &a.session,
    ))
    .unwrap();
    d.scope(&t, &a.session)
        .unwrap()
        .observe_native(&call, SimulatedDecision::Accepted(p.clone()))
        .unwrap();
    d.scope(&t, &a.session)
        .unwrap()
        .finish_admission_call(&call, p)
        .unwrap();
    assert_eq!(d.stats(), before);
    assert!(matches!(
        d.register(registration(2)),
        Err(ModelError::Closed)
    ));
}
#[test]
fn protected_read_and_reserved_completion_survive_a_full_domain() {
    let mut a = registration(1);
    a.limits.total_bytes = 64 * 1024;
    a.limits.read_bytes = 64 * 1024;
    let b = registration(2);
    let mut d = RegistryDomain::new(DomainLimits {
        total_bytes: a.limits.total_bytes + b.limits.total_bytes,
        ..Default::default()
    })
    .unwrap();
    let at = d.register(a.clone()).unwrap();
    let bt = d.register(b.clone()).unwrap();
    let budget = d.stats();
    let mut scope = d.scope(&at, &a.session).unwrap();
    let lease = RecordingWireLeaseRequest::from_value(rebind(
        fixture()["bases"]["lease"].clone(),
        &a.session,
    ))
    .unwrap();
    assert!(matches!(
        scope.issue_lease(&a.session, lease),
        Err(ModelError::Capacity)
    ));
    let request = RecordingAdmissionInspectionRequest::from_value(rebind(
        fixture()["bases"]["inspect"].clone(),
        &a.session,
    ))
    .unwrap();
    let read = scope.inspect_admission(&a.session, request).unwrap();
    assert_eq!(read.as_value()["outcome"]["kind"], "notFound");
    assert!(scope.stats().read_bytes > 1024);
    let a_before = scope.stats();
    let call = start(&mut d, &bt, &b);
    let proof = RecordingAdmissionReply::from_value(rebind(
        fixture()["bases"]["accepted"].clone(),
        &b.session,
    ))
    .unwrap();
    let mut scope = d.scope(&bt, &b.session).unwrap();
    scope
        .observe_native(&call, SimulatedDecision::Accepted(proof.clone()))
        .unwrap();
    let handle = scope.accepted_handle(&call).unwrap();
    scope.finish_admission_call(&call, proof).unwrap();
    let f: Value = serde_json::from_str(include_str!(
        "../../../../../examples/recording-observation-model-cases.json"
    ))
    .unwrap();
    let mut value = f["bases"]["opFailedResult"].clone();
    value["request"] = rebind(
        fixture()["bases"]["accepted"]["outcome"]["handle"]["request"].clone(),
        &b.session,
    );
    let result =
        scada_model::recording_operations::RecordingOperationResult::from_value(value).unwrap();
    scope
        .complete_handle(&handle, SimulatedCompletion::Operation(result))
        .unwrap();
    assert_eq!(scope.stats().completed_handles, 1);
    assert_eq!(d.stats(), budget);
    assert_eq!(d.scope(&at, &a.session).unwrap().stats(), a_before);
}
#[test]
fn a_request_colliding_with_two_owners_cannot_hide_a_principal_mismatch() {
    let mut d = RegistryDomain::new(Default::default()).unwrap();
    let a = registration(1);
    d.register(a.clone()).unwrap();
    let mut b = registration(2);
    b.session.principal = SimulatedPrincipal::new("second").unwrap();
    d.register(b.clone()).unwrap();
    let before = d.stats();
    let mut crossed = a;
    crossed.session.scope["ownerRef"] = b.session.scope["ownerRef"].clone();
    assert!(matches!(d.register(crossed), Err(ModelError::Forbidden)));
    assert_eq!(d.stats(), before);
}
