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

/// JavaScript の Number.MAX_SAFE_INTEGER（2^53 − 1）。これを超える整数は f64 で正確に持てない。
const MAX_EXACT_LIMIT: f64 = 9_007_199_254_740_991.0;

pub(crate) fn validate(project: &Value) -> Result<(), String> {
    validate_badges(project)?;
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

/// 警報の小札が指す定義と限界が Project にあること。しきい値の定義なら限界が必須で、
/// その限界が定義にあること。bit の定義なら限界を持たない。小札は画面の直下にだけ置ける
/// （Symbol 定義の中は schema が拒む）。仕様: docs/design/graphics/alarm-badge.md
///
/// 同じループで、数値の Text の `alarmColor` が指す定義が Project にあることも確かめる。
/// 定義の種類・限界・`enabled`・タグの一致は問わない。仕様: docs/design/graphics/alarm-value-color.md
fn validate_badges(project: &Value) -> Result<(), String> {
    let empty = Vec::new();
    let definitions = project["alarms"]["definitions"]
        .as_array()
        .unwrap_or(&empty);
    for screen in project["screens"].as_array().unwrap() {
        for object in screen["objects"].as_array().unwrap() {
            let shape = &object["shape"];
            if shape["type"] == "text" {
                if let Some(alarm_id) = shape.get("alarmColor").map(|color| &color["alarmId"]) {
                    if !definitions
                        .iter()
                        .any(|definition| &definition["id"] == alarm_id)
                    {
                        return Err("数値の警報の色が指す警報の定義が見つかりません".into());
                    }
                }
                continue;
            }
            if shape["type"] != "alarmBadge" {
                continue;
            }
            let definition = definitions
                .iter()
                .find(|definition| definition["id"] == shape["alarmId"])
                .ok_or("警報の小札が指す警報の定義が見つかりません")?;
            let source = &definition["source"];
            match (source["kind"].as_str(), shape["limit"].as_str()) {
                (Some("threshold"), None) => {
                    return Err(
                        "しきい値の警報を指す小札には限界（HH・H・L・LL）を選んでください".into(),
                    );
                }
                (Some("threshold"), Some(limit)) if source["limits"][limit].is_null() => {
                    return Err("警報の小札が指す限界が警報の定義にありません".into());
                }
                (Some("bit"), Some(_)) => {
                    return Err("bit の警報を指す小札には限界を付けられません".into());
                }
                _ => {}
            }
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
    // i64・u64 のタグでも限界が丸められずに保存・比較されるよう、±(2^53 − 1) に収める。
    if values
        .iter()
        .flatten()
        .any(|value| value.abs() > MAX_EXACT_LIMIT)
    {
        return Err(format!(
            "警報の限界の値は ±{MAX_EXACT_LIMIT} の範囲にしてください"
        ));
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
    fn shared_alarm_badge_contract() {
        let base: Value =
            serde_json::from_str(include_str!("../../../examples/process.project.json")).unwrap();
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../examples/alarm-badge-cases.json")).unwrap();
        for case in cases {
            let mut input = base.clone();
            if let Some(alarms) = case.get("alarms") {
                input["alarms"] = alarms.clone();
            }
            input
                .pointer_mut(case["target"].as_str().unwrap())
                .unwrap()
                .as_array_mut()
                .unwrap()
                .push(case["object"].clone());
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

    /// 数値の Text の警報の色。仕様: docs/design/graphics/alarm-value-color.md
    #[test]
    fn shared_alarm_value_color_contract() {
        let base: Value =
            serde_json::from_str(include_str!("../../../examples/process.project.json")).unwrap();
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../examples/alarm-value-color-cases.json"
        ))
        .unwrap();
        for case in cases {
            let mut input = base.clone();
            if let Some(alarms) = case.get("alarms") {
                input["alarms"] = alarms.clone();
            }
            input
                .pointer_mut(case["target"].as_str().unwrap())
                .unwrap()
                .as_array_mut()
                .unwrap()
                .push(case["object"].clone());
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

    /// 帯は指す定義を持たず、画面の直下にだけ置ける（Symbol 定義の中は schema が拒む）。
    /// 仕様: docs/design/graphics/alarm-banner.md
    #[test]
    fn shared_alarm_banner_contract() {
        let base: Value =
            serde_json::from_str(include_str!("../../../examples/process.project.json")).unwrap();
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../examples/alarm-banner-cases.json"))
                .unwrap();
        for case in cases {
            let mut input = base.clone();
            match case.get("alarms") {
                Some(Value::Null) => {
                    input.as_object_mut().unwrap().remove("alarms");
                }
                Some(alarms) => input["alarms"] = alarms.clone(),
                None => {}
            }
            input
                .pointer_mut(case["target"].as_str().unwrap())
                .unwrap()
                .as_array_mut()
                .unwrap()
                .push(case["object"].clone());
            let parsed = Project::from_json(&input.to_string());
            assert_eq!(
                parsed.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{} {:?}",
                case["name"],
                parsed.as_ref().err()
            );
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
