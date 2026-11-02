use super::*;
use serde_json::json;
fn cases() -> Value {
    serde_json::from_str(include_str!(
        "../../../../examples/recording-plan-cases.json"
    ))
    .unwrap()
}
fn input(case: &Value) -> Result<Value, serde_json::Error> {
    if let Some(raw) = case["json"].as_str() {
        return serde_json::from_str(raw);
    }
    if let Some(build) = case["build"].as_str() {
        let count = case["count"].as_u64().unwrap() as usize;
        return Ok(match build {
            "bytes" => json!("x".repeat(count - 2)),
            "nodes" => Value::Array(vec![Value::Null; count]),
            "depth" => (0..count).fold(Value::Null, |value, _| json!([value])),
            _ => panic!("unknown recipe"),
        });
    }
    Ok(case["input"].clone())
}
#[test]
fn shared_native_typescript_and_browser_cases() {
    for case in cases().as_array().unwrap() {
        let value = input(case);
        let expected = case["accepted"].as_bool().unwrap();
        let actual = value
            .as_ref()
            .is_ok_and(|v| validate_recording_plan(v).is_ok());
        assert_eq!(actual, expected, "{}", case["name"]);
        if expected {
            let value = value.unwrap();
            let parsed = DesiredRecordingPlan::from_value(value.clone()).unwrap();
            assert_eq!(parsed.as_value(), &value);
            let roundtrip: Value =
                serde_json::from_str(&serde_json::to_string(parsed.as_value()).unwrap()).unwrap();
            assert!(validate_recording_plan(&roundtrip).is_ok());
        }
    }
}
#[test]
fn canonical_h1_resource_is_required_and_never_fetched() {
    let root: Value = serde_json::from_str(RECORDING_PLAN_SCHEMA).unwrap();
    assert!(jsonschema::options()
        .with_retriever(BundledOnly)
        .build(&root)
        .is_err());
    assert!(VALIDATOR.is_valid(&cases()[0]["input"]));
}
#[test]
fn owned_plan_keeps_members_and_strings_without_resolving_identity() {
    let value = cases()[0]["input"].clone();
    let owned = DesiredRecordingPlan::from_value(value).unwrap();
    assert_eq!(
        owned.as_value()["group"]["members"][0]["memberId"],
        "member:b"
    );
    assert_eq!(
        owned.as_value()["group"]["members"][0]["externalName"],
        " 温度 "
    );
    let mut unrelated = owned.as_value().clone();
    unrelated["group"]["members"][0]["externalName"] = json!("changed");
    assert_ne!(owned.as_value(), &unrelated);
    assert_eq!(RecordingPlanError.to_string(), "Recording plan: invalid");
}
#[test]
fn traversal_limits_apply_before_schema_and_match_normalized_numeric_bytes() {
    let below = Value::Object((0..4095).map(|i| (format!("k:{i}"), Value::Null)).collect());
    assert!(JsonBudget::new(65536, 4096).visit(&below, 0).is_ok());
    let above = Value::Array(vec![Value::Null; 4096]);
    assert!(JsonBudget::new(65536, 4096).visit(&above, 0).is_err());
    let mut depth = Value::Null;
    for _ in 0..32 {
        depth = json!([depth]);
    }
    assert!(JsonBudget::new(65536, 4096).visit(&depth, 0).is_ok());
    assert!(JsonBudget::new(65536, 4096)
        .visit(&json!([depth]), 0)
        .is_err());
    assert!(JsonBudget::new(65536, 4096)
        .visit(&json!("x".repeat(65534)), 0)
        .is_ok());
    assert!(JsonBudget::new(65536, 4096)
        .visit(&json!("x".repeat(65535)), 0)
        .is_err());
    let value: Value = serde_json::from_str("[1.0,1e3,9.007199254740991e15,-0.0]").unwrap();
    let mut budget = JsonBudget::new(65536, 4096);
    budget.visit(&value, 0).unwrap();
    assert_eq!(budget.bytes, "[1,1000,9007199254740991,0]".len());
    let escaped = json!(["\u{0000}\t\n\u{0085}😀\"\\", 9007199254740991_u64]);
    let mut budget = JsonBudget::new(65536, 4096);
    budget.visit(&escaped, 0).unwrap();
    assert_eq!(budget.bytes, serde_json::to_vec(&escaped).unwrap().len());
}
