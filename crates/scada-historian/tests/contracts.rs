use scada_historian::validate_history_contract;
use serde_json::Value;

#[test]
fn shared_contract_cases_match_schema_and_semantic_outcomes() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../examples/history-contract-cases.json"
    ))
    .unwrap();
    for case in cases {
        let result = validate_history_contract(&case["input"]);
        let actual = result.err().map_or("accepted", |error| error.as_str());
        assert_eq!(
            actual,
            case["expected"].as_str().unwrap(),
            "{}",
            case["name"]
        );
        if actual == "accepted" {
            let text = serde_json::to_string(&case["input"]).unwrap();
            assert_eq!(
                validate_history_contract(&serde_json::from_str(&text).unwrap()),
                Ok(())
            );
        }
    }
}

#[test]
fn json_integer_written_with_a_decimal_is_not_a_reason_to_panic_or_round() {
    let query: Value = serde_json::from_str(r#"{"version":1.0,"kind":"query","requestId":"q","seriesIds":["s"],"fromMs":0.0,"toMs":1000.0,"mode":"raw","maxPointsPerSeries":1.0}"#).unwrap();
    assert_eq!(validate_history_contract(&query), Ok(()));
}
