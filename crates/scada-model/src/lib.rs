//! SCADA の初期 Project 契約。共通 JSON Schema をブラウザと CLI で使う。
//! Hub 接続・Tauri・式評価・正式な .bantoscada package には依存しない。
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

pub const SCHEMA: &str = include_str!("../schema/project.schema.json");
pub const MAX_FOLDER_DEPTH: usize = 16;
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
            value["manifest"]["schemaVersion"] = Value::String("0.10.0".into());
            value["manifest"]["minRuntimeVersion"] = Value::String("0.10.0".into());
            for screen in value["screens"].as_array_mut().unwrap() {
                screen["background"] = Value::String("#0b1220".into());
                screen["folders"] = serde_json::json!([]);
                for object in screen["objects"].as_array_mut().unwrap() {
                    if object["shape"]["type"] == "rectangle"
                        || object["shape"]["type"] == "ellipse"
                    {
                        object["shape"]["paint"] =
                            serde_json::json!({"fillEnabled":true,"stroke":null});
                    }
                }
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
            let folders: HashMap<_, _> = screen["folders"]
                .as_array()
                .unwrap()
                .iter()
                .map(|folder| (folder["id"].as_str().unwrap(), folder))
                .collect();
            let mut folder_orders = HashSet::new();
            for folder in screen["folders"].as_array().unwrap() {
                if !ids.insert(folder["id"].as_str().unwrap()) {
                    return Err("ID が重複しています".into());
                }
                if !folder_orders.insert(folder["order"].as_f64().unwrap() as u64) {
                    return Err("フォルダーの order が重複しています".into());
                }
                let mut visited = HashSet::new();
                let mut current = Some(folder);
                while let Some(item) = current {
                    if !visited.insert(item["id"].as_str().unwrap()) {
                        return Err("フォルダーの親に循環があります".into());
                    }
                    if visited.len() > MAX_FOLDER_DEPTH {
                        return Err("フォルダーの階層は16段までです".into());
                    }
                    current = if let Some(parent) = item.get("parentId").and_then(Value::as_str) {
                        Some(
                            *folders
                                .get(parent)
                                .ok_or("同じ所有先の親フォルダーが見つかりません")?,
                        )
                    } else {
                        None
                    };
                }
            }
            let mut orders = HashSet::new();
            for object in screen["objects"].as_array().unwrap() {
                if let Some(folder) = object.get("folderId").and_then(Value::as_str) {
                    if !folders.contains_key(folder) {
                        return Err("同じ所有先の所属フォルダーが見つかりません".into());
                    }
                }
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
    fn folder_fixture(case: &Value, definition: bool) -> Value {
        let mut value: Value =
            serde_json::from_str(include_str!("../../../examples/process.project.json")).unwrap();
        let (owner_kind, foreign_kind) = if definition {
            ("symbols", "screens")
        } else {
            ("screens", "symbols")
        };
        let foreign_id = "0199fb01-0000-7000-8000-000000000001";
        let missing_id = "0199fbff-0000-7000-8000-000000000001";
        let owner_id = value[owner_kind][0]["id"].clone();
        let object_id = value[owner_kind][0]["objects"][0]["id"].clone();
        let project_id = value["manifest"]["projectId"].clone();
        value[foreign_kind][0]["folders"] =
            serde_json::json!([{ "id": foreign_id, "name": "別の所有先", "order": 0 }]);
        let count = case["count"].as_u64().unwrap_or(2) as usize;
        let mut folders: Vec<Value> = (0..count).map(|index| serde_json::json!({
            "id": format!("0199fb00-0000-7000-8000-{:012}", index+1),
            "name": if case["sameNames"] == true { case["nameValue"].clone() } else { Value::String(format!("設備 {}",index+1)) },
            "order": index,
        })).collect();
        if !folders.is_empty() {
            if let Some(name) = case.get("nameValue") {
                folders[0]["name"] = name.clone();
            }
            if let Some(order) = case.get("order") {
                folders[0]["order"] = order.clone();
            }
            match case["collision"].as_str() {
                Some("owner") => folders[0]["id"] = owner_id,
                Some("object") => folders[0]["id"] = object_id,
                Some("manifest") => folders[0]["id"] = project_id,
                Some("foreign") => folders[0]["id"] = Value::String(foreign_id.into()),
                Some("folder") => folders[1]["id"] = folders[0]["id"].clone(),
                None => {}
                _ => panic!("unknown folder collision fixture"),
            }
            if case["duplicateOrder"] == true {
                folders[1]["order"] = folders[0]["order"].clone();
            }
            if case["chain"] != false {
                for index in 1..folders.len() {
                    folders[index]["parentId"] = folders[index - 1]["id"].clone();
                }
            }
            if case["extraField"] == true {
                folders[0]["futureFeature"] = Value::Bool(true);
            }
            if let Some(parent) = case["parent"].as_str() {
                folders[0]["parentId"] = match parent {
                    "missing" => Value::String(missing_id.into()),
                    "foreign" => Value::String(foreign_id.into()),
                    "self" => folders[0]["id"].clone(),
                    "cycle" => folders[1]["id"].clone(),
                    "null" => Value::Null,
                    _ => panic!("unknown parent fixture"),
                };
            }
        }
        let first_id = folders
            .first()
            .map(|folder| folder["id"].clone())
            .unwrap_or(Value::Null);
        let last_id = folders.last().map(|folder| folder["id"].clone());
        let owner = &mut value[owner_kind][0];
        owner["folders"] = Value::Array(folders);
        if let Some(id) = last_id {
            for object in owner["objects"].as_array_mut().unwrap() {
                object["folderId"] = id.clone();
            }
        }
        if let Some(membership) = case["membership"].as_str() {
            owner["objects"][0]["folderId"] = match membership {
                "missing" => Value::String(missing_id.into()),
                "foreign" => Value::String(foreign_id.into()),
                "null" => Value::Null,
                "array" => Value::Array(vec![first_id]),
                _ => panic!("unknown membership fixture"),
            };
        }
        if case["folders"] == "missing" {
            owner.as_object_mut().unwrap().remove("folders");
        }
        if case["folders"] == "null" {
            owner["folders"] = Value::Null;
        }
        value
    }

    #[test]
    fn layer_folders_share_the_browser_contract() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../examples/layer-folder-cases.json"))
                .unwrap();
        let baseline =
            Project::from_json(include_str!("../../../examples/process.project.json")).unwrap();
        for definition in [false, true] {
            for case in cases.as_array().unwrap() {
                let value = folder_fixture(case, definition);
                let result = Project::from_json(&value.to_string());
                assert_eq!(
                    result.is_ok(),
                    case["valid"].as_bool().unwrap(),
                    "definition={definition}: {}: {:?}",
                    case["name"],
                    result.as_ref().err()
                );
                if let Ok(project) = result {
                    assert_eq!(Project::from_json(&project.to_json()).unwrap().0, project.0);
                    assert_eq!(project.text_bindings(), baseline.text_bindings());
                }
            }
        }
    }
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
    fn edit_lock_is_optional_boolean_and_preserved_for_all_placements() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../examples/edit-lock-cases.json")).unwrap();
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
                value.pointer_mut(path).unwrap()["locked"] = case["value"].clone();
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
        old["manifest"]["schemaVersion"] = serde_json::json!("0.5.0");
        assert!(Project::from_json(&old.to_string()).is_err());
    }
    #[test]
    fn static_visibility_is_boolean_and_preserves_hidden_references() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../examples/visibility-cases.json")).unwrap();
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
                value.pointer_mut(path).unwrap()["visible"] = case["value"].clone();
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
        let mut value: Value =
            serde_json::from_str(include_str!("../../../examples/tag-binding.project.json"))
                .unwrap();
        let before = Project::from_json(&value.to_string())
            .unwrap()
            .text_bindings();
        value["screens"][0]["objects"][2]["visible"] = Value::Bool(false);
        let hidden = Project::from_json(&value.to_string()).unwrap();
        assert_eq!(hidden.text_bindings(), before);
        assert_eq!(hidden.0["screens"][0]["objects"][2]["visible"], false);
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
    fn shape_paint_shares_the_browser_contract() {
        let sample =
            Project::from_json(include_str!("../../../examples/shape-paint.project.json")).unwrap();
        assert_eq!(Project::from_json(&sample.to_json()).unwrap(), sample);
        let cases: Value =
            serde_json::from_str(include_str!("../../../examples/shape-paint-cases.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let mut value: Value =
                serde_json::from_str(include_str!("../../../examples/process.project.json"))
                    .unwrap();
            let kind = case["kind"].as_str().unwrap_or("rectangle");
            let index = value["screens"][0]["objects"]
                .as_array()
                .unwrap()
                .iter()
                .position(|o| {
                    o["shape"]["type"] == if kind == "ellipse" { "rectangle" } else { kind }
                })
                .unwrap();
            if kind == "ellipse" {
                value["screens"][0]["objects"][index]["shape"]["type"] =
                    Value::String("ellipse".into());
            }
            if case["definition"] == true {
                let mut child = value["screens"][0]["objects"][index].clone();
                child["id"] = value["symbols"][0]["objects"][0]["id"].clone();
                child["order"] = value["symbols"][0]["objects"][0]["order"].clone();
                value["symbols"][0]["objects"][0] = child;
            }
            let object = if case["definition"] == true {
                &mut value["symbols"][0]["objects"][0]
            } else {
                &mut value["screens"][0]["objects"][index]
            };
            if case["omit"] == true {
                object["shape"].as_object_mut().unwrap().remove("paint");
            } else {
                object["shape"]["paint"] = case["paint"].clone();
            }
            let result = Project::from_json(&value.to_string());
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            if let Ok(project) = result {
                assert_eq!(Project::from_json(&project.to_json()).unwrap(), project);
            }
        }
    }
    #[test]
    fn symbol_color_modes_share_the_browser_contract() {
        let sample =
            Project::from_json(include_str!("../../../examples/symbol-color.project.json"))
                .unwrap();
        assert_eq!(Project::from_json(&sample.to_json()).unwrap(), sample);
        let cases: Value =
            serde_json::from_str(include_str!("../../../examples/symbol-color-cases.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            let mut value: Value =
                serde_json::from_str(include_str!("../../../examples/process.project.json"))
                    .unwrap();
            let kind = case
                .get("primitive")
                .and_then(Value::as_str)
                .unwrap_or("symbol");
            let index = value["screens"][0]["objects"]
                .as_array()
                .unwrap()
                .iter()
                .position(|object| {
                    object["shape"]["type"] == if kind == "ellipse" { "rectangle" } else { kind }
                })
                .unwrap();
            if kind == "ellipse" {
                value["screens"][0]["objects"][index]["shape"] = serde_json::json!({"type":"ellipse","paint":{"fillEnabled":true,"stroke":null}});
            }
            if case["definition"] == true {
                let mut child = value["screens"][0]["objects"][index].clone();
                child["id"] = value["symbols"][0]["objects"][0]["id"].clone();
                value["symbols"][0]["objects"][0] = child;
            }
            let object = if case["definition"] == true {
                &mut value["symbols"][0]["objects"][0]
            } else {
                &mut value["screens"][0]["objects"][index]
            };
            if case["omitMode"] == true {
                object["shape"].as_object_mut().unwrap().remove("colorMode");
            } else {
                object["shape"]["colorMode"] = case["mode"].clone();
            }
            if case["omitFill"] == true {
                object.as_object_mut().unwrap().remove("fill");
            }
            if let Some(fill) = case.get("fill") {
                object["fill"] = fill.clone();
            }
            if case["extra"] == true {
                object["shape"]["extra"] = Value::Bool(true);
            }
            let result = Project::from_json(&value.to_string());
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            if let Ok(project) = result {
                assert_eq!(Project::from_json(&project.to_json()).unwrap(), project);
            }
        }
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
        assert_eq!(project.0["manifest"]["schemaVersion"], "0.10.0");
        assert_eq!(project.0["manifest"]["minRuntimeVersion"], "0.10.0");
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
            screen["folders"] = serde_json::json!([]);
            for object in screen["objects"].as_array_mut().unwrap() {
                if object["shape"]["type"] == "rectangle" || object["shape"]["type"] == "ellipse" {
                    object["shape"]["paint"] =
                        serde_json::json!({"fillEnabled":true,"stroke":null});
                }
            }
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
