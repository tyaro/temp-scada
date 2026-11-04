use super::*;
fn fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../../examples/recording-wire-cases.json"
    ))
    .unwrap()
}
fn input(all: &Value, row: &Value) -> Result<Value, serde_json::Error> {
    crate::recording_operations::tests::input(all, row)
}
fn owned(v: Value) -> Value {
    macro_rules! parse {
        ($t:ident) => {
            $t::from_value(v).unwrap().as_value().clone()
        };
    }
    match v["kind"].as_str().unwrap() {
        "recordingWireLeaseRequest" => parse!(RecordingWireLeaseRequest),
        "recordingWireLeaseReply" => parse!(RecordingWireLeaseReply),
        "recordingWireObservationRequest" => parse!(RecordingWireObservationRequest),
        "recordingWireObservationReply" => parse!(RecordingWireObservationReply),
        "recordingWireCancelRequest" => parse!(RecordingWireCancelRequest),
        "recordingWireCancelReply" => parse!(RecordingWireCancelReply),
        "recordingWireAttachRequest" => parse!(RecordingWireAttachRequest),
        "recordingWireAttachReply" => parse!(RecordingWireAttachReply),
        "recordingWireStateFrame" => parse!(RecordingWireStateFrame),
        "recordingWireControlRequest" => parse!(RecordingWireControlRequest),
        "recordingWireControlReply" => parse!(RecordingWireControlReply),
        "recordingWireControlFrame" => parse!(RecordingWireControlFrame),
        "recordingWireCallInspectionRequest" => parse!(RecordingWireCallInspectionRequest),
        "recordingWireCallInspectionReply" => parse!(RecordingWireCallInspectionReply),
        _ => panic!("fixture kind"),
    }
}
#[test]
fn shared_acceptance_and_owned_roundtrip() {
    let all = fixtures();
    for row in all["cases"].as_array().unwrap() {
        let v = input(&all, row);
        let accepted = v.as_ref().is_ok_and(|v| validate_recording_wire(v).is_ok());
        assert_eq!(accepted, row["accepted"] == true, "{}", row["name"]);
        if accepted {
            let v = v.unwrap();
            assert_eq!(owned(v.clone()), v);
            assert!(validate_recording_wire(
                &serde_json::from_str::<Value>(&v.to_string()).unwrap()
            )
            .is_ok());
        }
    }
}
#[test]
fn full_equality_and_correlation() {
    let all = fixtures();
    for row in all["equalities"].as_array().unwrap() {
        let a =
            RecordingWireDocument::from_value(all["bases"][row["base"].as_str().unwrap()].clone())
                .unwrap();
        let b = RecordingWireDocument::from_value(input(&all, row).unwrap()).unwrap();
        assert_eq!(
            same_recording_wire_request(&a, &b),
            row["expected"] == true,
            "{}",
            row["name"]
        );
    }
    for row in all["matches"].as_array().unwrap() {
        let mut recipe = row.clone();
        recipe["base"] = row["left"].clone();
        let a = RecordingWireDocument::from_value(input(&all, &recipe).unwrap()).unwrap();
        let b =
            RecordingWireDocument::from_value(all["bases"][row["right"].as_str().unwrap()].clone())
                .unwrap();
        let same = if row["check"] == "reply" {
            recording_wire_reply_matches_request(&a, &b)
        } else {
            recording_wire_frame_matches_subscription(&a, &b)
        };
        assert_eq!(same, row["expected"] == true, "{}", row["name"]);
    }
}
fn bound(v: &Value) -> WireBound {
    WireBound {
        bytes: v["bytes"].as_u64().unwrap() as usize,
        nodes: v["nodes"].as_u64().unwrap() as usize,
        depth: v["depth"].as_u64().unwrap() as usize,
    }
}
fn smaller(b: WireBound, key: usize) -> WireBound {
    match key {
        0 => WireBound {
            bytes: b.bytes - 1,
            ..b
        },
        1 => WireBound {
            nodes: b.nodes - 1,
            ..b
        },
        _ => WireBound {
            depth: b.depth - 1,
            ..b
        },
    }
}
#[test]
fn capacity_closure_all_dimensions() {
    let all = fixtures();
    for row in all["capacity"].as_array().unwrap() {
        let q =
            RecordingWireDocument::from_value(all["bases"][row["base"].as_str().unwrap()].clone())
                .unwrap();
        let u = recording_wire_reply_capacity(&q).unwrap();
        let expected = bound(&row["reply"]);
        assert_eq!(u.reply, expected, "{}", row["base"]);
        assert_eq!(
            u.call_inspection,
            (!row["callInspection"].is_null()).then(|| bound(&row["callInspection"]))
        );
        let inspection = q.as_value()["kind"] == "recordingWireCallInspectionRequest";
        assert!(capacity::check(
            q.as_value(),
            if inspection {
                WIRE_REPLY_LIMIT
            } else {
                expected
            },
            if inspection {
                expected
            } else {
                u.call_inspection.unwrap_or(WIRE_INSPECTION_REPLY_LIMIT)
            }
        )
        .is_ok());
        for key in 0..3 {
            let low = smaller(expected, key);
            assert!(capacity::check(
                q.as_value(),
                if inspection { WIRE_REPLY_LIMIT } else { low },
                if inspection {
                    low
                } else {
                    WIRE_INSPECTION_REPLY_LIMIT
                }
            )
            .is_err());
            if let Some(b) = u.call_inspection {
                assert!(capacity::check(q.as_value(), WIRE_REPLY_LIMIT, smaller(b, key)).is_err());
            }
        }
    }
    for row in all["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["accepted"] == true)
    {
        let v = input(&all, row).unwrap();
        if v["request"].is_null() || is_request(&v) {
            continue;
        }
        let q = RecordingWireDocument::from_value(v["request"].clone()).unwrap();
        let u = recording_wire_reply_capacity(&q).unwrap().reply;
        let m = measure(&v, profile(v["kind"].as_str().unwrap())).unwrap();
        assert!(
            m.bytes <= u.bytes && m.nodes <= u.nodes && m.depth <= u.depth,
            "{}",
            row["name"]
        );
    }
}
#[test]
fn shared_conservative_boundaries() {
    let all = fixtures();
    for row in all["accounting"].as_array().unwrap() {
        let v = if row["build"] == "string" {
            json!("x".repeat(row["count"].as_u64().unwrap() as usize))
        } else if row["build"] == "array" {
            json!(vec![Value::Null; row["count"].as_u64().unwrap() as usize])
        } else if row["build"] == "depth" {
            (0..row["count"].as_u64().unwrap()).fold(Value::Null, |v, _| json!([v]))
        } else {
            row["input"].clone()
        };
        assert_eq!(
            measure(&v, bound(row)).is_ok(),
            row["accepted"] == true,
            "{}",
            row["name"]
        );
    }
}
fn wrap(v: Value, default_scope: &Value) -> Value {
    let is_reply = v["kind"].as_str().is_some_and(|k| k.ends_with("Reply"));
    let q = if is_reply { &v["request"] } else { &v };
    let original = if q["kind"] == "recordingAdmissionInspectionRequest" {
        &q["original"]
    } else {
        q
    };
    let mut s = default_scope.clone();
    if !original["ownerRef"].is_null() {
        s["ownerRef"] = original["ownerRef"].clone();
    }
    if !original["context"].is_null() {
        s["context"] = original["context"].clone();
    }
    if v["kind"] == "recordingReconciliationDelivery" {
        s["ownerRef"] = v["ownerRef"].clone();
        s["context"] = v["request"]["operation"]["change"]["context"].clone();
        let request = json!({"version":1,"kind":"recordingWireObservationRequest","scope":s,"observationId":"nested","target":{"kind":"reconciliation","readRef":v["readRef"],"request":v["request"]}});
        return json!({"version":1,"kind":"recordingWireObservationReply","request":request,"outcome":{"kind":"reconciliation","delivery":v}});
    }
    let request = json!({"version":1,"kind":"recordingWireCallInspectionRequest","scope":s,"callInspectionId":"nested","original":q});
    if is_reply {
        json!({"version":1,"kind":"recordingWireCallInspectionReply","request":request,"outcome":{"kind":"terminal","reply":v}})
    } else {
        request
    }
}
#[test]
fn independent_legacy_contracts() {
    let f = fixtures();
    let scope = &f["bases"]["lease"]["scope"];
    let a: Value = serde_json::from_str(include_str!(
        "../../../../examples/recording-admission-cases.json"
    ))
    .unwrap();
    for row in a["cases"].as_array().unwrap() {
        let accepted =
            input(&a, row).is_ok_and(|v| validate_recording_wire(&wrap(v, scope)).is_ok());
        assert_eq!(accepted, row["accepted"] == true, "c4a {}", row["name"]);
    }
    for row in crate::recording_plan::tests::cases().as_array().unwrap() {
        let accepted = crate::recording_plan::tests::input(row).is_ok_and(|desired| {
            let enabled = desired["enabled"] == true;
            let mut v = a["bases"]["discard"].clone();
            v["action"]["change"]["apply"]["desired"] = desired;
            v["action"]["change"]["apply"]["expectedMappingRevision"] =
                if enabled { json!(11) } else { Value::Null };
            v["action"]["change"]["apply"]["expectedRetentionAppliedRevision"] =
                if enabled { json!(13) } else { Value::Null };
            validate_recording_wire(&wrap(v, scope)).is_ok()
        });
        assert_eq!(accepted, row["accepted"] == true, "H5a {}", row["name"]);
    }
    let m: Value = serde_json::from_str(include_str!(
        "../../../../examples/recording-management-cases.json"
    ))
    .unwrap();
    for row in m["cases"].as_array().unwrap() {
        let accepted = input(&m, row).is_ok_and(|target| {
            let mut v = a["bases"]["discard"].clone();
            v["context"]["target"] = target.clone();
            v["action"]["change"]["context"]["target"] = target;
            validate_recording_wire(&wrap(v, scope)).is_ok()
        });
        assert_eq!(
            accepted,
            row["accepted"] == true && row["base"] == "context",
            "d3 {}",
            row["name"]
        );
    }
}
#[test]
fn compact_to_conservative_conversion() {
    for v in [
        json!(vec![0; 8191]),
        json!("\n".repeat(120000)),
        json!({"a":[-0.0,1e20,1e-20,"😀\r\t"]}),
    ] {
        let mut compact = JsonBudget::new(256 * 1024, 8192);
        compact.visit(&v, 0).unwrap();
        let (bytes, nodes, _) = compact.metrics();
        let wire = measure(
            &v,
            WireBound {
                bytes: 1024 * 1024,
                nodes: 8192,
                depth: 32,
            },
        )
        .unwrap();
        assert!(wire.bytes <= 3 * bytes + 21 * nodes);
    }
    let f = fixtures();
    assert!(recording_wire_original_capacity(
        f["bases"]["lease"]["scope"].clone(),
        f["bases"]["legacy"]["original"].clone()
    )
    .is_ok());
    assert!(RecordingWireCancelRequest::from_value(f["bases"]["lease"].clone()).is_err());
}

#[test]
fn structural_meter_shares_profiles_and_cannot_raise_traversal_limits() {
    let all = fixtures();
    for row in all["accounting"].as_array().unwrap() {
        let count = row["count"].as_u64().unwrap_or(0) as usize;
        let v = match row["build"].as_str() {
            Some("string") => json!("x".repeat(count)),
            Some("array") => json!(vec![Value::Null; count]),
            Some("depth") => (0..count).fold(Value::Null, |v, _| json!([v])),
            _ => row["input"].clone(),
        };
        assert_eq!(
            conservative_recording_json_bound(&v, bound(row)).is_ok(),
            row["accepted"] == true,
            "{}",
            row["name"]
        );
    }
    for limit in [
        WireBound {
            bytes: WIRE_INSPECTION_REPLY_LIMIT.bytes + 1,
            ..WIRE_INSPECTION_REPLY_LIMIT
        },
        WireBound {
            nodes: WIRE_INSPECTION_REPLY_LIMIT.nodes + 1,
            ..WIRE_INSPECTION_REPLY_LIMIT
        },
        WireBound {
            depth: 97,
            ..WIRE_INSPECTION_REPLY_LIMIT
        },
    ] {
        assert!(conservative_recording_json_bound(&Value::Null, limit).is_err());
    }
}
