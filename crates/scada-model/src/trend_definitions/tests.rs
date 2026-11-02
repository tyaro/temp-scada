use super::*;
use serde_json::json;

fn fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../../examples/trend-definition-cases.json"
    ))
    .unwrap()
}
fn grow(slot: &mut Value, remaining: &mut usize) {
    let add = (*remaining).min(2000);
    *remaining -= add;
    *slot = Value::String(format!("x{}{}", "😀".repeat(add / 4), "x".repeat(add % 4)));
}
fn input(case: &Value) -> Result<Value, serde_json::Error> {
    if let Some(raw) = case["json"].as_str() {
        return serde_json::from_str(raw);
    }
    let Some(recipe) = case["build"].as_str() else {
        return Ok(case["input"].clone());
    };
    let mut document = fixtures()[0]["input"].clone();
    let row = document["definitions"][0].clone();
    match recipe {
        "definitions" => {
            document["definitions"] = Value::Array(
                (0..case["count"].as_u64().unwrap())
                    .map(|i| {
                        let mut row = row.clone();
                        row["id"] = json!(format!("trend:{i}"));
                        row
                    })
                    .collect(),
            )
        }
        "pens" => {
            document["definitions"][0]["pens"] = Value::Array(
                (0..case["count"].as_u64().unwrap())
                    .map(|i| {
                        let mut pen = row["pens"][0].clone();
                        pen["id"] = json!(format!("pen:{i}"));
                        pen["seriesId"] = json!(format!("series:{i}"));
                        pen
                    })
                    .collect(),
            );
            document["definitions"][0]["maxPointsPerSeries"] = json!(1000);
        }
        "byteBudget" => {
            document["definitions"] = Value::Array((0..128).map(|i| {
                let mut row = row.clone(); row["id"] = json!(format!("trend:{i}")); row["name"] = json!("x"); row["maxPointsPerSeries"] = json!(1000);
                row["pens"] = Value::Array((0..8).map(|j| json!({"id":format!("pen:{j}"),"seriesId":format!("series:{j}"),"color":"#aB12Ef","label":"x"})).collect()); row
            }).collect());
            let target = case["bytes"].as_u64().unwrap() as usize;
            let mut remaining = target
                .checked_sub(serde_json::to_vec(&document).unwrap().len())
                .expect("recipe too small");
            for row in document["definitions"].as_array_mut().unwrap() {
                grow(&mut row["name"], &mut remaining);
                for pen in row["pens"].as_array_mut().unwrap() {
                    grow(&mut pen["label"], &mut remaining);
                }
            }
            assert_eq!(remaining, 0, "recipe too large");
            assert_eq!(serde_json::to_vec(&document).unwrap().len(), target);
            if case["floatNumbers"] == true {
                document["version"] = json!(1.0);
                for row in document["definitions"].as_array_mut().unwrap() {
                    row["windowMs"] = json!(3_600_000.0);
                    row["maxPointsPerSeries"] = json!(1000.0);
                }
                assert!(serde_json::to_vec(&document).unwrap().len() > target);
            }
        }
        _ => panic!("unknown recipe"),
    }
    Ok(document)
}

#[test]
fn shared_rust_typescript_and_browser_acceptance() {
    for case in fixtures().as_array().unwrap() {
        let document = input(case);
        let accepted = document
            .as_ref()
            .is_ok_and(|value| validate_trend_definitions(value).is_ok());
        assert_eq!(
            accepted,
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        if accepted {
            let value = document.unwrap();
            let parsed = TrendDefinitions::from_value(value.clone()).unwrap();
            assert_eq!(
                parsed.as_value(),
                &value,
                "preserve strings/order/color/numeric input"
            );
            assert!(validate_trend_definitions(
                &serde_json::from_str::<Value>(&serde_json::to_string(parsed.as_value()).unwrap())
                    .unwrap()
            )
            .is_ok());
        }
    }
}
#[test]
fn h1_resource_is_bundled_and_missing_references_fail_without_network() {
    let root: Value = serde_json::from_str(TREND_DEFINITION_SCHEMA).unwrap();
    assert!(jsonschema::options()
        .with_retriever(BundledOnly)
        .build(&root)
        .is_err());
    assert!(VALIDATOR.is_valid(&fixtures()[0]["input"]));
}
#[test]
fn depth_and_node_budgets_bound_invalid_structured_data_before_schema() {
    let mut value = Value::Null;
    for _ in 0..32 {
        value = json!([value]);
    }
    assert!(JsonBudget::new(MAX_TREND_JSON_BYTES, 250_000)
        .visit(&value, 0)
        .is_ok());
    value = json!([value]);
    assert!(JsonBudget::new(MAX_TREND_JSON_BYTES, 250_000)
        .visit(&value, 0)
        .is_err());
    assert!(validate_trend_definitions(&value).is_err());
    let below = Value::Array(vec![json!(0); 249_999]);
    assert!(JsonBudget::new(MAX_TREND_JSON_BYTES, 250_000)
        .visit(&below, 0)
        .is_ok());
    let above = Value::Array(vec![json!(0); 250_000]);
    assert!(JsonBudget::new(MAX_TREND_JSON_BYTES, 250_000)
        .visit(&above, 0)
        .is_err());
}
#[test]
fn compact_bytes_match_json_escaping_and_integer_numeric_semantics() {
    let value = json!([
        "\u{0000}\u{0001}\u{0008}\t\n\u{000c}\r\"\\😀\u{0085}\u{2028}\u{feff}",
        1,
        1000
    ]);
    let mut budget = JsonBudget::new(MAX_TREND_JSON_BYTES, 250_000);
    budget.visit(&value, 0).unwrap();
    assert_eq!(budget.bytes, serde_json::to_vec(&value).unwrap().len());
    let mut budget = JsonBudget::new(MAX_TREND_JSON_BYTES, 250_000);
    budget.visit(&json!([1.0, 1e3, -0.0]), 0).unwrap();
    assert_eq!(budget.bytes, "[1,1000,0]".len());
}
