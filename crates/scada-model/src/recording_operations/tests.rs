use super::*;
use crate::recording_plan::tests as plan_cases;
use serde_json::json;
fn fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../../examples/recording-operations-cases.json"
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
            let (parent, key) = patch["path"].as_str().unwrap().rsplit_once('/').unwrap();
            let target = value.pointer_mut(parent).unwrap();
            if patch["remove"] == true {
                target.as_object_mut().unwrap().remove(key);
            } else if let Some(obj) = target.as_object_mut() {
                obj.insert(key.into(), patch["value"].clone());
            } else {
                target[key.parse::<usize>().unwrap()] = patch["value"].clone();
            }
        }
    }
    Ok(value)
}
fn owned(value: Value) -> Value {
    macro_rules! parse {
        ($t:ident) => {
            $t::from_value(value).unwrap().as_value().clone()
        };
    }
    match value["kind"].as_str().unwrap() {
        "recordingOperationsContext" => parse!(RecordingOperationsContext),
        "recordingChangeRequest" => parse!(RecordingChangeRequest),
        "recordingOperationRequest" => parse!(RecordingOperationRequest),
        "recordingOperationResult" => parse!(RecordingOperationResult),
        "recordingReconciliationRequest" => parse!(RecordingReconciliationRequest),
        "recordingReconciliationResult" => parse!(RecordingReconciliationResult),
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
            .is_ok_and(|v| validate_recording_operations(v).is_ok());
        assert_eq!(
            accepted,
            row["accepted"].as_bool().unwrap(),
            "{}",
            row["name"]
        );
        if accepted {
            let value = value.unwrap();
            assert_eq!(owned(value.clone()), value);
            assert!(validate_recording_operations(
                &serde_json::from_str::<Value>(&value.to_string()).unwrap()
            )
            .is_ok());
        }
    }
}
#[test]
fn all_h5a_cases_have_independent_validation_in_every_desired_envelope() {
    let all = fixtures();
    for base in [
        "change",
        "operation",
        "result",
        "reconciliation",
        "reconciliationResult",
    ] {
        for row in plan_cases::cases().as_array().unwrap() {
            let accepted = plan_cases::input(row).is_ok_and(|desired| {
                let mut value = all["bases"][base].clone();
                let path = match base {
                    "change" => "/apply",
                    "operation" => "/change/apply",
                    "result" => "/request/change/apply",
                    "reconciliation" => "/operation/change/apply",
                    _ => "/request/operation/change/apply",
                };
                let enabled = desired["enabled"] == true;
                let apply = value.pointer_mut(path).unwrap();
                apply["desired"] = desired.clone();
                apply["expectedMappingRevision"] = if enabled { json!(11) } else { Value::Null };
                apply["expectedRetentionAppliedRevision"] =
                    if enabled { json!(13) } else { Value::Null };
                if let Some(receipt) = value.pointer_mut("/outcome/receipt") {
                    receipt["desiredPlanId"] = desired["planId"].clone();
                    receipt["desiredRevision"] = desired["revision"].clone();
                    receipt["enabled"] = json!(enabled);
                    receipt["mappingRevision"] = if enabled { json!(11) } else { Value::Null };
                    receipt["retentionAppliedRevision"] =
                        if enabled { json!(13) } else { Value::Null };
                }
                validate_recording_operations(&value).is_ok()
            });
            assert_eq!(
                accepted,
                row["accepted"].as_bool().unwrap(),
                "{base}: {}",
                row["name"]
            );
        }
    }
}
#[test]
fn d3_target_uses_only_context_and_independent_semantics() {
    let all = fixtures();
    let management: Value = serde_json::from_str(include_str!(
        "../../../../examples/recording-management-cases.json"
    ))
    .unwrap();
    for row in management["cases"].as_array().unwrap() {
        let value = input(&management, row);
        let expected = row["accepted"] == true
            && value
                .as_ref()
                .is_ok_and(|v| v["kind"] == "recordingManagementContext");
        let actual = value.is_ok_and(|target| {
            let mut value = all["bases"]["context"].clone();
            value["target"] = target;
            validate_recording_operations(&value).is_ok()
        });
        assert_eq!(actual, expected, "{}", row["name"]);
    }
}
#[test]
fn shared_full_equality_preserves_member_order_and_normalizes_numbers() {
    let all = fixtures();
    for row in all["equalities"].as_array().unwrap() {
        let a = all["bases"][row["base"].as_str().unwrap()].clone();
        let b = input(&all, row).unwrap();
        macro_rules! same {
            ($t:ident,$f:ident) => {{
                let a = $t::from_value(a.clone()).unwrap();
                let b = $t::from_value(b.clone()).unwrap();
                $f(&a, &b)
            }};
        }
        let equal = match row["base"].as_str().unwrap() {
            "context" => same!(
                RecordingOperationsContext,
                same_recording_operations_context
            ),
            "change" => same!(RecordingChangeRequest, same_recording_change_request),
            "operation" => same!(RecordingOperationRequest, same_recording_operation_request),
            "reconciliation" => same!(
                RecordingReconciliationRequest,
                same_recording_reconciliation_request
            ),
            _ => panic!("equality base"),
        };
        assert_eq!(equal, row["expected"].as_bool().unwrap(), "{}", row["name"]);
    }
}
#[test]
fn kind_wrappers_require_exact_kind_and_retain_source_independence() {
    let all = fixtures();
    let bases = [
        "context",
        "change",
        "operation",
        "result",
        "reconciliation",
        "reconciliationResult",
    ];
    type Constructor = fn(Value) -> bool;
    let constructors: [Constructor; 6] = [
        |v| RecordingOperationsContext::from_value(v).is_ok(),
        |v| RecordingChangeRequest::from_value(v).is_ok(),
        |v| RecordingOperationRequest::from_value(v).is_ok(),
        |v| RecordingOperationResult::from_value(v).is_ok(),
        |v| RecordingReconciliationRequest::from_value(v).is_ok(),
        |v| RecordingReconciliationResult::from_value(v).is_ok(),
    ];
    for (i, construct) in constructors.iter().enumerate() {
        for (j, base) in bases.iter().enumerate() {
            assert_eq!(construct(all["bases"][base].clone()), i == j);
        }
    }
    let owned =
        RecordingReconciliationResult::from_value(all["bases"]["reconciliationResult"].clone())
            .unwrap();
    let mut other = owned.as_value().clone();
    other["request"]["operation"]["change"]["context"]["sessionId"] = json!("changed");
    assert_eq!(
        owned.as_value()["request"]["operation"]["change"]["context"]["sessionId"],
        "session:1"
    );
    assert_eq!(
        RecordingOperationsError.to_string(),
        "Recording operations: invalid"
    );
}
#[test]
fn local_resources_only() {
    let root: Value = serde_json::from_str(RECORDING_OPERATIONS_SCHEMA).unwrap();
    assert!(jsonschema::options()
        .with_retriever(BundledOnly)
        .build(&root)
        .is_err());
    assert!(VALIDATOR.is_valid(&fixtures()["bases"]["result"]));
}
#[test]
fn exact_budget_edges_are_compact_normalized_integer_json() {
    for (bytes, nodes) in [
        (
            MAX_RECORDING_OPERATIONS_JSON_BYTES,
            MAX_RECORDING_OPERATIONS_JSON_NODES,
        ),
        (
            MAX_RECORDING_OPERATION_RESULT_JSON_BYTES,
            MAX_RECORDING_OPERATION_RESULT_JSON_NODES,
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
    let depth = (0..32).fold(Value::Null, |v, _| json!([v]));
    assert!(JsonBudget::new(131072, 4096).visit(&depth, 0).is_ok());
    assert!(JsonBudget::new(131072, 4096)
        .visit(&json!([depth]), 0)
        .is_err());
    let value: Value = serde_json::from_str("[-0.0,1e3,9.007199254740991e15]").unwrap();
    let mut budget = JsonBudget::new(131072, 4096);
    budget.visit(&value, 0).unwrap();
    assert_eq!(budget.bytes, "[0,1000,9007199254740991]".len());
}
