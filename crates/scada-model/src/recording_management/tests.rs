use super::*;
use crate::recording_plan::{tests as plan_cases, DesiredRecordingPlan};
use serde_json::json;
fn fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../../examples/recording-management-cases.json"
    ))
    .unwrap()
}
fn input(all: &Value, row: &Value) -> Result<Value, serde_json::Error> {
    if row.get("json").is_some() || row.get("build").is_some() {
        return plan_cases::input(row);
    }
    let mut value = all["bases"][row["base"].as_str().unwrap()].clone();
    if let Some(patches) = row["patch"].as_array() {
        for patch in patches {
            let path = patch["path"].as_str().unwrap();
            if patch["remove"] == true {
                let (parent, key) = path.rsplit_once('/').unwrap();
                value
                    .pointer_mut(parent)
                    .unwrap()
                    .as_object_mut()
                    .unwrap()
                    .remove(key);
            } else {
                let (parent, key) = path.rsplit_once('/').unwrap();
                let target = value.pointer_mut(parent).unwrap();
                if let Some(obj) = target.as_object_mut() {
                    obj.insert(key.into(), patch["value"].clone());
                } else {
                    target[key.parse::<usize>().unwrap()] = patch["value"].clone();
                }
            }
        }
    }
    Ok(value)
}
#[test]
fn shared_management_acceptance_and_owned_roundtrip() {
    let all = fixtures();
    for row in all["cases"].as_array().unwrap() {
        let parsed = input(&all, row);
        let accepted = parsed
            .as_ref()
            .is_ok_and(|v| validate_recording_management(v).is_ok());
        assert_eq!(
            accepted,
            row["accepted"].as_bool().unwrap(),
            "{}",
            row["name"]
        );
        if accepted {
            let value = parsed.unwrap();
            match value["kind"].as_str().unwrap() {
                "recordingManagementContext" => {
                    assert_eq!(
                        RecordingManagementContext::from_value(value.clone())
                            .unwrap()
                            .as_value(),
                        &value
                    );
                }
                "recordingInspectionRequest" => {
                    assert_eq!(
                        RecordingInspectionRequest::from_value(value.clone())
                            .unwrap()
                            .as_value(),
                        &value
                    );
                }
                "recordingInspectionResponse" => {
                    assert_eq!(
                        RecordingInspectionResponse::from_value(value.clone())
                            .unwrap()
                            .as_value(),
                        &value
                    );
                }
                _ => panic!("fixture kind"),
            }
            let roundtrip: Value = serde_json::from_str(&value.to_string()).unwrap();
            assert!(validate_recording_management(&roundtrip).is_ok());
        }
    }
}
#[test]
fn all_h5a_fixtures_keep_independent_validation_when_nested() {
    let all = fixtures();
    for row in plan_cases::cases().as_array().unwrap() {
        let actual = plan_cases::input(row).is_ok_and(|desired| {
            let mut value = all["bases"]["active"].clone();
            value["database"]["latestActivation"] = Value::Null;
            value["database"]["activeSessionId"] = Value::Null;
            let enabled = desired["enabled"] == true;
            let applied = &mut value["database"]["applied"];
            applied["desired"] = desired;
            applied["mappingRevision"] = if enabled { json!(2) } else { Value::Null };
            applied["retentionAppliedRevision"] = if enabled { json!(1) } else { Value::Null };
            validate_recording_management(&value).is_ok()
        });
        assert_eq!(
            actual,
            row["accepted"].as_bool().unwrap(),
            "nested {}",
            row["name"]
        );
    }
}
#[test]
fn shared_comparison_results_preserve_original_order_and_numbers() {
    let all = fixtures();
    for row in all["comparisons"].as_array().unwrap() {
        let raw = input(&all, row).unwrap();
        let response = RecordingInspectionResponse::from_value(raw.clone()).unwrap();
        let local = row
            .get("local")
            .map(|v| DesiredRecordingPlan::from_value(v.clone()).unwrap());
        let result = compare_desired_applied(local.as_ref(), &response);
        assert_eq!(result.to_value(), row["expected"], "{}", row["name"]);
        assert_eq!(response.as_value(), &raw);
        if let Some(local) = &local {
            assert_eq!(local.as_value(), &row["local"]);
        }
    }
    let raw = all["bases"]["active"]
        .to_string()
        .replace("\"revision\":7", "\"revision\":7.0")
        .replace("\"periodMs\":1000", "\"periodMs\":1e3");
    let response =
        RecordingInspectionResponse::from_value(serde_json::from_str(&raw).unwrap()).unwrap();
    let local = DesiredRecordingPlan::from_value(
        all["bases"]["active"]["database"]["applied"]["desired"].clone(),
    )
    .unwrap();
    assert_eq!(
        compare_desired_applied(Some(&local), &response),
        DesiredAppliedComparison::Matches
    );
}
#[test]
fn shared_full_request_equality_includes_every_context_field() {
    let all = fixtures();
    let a = RecordingInspectionRequest::from_value(all["bases"]["request"].clone()).unwrap();
    for row in all["requests"].as_array().unwrap() {
        let b = RecordingInspectionRequest::from_value(input(&all, row).unwrap()).unwrap();
        assert_eq!(
            same_recording_inspection_request(&a, &b),
            row["expected"].as_bool().unwrap(),
            "{}",
            row["name"]
        );
    }
}
#[test]
fn local_resources_only_and_kind_specific_wrappers() {
    let root: Value = serde_json::from_str(RECORDING_MANAGEMENT_SCHEMA).unwrap();
    assert!(jsonschema::options()
        .with_retriever(BundledOnly)
        .build(&root)
        .is_err());
    let all = fixtures();
    assert!(RecordingManagementContext::from_value(all["bases"]["request"].clone()).is_err());
    assert!(RecordingInspectionRequest::from_value(all["bases"]["active"].clone()).is_err());
    assert!(RecordingInspectionResponse::from_value(all["bases"]["context"].clone()).is_err());
    let owned = RecordingInspectionResponse::from_value(all["bases"]["observed"].clone()).unwrap();
    let mut clone = owned.as_value().clone();
    clone["host"]["phase"] = json!("changed");
    assert_eq!(owned.as_value()["host"]["phase"], "running");
    assert_eq!(
        RecordingManagementError.to_string(),
        "Recording management: invalid"
    );
}
#[test]
fn exact_budget_edges_normalize_signed_safe_integer_spelling() {
    for (bytes, nodes) in [
        (
            MAX_RECORDING_MANAGEMENT_JSON_BYTES,
            MAX_RECORDING_MANAGEMENT_JSON_NODES,
        ),
        (
            MAX_RECORDING_INSPECTION_RESPONSE_JSON_BYTES,
            MAX_RECORDING_INSPECTION_RESPONSE_JSON_NODES,
        ),
    ] {
        assert!(JsonBudget::new(bytes, nodes)
            .visit(&json!("x".repeat(bytes - 2)), 0)
            .is_ok());
        assert!(JsonBudget::new(bytes, nodes)
            .visit(&json!("x".repeat(bytes - 1)), 0)
            .is_err());
        assert!(JsonBudget::new(bytes, nodes)
            .visit(&json!(vec![Value::Null; nodes - 1]), 0)
            .is_ok());
        assert!(JsonBudget::new(bytes, nodes)
            .visit(&json!(vec![Value::Null; nodes]), 0)
            .is_err());
    }
    let depth = (0..32).fold(Value::Null, |value, _| json!([value]));
    assert!(JsonBudget::new(131072, 4096).visit(&depth, 0).is_ok());
    assert!(JsonBudget::new(131072, 4096)
        .visit(&json!([depth]), 0)
        .is_err());
    let value: Value = serde_json::from_str("[-9.007199254740991e15,-0.0,1e3,1.0]").unwrap();
    let mut budget = JsonBudget::new(131072, 4096);
    budget.visit(&value, 0).unwrap();
    assert_eq!(budget.bytes, "[-9007199254740991,0,1000,1]".len());
}
