use super::*;
use scada_model::recording_operations::RecordingOperationResult;
fn subscription_fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../examples/recording-subscription-model-cases.json"
    ))
    .unwrap()
}
#[test]
fn projection_exact_and_one_below_are_atomic_in_all_dimensions() {
    let (_, s, f) = initial();
    let q = RecordingAdmissionRequest::from_value(f["bases"]["admit"].clone()).unwrap();
    let (m, _, _) = initial();
    let b = m
        .projection_bound(m.admission_projection(&q).unwrap())
        .unwrap();
    for smaller in [
        None,
        Some(WireBound {
            bytes: b.bytes - 1,
            ..b
        }),
        Some(WireBound {
            nodes: b.nodes - 1,
            ..b
        }),
        Some(WireBound {
            depth: b.depth - 1,
            ..b
        }),
    ] {
        let mut m = RegistryModel::new(
            s.clone(),
            ModelLimits {
                projection_limit: smaller.unwrap_or(b),
                ..Default::default()
            },
        )
        .unwrap();
        m.issue_lease(
            &s,
            RecordingWireLeaseRequest::from_value(f["bases"]["lease"].clone()).unwrap(),
        )
        .unwrap();
        let before = m.stats();
        let seq = m.sequence;
        if smaller.is_none() {
            assert!(matches!(
                m.begin_admission(&s, q.clone()),
                Ok(AdmissionStart::Registered { .. })
            ));
        } else {
            assert!(matches!(
                m.begin_admission(&s, q.clone()),
                Err(ModelError::Capacity)
            ));
            assert_eq!(m.stats(), before);
            assert_eq!(m.sequence, seq);
            assert!(!m.leases.values().next().unwrap().consumed);
        }
    }
}
#[test]
fn new_limits_shrink_only_and_initial_descriptor_has_reserved_read_bytes() {
    let (_, s, _) = initial();
    for l in [
        ModelLimits {
            live_subscriptions: 5,
            ..Default::default()
        },
        ModelLimits {
            attach_requests: 4097,
            ..Default::default()
        },
        ModelLimits {
            control_requests: 4097,
            ..Default::default()
        },
        ModelLimits {
            revision_ceiling: 1,
            ..Default::default()
        },
        ModelLimits {
            revision_ceiling: projection::MAX_REVISION + 1,
            ..Default::default()
        },
        ModelLimits {
            projection_limit: WireBound {
                bytes: WIRE_SNAPSHOT_LIMIT.bytes + 1,
                ..WIRE_SNAPSHOT_LIMIT
            },
            ..Default::default()
        },
        ModelLimits {
            projection_limit: WireBound {
                nodes: WIRE_SNAPSHOT_LIMIT.nodes + 1,
                ..WIRE_SNAPSHOT_LIMIT
            },
            ..Default::default()
        },
        ModelLimits {
            projection_limit: WireBound {
                depth: 65,
                ..WIRE_SNAPSHOT_LIMIT
            },
            ..Default::default()
        },
    ] {
        assert!(matches!(
            RegistryModel::new(s.clone(), l),
            Err(ModelError::InvalidInput)
        ));
    }
    assert!(matches!(
        RegistryModel::new(
            s,
            ModelLimits {
                read_bytes: 1023,
                ..Default::default()
            }
        ),
        Err(ModelError::Capacity)
    ));
}
#[test]
fn subscription_counter_overflow_cannot_allocate_or_renumber_native_ids() {
    let (mut m, s, _) = initial();
    m.subscription_sequence = u64::MAX;
    let q =
        RecordingWireAttachRequest::from_value(subscription_fixtures()["bases"]["attach"].clone())
            .unwrap();
    let before = m.stats();
    let seq = m.sequence;
    assert!(matches!(m.attach(&s, q), Err(ModelError::Capacity)));
    assert_eq!(m.stats(), before);
    assert_eq!(m.sequence, seq);
}
#[test]
fn live_slot_refund_occurs_once_and_saved_snapshot_never_changes() {
    let (mut m, s, _) = initial();
    let f = subscription_fixtures();
    let a = RecordingWireAttachRequest::from_value(f["bases"]["attach"].clone()).unwrap();
    let original = m.attach(&s, a.clone()).unwrap();
    let d = RecordingWireControlRequest::from_value(f["bases"]["detach"].clone()).unwrap();
    m.control(&s, d.clone()).unwrap();
    let after = m.stats();
    m.control(&s, d).unwrap();
    assert_eq!(m.stats(), after);
    m.close().unwrap();
    assert_eq!(m.attach(&s, a).unwrap().as_value(), original.as_value());
}
#[test]
fn finite_operation_branches_fit_the_request_based_projection_envelope() {
    let old: Value = serde_json::from_str(include_str!(
        "../../../../../examples/recording-operations-cases.json"
    ))
    .unwrap();
    let f = subscription_fixtures();
    let mut checked = 0;
    for row in old["cases"].as_array().unwrap().iter().filter(|r| {
        r["accepted"] == true
            && r["base"].is_string()
            && r.get("json").is_none()
            && r.get("build").is_none()
    }) {
        let result = document(&old, row);
        let Ok(result) = RecordingOperationResult::from_value(result) else {
            continue;
        };
        let r = result.as_value();
        let request = &r["request"];
        let stage = request["stage"].as_str().unwrap();
        let mut q = f["bases"]["opAdmit"].clone();
        q["context"] = request["change"]["context"].clone();
        q["action"] = if stage == "preflight" {
            json!({"kind":"preflight","change":request["change"]})
        } else {
            json!({"kind":stage,"changeRef":"r".repeat(64),"operation":request})
        };
        let Ok(q) = RecordingAdmissionRequest::from_value(q) else {
            continue;
        };
        let mut scope = f["scope"].clone();
        scope["context"] = q.as_value()["context"].clone();
        let s = ModelSession::new(scope, SimulatedPrincipal::new("p").unwrap()).unwrap();
        let m = RegistryModel::new(s, Default::default()).unwrap();
        let bounds = m.admission_projection(&q).unwrap();
        let actual = conservative_recording_json_bound(r, WIRE_INSPECTION_REPLY_LIMIT).unwrap();
        assert!(
            projection::fits_bound(actual, bounds.operation),
            "{}",
            row["name"]
        );
        let reply=RecordingAdmissionReply::from_value(json!({"version":1,"kind":"recordingAdmissionReply","request":q.as_value(),"outcome":{"kind":"accepted","handle":{"kind":"operation","changeRef":q.as_value()["action"].get("changeRef").cloned().unwrap_or(json!("r".repeat(64))),"operationRef":"r".repeat(64),"request":request}}})).unwrap();
        assert!(projection::fits_bound(
            conservative_recording_json_bound(reply.as_value(), WIRE_INSPECTION_REPLY_LIMIT)
                .unwrap(),
            bounds.admission
        ));
        checked += 1;
    }
    assert!(checked > 50, "insufficient real schema branches: {checked}");
}
#[test]
fn finite_read_branches_fit_delivery_and_admission_envelopes() {
    let old: Value = serde_json::from_str(include_str!(
        "../../../../../examples/recording-admission-cases.json"
    ))
    .unwrap();
    let f = subscription_fixtures();
    let mut checked = 0;
    for row in old["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["accepted"] == true && r["base"].is_string() && r.get("json").is_none())
    {
        let v = document(&old, row);
        let Ok(delivery) = RecordingReconciliationDelivery::from_value(v) else {
            continue;
        };
        let d = delivery.as_value();
        let mut q = f["bases"]["readAdmit"].clone();
        q["context"] = d["request"]["operation"]["change"]["context"].clone();
        q["action"] = json!({"kind":"reconcile","changeRef":"r".repeat(64),"operationRef":"r".repeat(64),"reconciliation":d["request"]});
        let Ok(q) = RecordingAdmissionRequest::from_value(q) else {
            continue;
        };
        let mut scope = f["scope"].clone();
        scope["context"] = q.as_value()["context"].clone();
        let s = ModelSession::new(scope, SimulatedPrincipal::new("p").unwrap()).unwrap();
        let m = RegistryModel::new(s, Default::default()).unwrap();
        let b = m.admission_projection(&q).unwrap();
        assert!(
            projection::fits_bound(
                conservative_recording_json_bound(d, WIRE_INSPECTION_REPLY_LIMIT).unwrap(),
                b.read
            ),
            "{}",
            row["name"]
        );
        let reply = RecordingAdmissionReply::from_value(json!({"version":1,"kind":"recordingAdmissionReply","request":q.as_value(),"outcome":{"kind":"accepted","handle":{"kind":"reconciliation","readRef":"r".repeat(64),"request":d["request"]}}})).unwrap();
        assert!(projection::fits_bound(
            conservative_recording_json_bound(reply.as_value(), WIRE_INSPECTION_REPLY_LIMIT)
                .unwrap(),
            b.admission
        ));
        checked += 1;
    }
    assert_eq!(checked, 3, "delivery and both finite readUncertain errors");
}
