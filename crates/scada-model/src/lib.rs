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

/// 画面 Text の読み取り参照。Hub 内部 ID や現在値は含めない。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextBinding {
    pub screen_id: String,
    pub object_id: String,
    pub external_name: String,
}

impl Project {
    pub fn id(&self) -> &str {
        self.0["manifest"]["projectId"].as_str().unwrap()
    }

    pub fn revision(&self) -> u64 {
        // 共通 schema が JS safe integer に制限する。JSON の 1.0 も整数として受理する。
        self.0["manifest"]["projectRevision"].as_f64().unwrap() as u64
    }

    pub fn text_bindings(&self) -> Vec<TextBinding> {
        self.0["screens"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|screen| {
                screen["objects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|object| {
                        object["shape"].get("binding").map(|binding| TextBinding {
                            screen_id: screen["id"].as_str().unwrap().into(),
                            object_id: object["id"].as_str().unwrap().into(),
                            external_name: binding["externalName"].as_str().unwrap().into(),
                        })
                    })
            })
            .collect()
    }
    pub fn from_json(input: &str) -> Result<Self, String> {
        let mut value: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
        if value["manifest"]["schemaVersion"].as_str() == Some("0.1.0") {
            LEGACY_VALIDATOR
                .validate(&value)
                .map_err(|e| e.to_string())?;
            value["manifest"]["schemaVersion"] = Value::String("0.5.0".into());
            value["manifest"]["minRuntimeVersion"] = Value::String("0.5.0".into());
            for screen in value["screens"].as_array_mut().unwrap() {
                screen["background"] = Value::String("#0b1220".into());
            }
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
    fn background_is_required_and_does_not_belong_to_symbols() {
        let mut missing: Value = serde_json::from_str(SAMPLE).unwrap();
        missing["screens"][0]
            .as_object_mut()
            .unwrap()
            .remove("background");
        assert!(Project::from_json(&missing.to_string()).is_err());
        let mut symbols: Value =
            serde_json::from_str(include_str!("../../../examples/process.project.json")).unwrap();
        symbols["symbols"][0]["background"] = Value::String("#ffffff".into());
        assert!(Project::from_json(&symbols.to_string()).is_err());
        let light = include_str!("../../../examples/process-light.project.json");
        let project = Project::from_json(light).unwrap();
        assert_eq!(project.0["screens"][0]["background"], "#ffffff");
        assert_eq!(Project::from_json(&project.to_json()).unwrap(), project);
    }
    #[test]
    fn placement_names_share_the_browser_contract_and_survive_round_trip() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../examples/placement-name-cases.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            for path in [
                "/screens/0/objects/2",
                "/screens/0/objects/7",
                "/screens/0/objects/10",
                "/symbols/0/objects/0",
            ] {
                let mut value: Value =
                    serde_json::from_str(include_str!("../../../examples/process.project.json"))
                        .unwrap();
                value.pointer_mut(path).unwrap()["name"] = case["value"].clone();
                let result = Project::from_json(&value.to_string());
                assert_eq!(
                    result.is_ok(),
                    case["valid"].as_bool().unwrap(),
                    "{}: {}",
                    case["name"],
                    path
                );
                if let Ok(project) = result {
                    assert_eq!(Project::from_json(&project.to_json()).unwrap(), project);
                }
            }
        }
        let mut old: Value = serde_json::from_str(SAMPLE).unwrap();
        old["manifest"]["schemaVersion"] = serde_json::json!("0.4.0");
        assert!(Project::from_json(&old.to_string()).is_err());
    }
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
        assert_eq!(project.0["manifest"]["schemaVersion"], "0.5.0");
        assert_eq!(project.0["manifest"]["minRuntimeVersion"], "0.5.0");
        assert_eq!(
            project.0["manifest"]["projectId"],
            old["manifest"]["projectId"]
        );
        assert_eq!(
            project.0["manifest"]["projectRevision"],
            old["manifest"]["projectRevision"]
        );
        let mut screens = old["screens"].clone();
        for screen in screens.as_array_mut().unwrap() {
            screen["background"] = Value::String("#0b1220".into());
        }
        assert_eq!(project.0["screens"], screens);
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
