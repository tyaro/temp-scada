use super::*;
mod boundaries;
mod observation_boundaries;
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
fn assert_scenarios(all: &Value) {
    for scenario in all["scenarios"].as_array().unwrap() {
        let mut model =
            RegistryModel::new(session(all, &Value::Null), limits(&scenario["limits"])).unwrap();
        let mut tickets = BTreeMap::new();
        let mut handles = BTreeMap::new();
        for (index, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let before = model.stats();
            let s = session(all, &step["session"]);
            let input = if step.get("input").is_some() {
                document(all, &step["input"])
            } else {
                Value::Null
            };
            let alias = step["ticket"].as_str().unwrap_or("a");
            let label = format!("{} step {} {}", scenario["name"], index, step["op"]);
            let result: Result<(&str, Option<Value>), ModelError> = (|| {
                Ok(match step["op"].as_str().unwrap() {
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
                        model.advance_to(ModelInstant(
                            step["nowMs"].as_str().unwrap().parse().unwrap(),
                        ))?;
                        ("ok", None)
                    }
                    "close" => {
                        model.close();
                        ("ok", None)
                    }
                    "stats" => ("ok", None),
                    _ => panic!("unknown scenario command"),
                })
            })();
            let label = format!("{} step {} {}", scenario["name"], index, step["op"]);
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
                    if v["kind"].as_str().unwrap().starts_with("recordingWire") {
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
