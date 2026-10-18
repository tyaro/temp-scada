//! SCADA の初期 Project 契約。共通 JSON Schema をブラウザと CLI で使う。
//! Hub 接続・Tauri・式評価・正式な .bantoscada package には依存しない。
use serde_json::Value;
use std::collections::HashSet;
use std::sync::LazyLock;

pub const SCHEMA: &str = include_str!("../schema/project.schema.json");
static VALIDATOR: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    jsonschema::validator_for(&serde_json::from_str(SCHEMA).expect("bundled schema JSON"))
        .expect("bundled schema is valid")
});

static LEGACY_VALIDATOR: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    jsonschema::validator_for(
        &serde_json::from_str(include_str!("../schema/legacy.project.schema.json"))
            .expect("legacy schema JSON"),
    )
    .expect("valid legacy schema")
});

#[derive(Debug, Clone, PartialEq)]
pub struct Project(Value);

impl Project {
    pub fn from_json(input: &str) -> Result<Self, String> {
        let mut value: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
        if value["manifest"]["schemaVersion"].as_str() == Some("0.1.0") {
            LEGACY_VALIDATOR
                .validate(&value)
                .map_err(|e| e.to_string())?;
            value["manifest"]["schemaVersion"] = Value::String("0.3.0".into());
            value["manifest"]["minRuntimeVersion"] = Value::String("0.3.0".into());
            value["symbols"] = serde_json::json!([]);
        }
        VALIDATOR.validate(&value).map_err(|e| e.to_string())?;
        let mut ids = HashSet::new();
        ids.insert(value["manifest"]["projectId"].as_str().unwrap());
        let symbols: HashSet<_> = value["symbols"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["id"].as_str().unwrap())
            .collect();
        for screen in value["screens"]
            .as_array()
            .unwrap()
            .iter()
            .chain(value["symbols"].as_array().unwrap())
        {
            if !ids.insert(screen["id"].as_str().unwrap()) {
                return Err("ID が重複しています".into());
            }
            let mut orders = HashSet::new();
            for object in screen["objects"].as_array().unwrap() {
                if !ids.insert(object["id"].as_str().unwrap()) {
                    return Err("ID が重複しています".into());
                }
                let shape = &object["shape"];
                if symbols.contains(screen["id"].as_str().unwrap())
                    && shape.get("binding").is_some()
                {
                    return Err("Symbol 定義内の直接タグ割り当てには対応していません".into());
                }
                if shape["type"] == "symbol"
                    && !symbols.contains(shape["symbolId"].as_str().unwrap())
                {
                    return Err("Symbol 定義が見つかりません".into());
                }
                if shape["type"] == "polyline" {
                    let points = shape["points"].as_array().unwrap();
                    if points.iter().all(|p| {
                        p["x"].as_f64() == points[0]["x"].as_f64()
                            && p["y"].as_f64() == points[0]["y"].as_f64()
                    }) {
                        return Err("線には異なる2点が必要です".into());
                    }
                }
                if !orders.insert(object["order"].as_f64().expect("schema validated number") as u64)
                {
                    return Err("同一画面の order が重複しています".into());
                }
            }
        }
        Ok(Self(value))
    }

    /// 初期開発用 JSON。0.1.0 は読込時に移行する。archive export はまだ行わない。
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(&self.0).expect("validated JSON") + "\n"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SAMPLE: &str = include_str!("../../../examples/minimal.project.json");
    #[test]
    fn round_trip_preserves_project() {
        let project = Project::from_json(SAMPLE).unwrap();
        assert_eq!(Project::from_json(&project.to_json()).unwrap(), project);
    }
    #[test]
    fn binding_sample_round_trip() {
        let input = include_str!("../../../examples/tag-binding.project.json");
        let project = Project::from_json(input).unwrap();
        assert_eq!(Project::from_json(&project.to_json()).unwrap(), project);
    }
    #[test]
    fn contract_cases() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../examples/contract-cases.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let mut value: Value = serde_json::from_str(SAMPLE).unwrap();
            *value.pointer_mut(case["path"].as_str().unwrap()).unwrap() = case["value"].clone();
            assert_eq!(
                Project::from_json(&value.to_string()).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
    #[test]
    fn migrates_legacy_without_losing_geometry_or_identity() {
        let input = include_str!("../../../examples/legacy.project.json");
        let old: Value = serde_json::from_str(input).unwrap();
        let project = Project::from_json(input).unwrap();
        assert_eq!(project.0["manifest"]["schemaVersion"], "0.3.0");
        assert_eq!(project.0["manifest"]["minRuntimeVersion"], "0.3.0");
        assert_eq!(
            project.0["manifest"]["projectId"],
            old["manifest"]["projectId"]
        );
        assert_eq!(
            project.0["manifest"]["projectRevision"],
            old["manifest"]["projectRevision"]
        );
        assert_eq!(project.0["screens"], old["screens"]);
        assert_eq!(project.0["symbols"], serde_json::json!([]));
        let mut invalid = old;
        invalid["futureFeature"] = Value::Bool(true);
        assert!(Project::from_json(&invalid.to_string()).is_err());
    }
    #[test]
    fn process_contract_and_round_trip() {
        let sample = include_str!("../../../examples/process.project.json");
        let project = Project::from_json(sample).unwrap();
        assert_eq!(Project::from_json(&project.to_json()).unwrap(), project);
        let cases: Value = serde_json::from_str(include_str!(
            "../../../examples/process-contract-cases.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let mut value: Value = serde_json::from_str(sample).unwrap();
            *value.pointer_mut(case["path"].as_str().unwrap()).unwrap() = case["value"].clone();
            assert_eq!(
                Project::from_json(&value.to_string()).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
}
