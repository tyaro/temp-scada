use super::*;
mod boundaries;
mod cancel_boundaries;
mod observation_boundaries;
mod renewal_boundaries;
mod subscription_boundaries;
mod workflow_boundaries;
fn fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../../examples/recording-registry-model-cases.json"
    ))
    .unwrap()
}
fn patched(mut value: Value, recipe: &Value) -> Value {
    for p in recipe["patch"].as_array().into_iter().flatten() {
        let (parent, key) = p["path"].as_str().unwrap().rsplit_once('/').unwrap();
        let target = value.pointer_mut(parent).unwrap();
        if p["remove"] == true {
            target.as_object_mut().unwrap().remove(key);
        } else if let Some(o) = target.as_object_mut() {
            o.insert(key.to_owned(), p["value"].clone());
        } else {
            target[key.parse::<usize>().unwrap()] = p["value"].clone();
        }
    }
    value
}
fn document(all: &Value, recipe: &Value) -> Value {
    patched(
        all["bases"][recipe["base"].as_str().unwrap()].clone(),
        recipe,
    )
}
fn session(all: &Value, changes: &Value) -> ModelSession {
    let mut s = all["scope"].clone();
    if let Some(epoch) = changes.get("epoch") {
        s["ownerEpoch"] = epoch.clone();
    }
    ModelSession::new(
        s,
        SimulatedPrincipal::new(
            changes["principal"]
                .as_str()
                .unwrap_or(all["principal"].as_str().unwrap()),
        )
        .unwrap(),
    )
    .unwrap()
}
fn limits(v: &Value) -> ModelLimits {
    let mut l = ModelLimits::default();
    for (key, value) in v.as_object().into_iter().flatten() {
        let n = value.as_u64().unwrap() as usize;
        match key.as_str() {
            "workflow_changes" => l.workflow_changes = n,
            "caller_operation_ids" => l.caller_operation_ids = n,
            "simulated_native_identities" => l.simulated_native_identities = n,
            "reconciliation_ids" => l.reconciliation_ids = n,
            "mutation_admissions" => l.mutation_admissions = n,
            "read_admissions" => l.read_admissions = n,
            "mutation_leases" => l.mutation_leases = n,
            "read_leases" => l.read_leases = n,
            "unconsumed_leases" => l.unconsumed_leases = n,
            "admission_inspections" => l.admission_inspections = n,
            "call_inspections" => l.call_inspections = n,
            "operation_observations" => l.operation_observations = n,
            "read_observations" => l.read_observations = n,
            "pending_operation_observations" => l.pending_operation_observations = n,
            "pending_read_observations" => l.pending_read_observations = n,
            "cancel_requests" => l.cancel_requests = n,
            "pending_cancel_calls" => l.pending_cancel_calls = n,
            "live_subscriptions" => l.live_subscriptions = n,
            "attach_requests" => l.attach_requests = n,
            "control_requests" => l.control_requests = n,
            "revision_ceiling" => l.revision_ceiling = n as u64,
            "projection_bytes" => l.projection_limit.bytes = n,
            "projection_nodes" => l.projection_limit.nodes = n,
            "projection_depth" => l.projection_limit.depth = n,
            "total_bytes" => l.total_bytes = n,
            "read_bytes" => l.read_bytes = n,
            _ => panic!("unknown model test limit"),
        }
    }
    l
}
#[test]
fn shared_virtual_scenarios_match_immutable_wire_transcripts() {
    assert_scenarios(&fixtures());
}
#[test]
fn observation_scenarios_match_immutable_wire_transcripts() {
    let all: Value = serde_json::from_str(include_str!(
        "../../../../examples/recording-observation-model-cases.json"
    ))
    .unwrap();
    assert_scenarios(&all);
}
#[test]
fn cancel_scenarios_match_immutable_wire_transcripts() {
    let all: Value = serde_json::from_str(include_str!(
        "../../../../examples/recording-cancel-model-cases.json"
    ))
    .unwrap();
    assert_scenarios(&all);
}
#[test]
fn subscription_scenarios_match_immutable_wire_transcripts() {
    let all: Value = serde_json::from_str(include_str!(
        "../../../../examples/recording-subscription-model-cases.json"
    ))
    .unwrap();
    assert_scenarios(&all);
}
#[test]
fn workflow_scenarios_match_immutable_wire_transcripts() {
    let all: Value = serde_json::from_str(include_str!(
        "../../../../examples/recording-workflow-model-cases.json"
    ))
    .unwrap();
    assert_scenarios(&all);
}
#[test]
fn renewal_scenarios_match_immutable_wire_transcripts() {
    let all: Value = serde_json::from_str(include_str!(
        "../../../../examples/recording-workflow-renewal-cases.json"
    ))
    .unwrap();
    assert_scenarios(&all);
}
fn assert_scenarios(all: &Value) {
    for managed in [false, true] {
        assert_scenarios_mode(all, managed);
    }
}
fn assert_scenarios_mode(all: &Value, managed: bool) {
    for scenario in all["scenarios"].as_array().unwrap() {
        let s = session(all, &Value::Null);
        let mode = if scenario["workflow"] == true {
            DomainMode::Workflow {
                qualification: match scenario["qualification"].as_str() {
                    Some("unqualified") => SimulatedRunQualification::Unqualified,
                    Some("cleanJoined") => SimulatedRunQualification::CleanJoined,
                    _ => SimulatedRunQualification::Running,
                },
            }
        } else {
            DomainMode::Standalone
        };
        let mut domain = RegistryDomain::new(Default::default()).unwrap();
        let mut standalone = None;
        let domain_ticket = if managed {
            Some(
                domain
                    .register(DomainRegistration {
                        resource: SimulatedResourceId::new("scenario").unwrap(),
                        session: s.clone(),
                        limits: limits(&scenario["limits"]),
                        mode,
                    })
                    .unwrap(),
            )
        } else {
            standalone = Some(
                match mode {
                    DomainMode::Standalone => {
                        RegistryModel::new(s.clone(), limits(&scenario["limits"]))
                    }
                    DomainMode::Workflow { qualification } => RegistryModel::new_workflow(
                        s.clone(),
                        limits(&scenario["limits"]),
                        qualification,
                    ),
                }
                .unwrap(),
            );
            None
        };
        let mut workflow = None;
        let mut workflows = BTreeMap::new();
        let mut tickets = BTreeMap::new();
        let mut handles = BTreeMap::new();
        let mut cancel_tickets = BTreeMap::new();
        for (index, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let before = if managed {
                domain
                    .scope(domain_ticket.as_ref().unwrap(), &s)
                    .unwrap()
                    .stats()
            } else {
                standalone.as_ref().unwrap().stats()
            };
            let clock_result = if step["op"] == "advance" {
                let now = ModelInstant(step["nowMs"].as_str().unwrap().parse().unwrap());
                if managed {
                    domain.advance_to(now)
                } else {
                    standalone.as_mut().unwrap().advance_to(now)
                }
            } else {
                Ok(())
            };
            let mut model = if managed {
                domain.scope(domain_ticket.as_ref().unwrap(), &s).unwrap()
            } else {
                DomainScope::unpooled(standalone.as_mut().unwrap())
            };
            let s = session(all, &step["session"]);
            let input = if step.get("input").is_some() {
                document(all, &step["input"])
            } else {
                Value::Null
            };
            let alias = step["ticket"].as_str().unwrap_or("a");
            let label = format!(
                "{} managed={managed} step {} {}",
                scenario["name"], index, step["op"]
            );
            let result: Result<(&str, Option<Value>), ModelError> = (|| {
                Ok(match step["op"].as_str().unwrap() {
                    "reserve" => {
                        let t = model.reserve_workflow(
                            &s,
                            scada_model::recording_operations::RecordingChangeRequest::from_value(
                                input,
                            )
                            .unwrap_or_else(|e| panic!("{label}: {e}")),
                        )?;
                        workflows.insert(
                            step["workflowTicket"]
                                .as_str()
                                .unwrap_or("current")
                                .to_owned(),
                            t.clone(),
                        );
                        workflow = Some(t);
                        ("reserved", None)
                    }
                    "renew" => {
                        let predecessor = &workflows[step["predecessor"].as_str().unwrap()];
                        let qualification = match step["qualification"].as_str() {
                            Some("cleanJoined") => SimulatedRunQualification::CleanJoined,
                            Some("unqualified") => SimulatedRunQualification::Unqualified,
                            _ => SimulatedRunQualification::Running,
                        };
                        let t = model.reserve_next_workflow(
                            &s,
                            predecessor,
                            qualification,
                            scada_model::recording_operations::RecordingChangeRequest::from_value(
                                input,
                            )
                            .unwrap_or_else(|e| panic!("{label}: {e}")),
                        )?;
                        workflows.insert(
                            step["workflowTicket"]
                                .as_str()
                                .unwrap_or("current")
                                .to_owned(),
                            t.clone(),
                        );
                        workflow = Some(t);
                        ("reserved", None)
                    }
                    "workflow_issue" => {
                        let r = model.issue_workflow_lease(
                            step["workflowTicket"]
                                .as_str()
                                .map_or_else(|| workflow.as_ref().unwrap(), |id| &workflows[id]),
                            WorkflowAction::from_value(&step["stage"])?,
                            WorkflowAttemptIds {
                                operation_id: step["operationId"].as_str().map(str::to_owned),
                            },
                            RecordingWireLeaseRequest::from_value(input)
                                .unwrap_or_else(|e| panic!("{label}: {e}")),
                        )?;
                        ("reply", Some(r.as_value().clone()))
                    }
                    "workflow_begin" => match model.begin_workflow_admission(
                        step["workflowTicket"]
                            .as_str()
                            .map_or_else(|| workflow.as_ref().unwrap(), |id| &workflows[id]),
                        RecordingAdmissionRequest::from_value(input)
                            .unwrap_or_else(|e| panic!("{label}: {e}")),
                    )? {
                        AdmissionStart::Registered { ticket } => {
                            tickets.insert(alias.to_owned(), ticket);
                            ("Registered", None)
                        }
                        AdmissionStart::Pending { ticket } => {
                            tickets.insert(alias.to_owned(), ticket);
                            ("Pending", None)
                        }
                        AdmissionStart::Replay { reply } => {
                            ("Replay", Some(reply.as_value().clone()))
                        }
                    },
                    "issue" => {
                        let r = model.issue_lease(
                            &s,
                            RecordingWireLeaseRequest::from_value(input)
                                .unwrap_or_else(|e| panic!("{label}: {e}")),
                        )?;
                        ("reply", Some(r.as_value().clone()))
                    }
                    "begin" => match model.begin_admission(
                        &s,
                        RecordingAdmissionRequest::from_value(input)
                            .unwrap_or_else(|e| panic!("{label}: {e}")),
                    )? {
                        AdmissionStart::Registered { ticket } => {
                            tickets.insert(alias.to_owned(), ticket);
                            ("Registered", None)
                        }
                        AdmissionStart::Pending { ticket } => {
                            tickets.insert(alias.to_owned(), ticket);
                            ("Pending", None)
                        }
                        AdmissionStart::Replay { reply } => {
                            ("Replay", Some(reply.as_value().clone()))
                        }
                    },
                    "proof" => {
                        let r = RecordingAdmissionReply::from_value(input)
                            .unwrap_or_else(|e| panic!("{label}: {e}"));
                        let d = match step["decision"].as_str().unwrap() {
                            "Accepted" => SimulatedDecision::Accepted(r),
                            "Rejected" => SimulatedDecision::Rejected(r),
                            "CompletedDiscard" => SimulatedDecision::CompletedDiscard(r),
                            _ => panic!("decision"),
                        };
                        model.observe_native(&tickets[alias], d)?;
                        ("ok", None)
                    }
                    "handle" => {
                        let h = model.accepted_handle(&tickets[alias])?;
                        handles.insert(step["handle"].as_str().unwrap().to_owned(), h);
                        ("ok", None)
                    }
                    "complete" => {
                        let c=match step["completion"].as_str().unwrap() {
                            "operation"=>SimulatedCompletion::Operation(scada_model::recording_operations::RecordingOperationResult::from_value(input).unwrap_or_else(|e|panic!("{label}: {e}"))),
                            "reconciliation"=>SimulatedCompletion::Reconciliation(RecordingReconciliationDelivery::from_value(input).unwrap_or_else(|e|panic!("{label}: {e}"))),
                            _=>panic!("completion kind"),
                        };
                        model.complete_handle(&handles[step["handle"].as_str().unwrap()], c)?;
                        ("ok", None)
                    }
                    "observe" => {
                        let r = model.observe_result(
                            &s,
                            RecordingWireObservationRequest::from_value(input)
                                .unwrap_or_else(|e| panic!("{label}: {e}")),
                        )?;
                        ("reply", Some(r.as_value().clone()))
                    }
                    "snapshot" => ("reply", Some(model.owner_snapshot(&s)?)),
                    "attach" => {
                        let r = model.attach(
                            &s,
                            RecordingWireAttachRequest::from_value(input)
                                .unwrap_or_else(|e| panic!("{label}: {e}")),
                        )?;
                        ("reply", Some(r.as_value().clone()))
                    }
                    "control" => {
                        let r = model.control(
                            &s,
                            RecordingWireControlRequest::from_value(input)
                                .unwrap_or_else(|e| panic!("{label}: {e}")),
                        )?;
                        ("reply", Some(r.as_value().clone()))
                    }
                    "state_frame" => {
                        let f = model
                            .take_state_frame(&s, step["subscriptionRef"].as_str().unwrap())?;
                        if let Some(f) = f {
                            ("reply", Some(f.as_value().clone()))
                        } else {
                            ("empty", None)
                        }
                    }
                    "control_frame" => {
                        let f = model
                            .take_control_frame(&s, step["subscriptionRef"].as_str().unwrap())?;
                        if let Some(f) = f {
                            ("reply", Some(f.as_value().clone()))
                        } else {
                            ("empty", None)
                        }
                    }
                    "begin_cancel" => {
                        match model.begin_cancel(
                            &s,
                            RecordingWireCancelRequest::from_value(input)
                                .unwrap_or_else(|e| panic!("{label}: {e}")),
                        )? {
                            CancelStart::Registered { ticket } => {
                                cancel_tickets.insert(alias.to_owned(), ticket);
                                ("Registered", None)
                            }
                            CancelStart::Pending { ticket } => {
                                cancel_tickets.insert(alias.to_owned(), ticket);
                                ("Pending", None)
                            }
                            CancelStart::Replay { reply } => {
                                ("Replay", Some(reply.as_value().clone()))
                            }
                        }
                    }
                    "notify_cancel" => {
                        let r = model.notify_cancel(&cancel_tickets[alias])?;
                        ("reply", Some(r.as_value().clone()))
                    }
                    "finish_cancel" => {
                        let r = model.finish_cancel_call(&cancel_tickets[alias])?;
                        ("reply", Some(r.as_value().clone()))
                    }
                    "finish" => {
                        model.finish_admission_call(
                            &tickets[alias],
                            RecordingAdmissionReply::from_value(input)
                                .unwrap_or_else(|e| panic!("{label}: {e}")),
                        )?;
                        ("ok", None)
                    }
                    "inspect" => {
                        let r = model.inspect_admission(
                            &s,
                            RecordingAdmissionInspectionRequest::from_value(input)
                                .unwrap_or_else(|e| panic!("{label}: {e}")),
                        )?;
                        ("reply", Some(r.as_value().clone()))
                    }
                    "call" => {
                        let r = model.inspect_call(
                            &s,
                            RecordingWireCallInspectionRequest::from_value(input)
                                .unwrap_or_else(|e| panic!("{label}: {e}")),
                        )?;
                        ("reply", Some(r.as_value().clone()))
                    }
                    "advance" => {
                        clock_result?;
                        ("ok", None)
                    }
                    "close" => {
                        model.close()?;
                        ("ok", None)
                    }
                    "stats" => ("ok", None),
                    _ => panic!("unknown scenario command"),
                })
            })();
            let label = format!(
                "{} managed={managed} step {} {}",
                scenario["name"], index, step["op"]
            );
            if let Some(error) = step["expect"].get("error") {
                let e = result.expect_err(&label);
                assert_eq!(serde_json::to_value(e).unwrap(), *error, "{label}");
                if e != ModelError::ClockFault {
                    assert_eq!(model.stats(), before, "non-atomic {label}");
                }
            } else {
                let (kind, value) = result.unwrap_or_else(|e| panic!("{label}: {e}"));
                assert_eq!(kind, step["expect"]["kind"], "{label}");
                if let Some(recipe) = step["expect"].get("document") {
                    let expected = document(all, recipe);
                    assert!(
                        value.as_ref().is_some_and(|v| same_value(v, &expected)),
                        "{label}: actual {value:?}, expected {expected}"
                    );
                    let v = value.unwrap();
                    if v.get("kind").is_none() {
                        RecordingWireStateFrame::from_value(json!({"version":1,"kind":"recordingWireStateFrame","subscriptionRef":"validation","snapshot":v})).unwrap();
                    } else if v["kind"].as_str().unwrap().starts_with("recordingWire") {
                        validate_recording_wire(&v).unwrap();
                    } else {
                        validate_recording_admission(&v).unwrap();
                    }
                }
                if kind == "Pending" || kind == "Replay" {
                    assert_eq!(model.stats(), before, "replay allocated {label}");
                }
            }
            if let Some(fields) = step["fields"].as_object() {
                let stats = serde_json::to_value(model.stats()).unwrap();
                for (k, v) in fields {
                    assert_eq!(&stats[k], v, "{label}: {k}");
                }
            }
        }
        if managed {
            let before = domain.stats();
            let saved = domain
                .scope(domain_ticket.as_ref().unwrap(), &s)
                .unwrap()
                .stats();
            let replay = domain
                .register(DomainRegistration {
                    resource: SimulatedResourceId::new("scenario").unwrap(),
                    session: s.clone(),
                    limits: limits(&scenario["limits"]),
                    mode,
                })
                .unwrap();
            assert_eq!(domain.stats(), before);
            assert_eq!(domain.scope(&replay, &s).unwrap().stats(), saved);
        }
    }
}
fn initial() -> (RegistryModel, ModelSession, Value) {
    let f = fixtures();
    let s = session(&f, &Value::Null);
    (
        RegistryModel::new(s.clone(), ModelLimits::default()).unwrap(),
        s,
        f,
    )
}
fn start(m: &mut RegistryModel, s: &ModelSession, f: &Value) -> SimulationTicket {
    m.issue_lease(
        s,
        RecordingWireLeaseRequest::from_value(f["bases"]["lease"].clone()).unwrap(),
    )
    .unwrap();
    match m
        .begin_admission(
            s,
            RecordingAdmissionRequest::from_value(f["bases"]["admit"].clone()).unwrap(),
        )
        .unwrap()
    {
        AdmissionStart::Registered { ticket } => ticket,
        _ => panic!("first registration"),
    }
}
