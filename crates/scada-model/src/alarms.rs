//! Project 直下の `alarms`（警報の定義）の検査。仕様: docs/design/runtime/alarm-stage3-design.md §3
//!
//! 形（必須の欄・値の範囲・タグの外部名の形式・delay の上限）は schema が受け持ち、ここでは
//! 限界の順序、deadband と限界の差、id と名前の重複を確かめる。タグの型はタグ一覧が要るので
//! Designer（TS）の編集のときだけ確かめる。
//!
//! delay の上限 600000 ms は `scada-alarm` の `MAX_DELAY_MS` と同じ値を schema に置く。
//! `scada-alarm` は後で Project の定義を読む側になるので、model から alarm へは依存しない。

use serde_json::Value;
use std::collections::HashSet;

pub(crate) fn validate(project: &Value) -> Result<(), String> {
    let Some(definitions) = project["alarms"]["definitions"].as_array() else {
        return Ok(());
    };
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for definition in definitions {
        if !ids.insert(definition["id"].as_str().unwrap()) {
            return Err("警報の定義の id が重複しています".into());
        }
        if !names.insert(definition["name"].as_str().unwrap()) {
            return Err("警報の名前が重複しています".into());
        }
        let source = &definition["source"];
        if source["kind"] == "threshold" {
            validate_limits(source)?;
        }
    }
    Ok(())
}

/// HH ≥ H > L ≥ LL、値が有限、上下の限界を両方持つなら deadband < 最も低い上の限界 − 最も高い下の限界。
fn validate_limits(source: &Value) -> Result<(), String> {
    let limit = |key: &str| source["limits"][key]["value"].as_f64();
    let values = [limit("hh"), limit("h"), limit("l"), limit("ll")];
    if values.iter().flatten().any(|value| !value.is_finite()) {
        return Err("警報の限界の値は有限の数にしてください".into());
    }
    let [hh, h, l, ll] = values;
    let upper = h.or(hh);
    let lower = l.or(ll);
    let disordered = matches!((hh, h), (Some(a), Some(b)) if a < b)
        || matches!((l, ll), (Some(a), Some(b)) if a < b)
        || matches!((upper, lower), (Some(a), Some(b)) if a <= b);
    if disordered {
        return Err("警報の限界は HH ≥ H > L ≥ LL の順にしてください".into());
    }
    if let (Some(deadband), Some(upper), Some(lower)) = (source["deadband"].as_f64(), upper, lower)
    {
        if deadband >= upper - lower {
            return Err("警報の deadband は上の限界と下の限界の差より小さくしてください".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::Project;
    use serde_json::Value;

    #[test]
    fn shared_alarm_definition_contract() {
        let base: Value = serde_json::from_str(include_str!(
            "../../../examples/read-presentation.project.json"
        ))
        .unwrap();
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../examples/alarm-definition-cases.json"
        ))
        .unwrap();
        for case in cases {
            let mut input = base.clone();
            if !case["alarms"].is_null() {
                input["alarms"] = case["alarms"].clone();
            }
            let parsed = Project::from_json(&input.to_string());
            assert_eq!(
                parsed.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{} {:?}",
                case["name"],
                parsed.as_ref().err()
            );
            if let (Err(message), Some(error)) = (&parsed, case["error"].as_str()) {
                assert!(message.contains(error), "{} {message}", case["name"]);
            }
            if let Ok(project) = parsed {
                assert_eq!(
                    Project::from_json(&project.to_json()).unwrap().0,
                    project.0,
                    "{}",
                    case["name"]
                );
            }
        }
    }
}
