use super::*;
use serde_json::json;
fn fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../../examples/recording-admission-cases.json"
    ))
    .unwrap()
}
fn input(all: &Value, row: &Value) -> Result<Value, serde_json::Error> {
    if let Some(raw) = row["json"].as_str() {
        return serde_json::from_str(raw);
    }
    let mut value = all["bases"][row["base"].as_str().unwrap()].clone();
    patch(&mut value, row);
    Ok(value)
}
fn patch(value: &mut Value, row: &Value) {
    if let Some(rows) = row["patch"].as_array() {
        for p in rows {
            let (parent, key) = p["path"].as_str().unwrap().rsplit_once('/').unwrap();
            let target = value.pointer_mut(parent).unwrap();
            if p["remove"] == true {
                target.as_object_mut().unwrap().remove(key);
            } else if let Some(obj) = target.as_object_mut() {
                obj.insert(key.into(), p["value"].clone());
            } else {
                target[key.parse::<usize>().unwrap()] = p["value"].clone();
            }
        }
    }
}
fn owned(value: Value) -> Value {
    macro_rules! parse {
        ($t:ident) => {
            $t::from_value(value).unwrap().as_value().clone()
        };
    }
    match value["kind"].as_str().unwrap() {
        "recordingAdmissionRequest" => parse!(RecordingAdmissionRequest),
        "recordingAdmissionReply" => parse!(RecordingAdmissionReply),
        "recordingAdmissionInspectionRequest" => parse!(RecordingAdmissionInspectionRequest),
        "recordingAdmissionInspectionReply" => parse!(RecordingAdmissionInspectionReply),
        "recordingReconciliationDelivery" => parse!(RecordingReconciliationDelivery),
        _ => panic!("fixture kind"),
    }
}
#[test]
fn shared_acceptance_and_owned_roundtrip() {
    let all = fixtures();
    for row in all["cases"].as_array().unwrap() {
        let value = input(&all, row);
        let accepted = value
            .as_ref()
            .is_ok_and(|v| validate_recording_admission(v).is_ok());
        assert_eq!(
            accepted,
            row["accepted"].as_bool().unwrap(),
            "{}",
            row["name"]
        );
        if accepted {
            let value = value.unwrap();
            assert_eq!(owned(value.clone()), value);
            assert!(validate_recording_admission(
                &serde_json::from_str::<Value>(&value.to_string()).unwrap()
            )
            .is_ok());
        }
    }
}
#[test]
fn shared_full_request_equality() {
    let all = fixtures();
    for row in all["equalities"].as_array().unwrap() {
        let a = all["bases"][row["base"].as_str().unwrap()].clone();
        let b = input(&all, row).unwrap();
        let same = if a["kind"] == "recordingAdmissionRequest" {
            same_recording_admission_request(
                &RecordingAdmissionRequest::from_value(a).unwrap(),
                &RecordingAdmissionRequest::from_value(b).unwrap(),
            )
        } else {
            same_recording_admission_inspection_request(
                &RecordingAdmissionInspectionRequest::from_value(a).unwrap(),
                &RecordingAdmissionInspectionRequest::from_value(b).unwrap(),
            )
        };
        assert_eq!(same, row["expected"].as_bool().unwrap(), "{}", row["name"]);
    }
}
#[test]
fn shared_known_document_correlation() {
    let all = fixtures();
    for row in all["matches"].as_array().unwrap() {
        let mut left = all["bases"][row["left"].as_str().unwrap()].clone();
        patch(&mut left, row);
        let right = all["bases"][row["right"].as_str().unwrap()].clone();
        let same = match row["check"].as_str().unwrap() {
            "reply" => recording_admission_reply_matches_request(
                &RecordingAdmissionReply::from_value(left).unwrap(),
                &RecordingAdmissionRequest::from_value(right).unwrap(),
            ),
            "inspection" => recording_admission_inspection_reply_matches_request(
                &RecordingAdmissionInspectionReply::from_value(left).unwrap(),
                &RecordingAdmissionInspectionRequest::from_value(right).unwrap(),
            ),
            _ => recording_reconciliation_delivery_matches_admission(
                &RecordingReconciliationDelivery::from_value(left).unwrap(),
                &RecordingAdmissionReply::from_value(right).unwrap(),
            ),
        };
        assert_eq!(same, row["expected"].as_bool().unwrap(), "{}", row["name"]);
    }
}
#[test]
fn shared_conservative_accounting_boundaries() {
    let all = fixtures();
    for row in all["accounting"].as_array().unwrap() {
        let count = row["count"].as_u64().unwrap_or(0) as usize;
        let value = match row["build"].as_str() {
            Some("string") => json!(row["unit"].as_str().unwrap_or("x").repeat(count)),
            Some("array") => json!(vec![Value::Null; count]),
            Some("depth") => (0..count).fold(Value::Null, |v, _| json!([v])),
            _ => row["input"].clone(),
        };
        let mut budget = JsonBudget::admission_with_limits(
            row["bytes"].as_u64().unwrap() as usize,
            row["nodes"].as_u64().unwrap() as usize,
        );
        assert_eq!(
            budget.visit(&value, 0).is_ok(),
            row["accepted"].as_bool().unwrap(),
            "{}",
            row["name"]
        );
    }
}
#[test]
fn independent_h5a_and_d3_validation() {
    let all = fixtures();
    for row in crate::recording_plan::tests::cases().as_array().unwrap() {
        let accepted = crate::recording_plan::tests::input(row).is_ok_and(|desired| {
            let mut v = all["bases"]["discard"].clone();
            let enabled = desired["enabled"] == true;
            v["action"]["change"]["apply"]["desired"] = desired;
            v["action"]["change"]["apply"]["expectedMappingRevision"] =
                if enabled { json!(11) } else { Value::Null };
            v["action"]["change"]["apply"]["expectedRetentionAppliedRevision"] =
                if enabled { json!(13) } else { Value::Null };
            validate_recording_admission(&v).is_ok()
        });
        assert_eq!(accepted, row["accepted"] == true, "H5a {}", row["name"]);
    }
    let management: Value = serde_json::from_str(include_str!(
        "../../../../examples/recording-management-cases.json"
    ))
    .unwrap();
    for row in management["cases"].as_array().unwrap() {
        let target = crate::recording_operations::tests::input(&management, row);
        let expected = row["accepted"] == true
            && target
                .as_ref()
                .is_ok_and(|t| t["kind"] == "recordingManagementContext");
        let accepted = target.is_ok_and(|target| {
            let mut v = all["bases"]["discard"].clone();
            v["context"]["target"] = target.clone();
            v["action"]["change"]["context"]["target"] = target;
            validate_recording_admission(&v).is_ok()
        });
        assert_eq!(accepted, expected, "d3 {}", row["name"]);
    }
}
#[test]
fn independent_d4a_validation_in_all_relevant_roots() {
    let all = fixtures();
    let old: Value = serde_json::from_str(include_str!(
        "../../../../examples/recording-operations-cases.json"
    ))
    .unwrap();
    for row in old["cases"].as_array().unwrap() {
        let Some(base) = row["base"].as_str() else {
            continue;
        };
        if ![
            "context",
            "change",
            "operation",
            "reconciliation",
            "reconciliationResult",
        ]
        .contains(&base)
        {
            continue;
        }
        let accepted=crate::recording_operations::tests::input(&old,row).is_ok_and(|input|{let mut v=all["bases"]["discard"].clone();match base{
 "context"=>{v["context"]=input.clone();v["action"]["change"]["context"]=input;},
 "change"=>{v["context"]=input["context"].clone();v["action"]["change"]=input;},
 "reconciliation"=>{v["context"]=input["operation"]["change"]["context"].clone();v["action"]=json!({"kind":"reconcile","changeRef":"change-ref","operationRef":"operation-ref","reconciliation":input});},
 "reconciliationResult"=>{v=all["bases"]["delivery"].clone();v["request"]=input["request"].clone();v["outcome"]["result"]=input;},
 _=>{v=all["bases"]["preflightReply"].clone();if input["stage"]=="preflight"{v["request"]["action"]["change"]=input["change"].clone();}else{v["request"]["action"]=json!({"kind":input["stage"],"changeRef":"change-ref","operation":input});}v["request"]["context"]=input["change"]["context"].clone();v["outcome"]["handle"]["request"]=input;}
 }validate_recording_admission(&v).is_ok()});
        assert_eq!(accepted, row["accepted"] == true, "d4a {}", row["name"]);
    }
}
#[test]
fn worst_reply_capacity_is_checked_before_dispatch_and_exact_at_reduced_limit() {
    let all = fixtures();
    for row in all["capacity"].as_array().unwrap() {
        let request = RecordingAdmissionRequest::from_value(
            all["bases"][row["base"].as_str().unwrap()].clone(),
        )
        .unwrap();
        assert!(validate_recording_admission_reply_capacity(&request).is_ok());
        let bytes = row["maxBytes"].as_u64().unwrap() as usize;
        let nodes = row["maxNodes"].as_u64().unwrap() as usize;
        let mut branches = 0;
        capacity::check_with(request.as_value(), |value| {
            branches += 1;
            JsonBudget::admission_with_limits(bytes, nodes)
                .visit(value, 0)
                .map_err(|_| RecordingAdmissionError)
        })
        .unwrap();
        assert_eq!(branches, row["branches"].as_u64().unwrap());
        for (bytes, nodes) in [(bytes - 1, nodes), (bytes, nodes - 1)] {
            let mut failed_branch = None;
            assert!(capacity::check_with(request.as_value(), |value| {
                let result = JsonBudget::admission_with_limits(bytes, nodes)
                    .visit(value, 0)
                    .map_err(|_| RecordingAdmissionError);
                if result.is_err() {
                    failed_branch = Some((value["kind"].clone(), value["outcome"]["kind"].clone()));
                }
                result
            })
            .is_err());
            assert_eq!(
                failed_branch,
                Some((json!("recordingAdmissionInspectionReply"), json!("found")))
            );
            assert!(JsonBudget::admission_with_limits(bytes, nodes)
                .visit(request.as_value(), 0)
                .is_ok());
        }
    }
}
#[test]
fn local_resources_and_exact_owned_kinds() {
    let root: Value = serde_json::from_str(RECORDING_ADMISSION_SCHEMA).unwrap();
    assert!(jsonschema::options()
        .with_retriever(BundledOnly)
        .build(&root)
        .is_err());
    let all = fixtures();
    let bases = [
        "preflight",
        "preflightReply",
        "preflightInspection",
        "preflightFound",
        "delivery",
    ];
    let constructors: [fn(Value) -> bool; 5] = [
        |v| RecordingAdmissionRequest::from_value(v).is_ok(),
        |v| RecordingAdmissionReply::from_value(v).is_ok(),
        |v| RecordingAdmissionInspectionRequest::from_value(v).is_ok(),
        |v| RecordingAdmissionInspectionReply::from_value(v).is_ok(),
        |v| RecordingReconciliationDelivery::from_value(v).is_ok(),
    ];
    for (i, ctor) in constructors.iter().enumerate() {
        for (j, base) in bases.iter().enumerate() {
            assert_eq!(ctor(all["bases"][base].clone()), i == j);
        }
    }
    assert_eq!(
        RecordingAdmissionError.to_string(),
        "Recording admission: invalid"
    );
}
