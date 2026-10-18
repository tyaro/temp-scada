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

#[derive(Debug, Clone, PartialEq)]
pub struct Project(Value);

impl Project {
    pub fn from_json(input: &str) -> Result<Self, String> {
        let value: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
        VALIDATOR.validate(&value).map_err(|e| e.to_string())?;
        let mut ids = HashSet::new();
        ids.insert(value["manifest"]["projectId"].as_str().unwrap());
        for screen in value["screens"].as_array().unwrap() {
            if !ids.insert(screen["id"].as_str().unwrap()) {
                return Err("ID が重複しています".into());
            }
            let mut orders = HashSet::new();
            for object in screen["objects"].as_array().unwrap() {
                if !ids.insert(object["id"].as_str().unwrap()) {
                    return Err("ID が重複しています".into());
                }
                if !orders.insert(object["order"].as_f64().expect("schema validated number") as u64)
                {
                    return Err("同一画面の order が重複しています".into());
                }
            }
        }
        Ok(Self(value))
    }

    /// 初期開発用 JSON。archive export や migration はまだ行わない。
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
}
