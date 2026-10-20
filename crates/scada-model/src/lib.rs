//! SCADA の初期 Project 契約。共通 JSON Schema をブラウザと CLI で使う。
//! Hub 接続・Tauri・式評価・正式な .bantoscada package には依存しない。
use serde_json::Value;
mod equipment;
pub use equipment::{EquipmentReadBinding, EquipmentReadType};
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
            value["manifest"]["schemaVersion"] = Value::String("0.23.0".into());
            value["manifest"]["minRuntimeVersion"] = Value::String("0.23.0".into());
            for screen in value["screens"].as_array_mut().unwrap() {
                screen["background"] = Value::String("#0b1220".into());
                screen["folders"] = serde_json::json!([]);
                screen["groups"] = serde_json::json!([]);
                for object in screen["objects"].as_array_mut().unwrap() {
                    object["rotation"] = serde_json::json!(0);
                    if object["shape"]["type"] == "text" {
                        object["shape"]["style"] = serde_json::json!({"fontSize":(object["height"].as_f64().unwrap() * 0.7).min(512.0),"fontWeight":"normal","align":"left"});
                    }
                    if object["shape"]["type"] == "rectangle"
                        || object["shape"]["type"] == "ellipse"
                    {
                        object["shape"]["paint"] = serde_json::json!({"fill":{"enabled":true,"paint":{"type":"solid","color":object["fill"].clone(),"alpha":1}},"stroke":null});
                        object.as_object_mut().unwrap().remove("fill");
                    }
                }
            }
            value["symbols"] = serde_json::json!([]);
            value["assets"] = serde_json::json!([]);
        }
        VALIDATOR.validate(&value).map_err(|e| e.to_string())?;
        let mut ids = HashSet::new();
        ids.insert(value["manifest"]["projectId"].as_str().unwrap());
        let used_assets: HashSet<_> = value["screens"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|screen| {
                screen
                    .get("backgroundImage")
                    .into_iter()
                    .map(|image| image["assetId"].as_str().unwrap())
                    .chain(
                        screen["objects"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter(|object| object["shape"]["type"] == "image")
                            .map(|object| object["shape"]["assetId"].as_str().unwrap()),
                    )
            })
            .collect();
        let mut asset_ids = HashSet::new();
        let mut hashes = HashSet::new();
        let mut total_bytes = 0u64;
        for asset in value["assets"].as_array().unwrap() {
            let id = asset["id"].as_str().unwrap();
            if !ids.insert(id) {
                return Err("ID が重複しています".into());
            }
            asset_ids.insert(id);
            if !hashes.insert(asset["sha256"].as_str().unwrap()) {
                return Err("同じ画像hashの資産宣言が重複しています".into());
            }
            if asset["width"].as_f64().unwrap() * asset["height"].as_f64().unwrap() > 16_000_000.0 {
                return Err("画像は1600万画素以下にしてください".into());
            }
            total_bytes += asset["byteLength"].as_f64().unwrap() as u64;
            if !used_assets.contains(id) {
                return Err("未使用の画像資産宣言があります".into());
            }
        }
        if total_bytes > 64 * 1024 * 1024 {
            return Err("Projectの画像容量が64MiBを超えています".into());
        }
        if !used_assets.is_subset(&asset_ids) {
            return Err("画像の資産が見つかりません".into());
        }
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
                if shape["type"] == "image" {
                    if let Some(crop) = shape.get("crop") {
                        let asset = value["assets"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|asset| asset["id"] == shape["assetId"])
                            .unwrap();
                        let x = crop["x"].as_f64().unwrap();
                        let y = crop["y"].as_f64().unwrap();
                        let width = crop["width"].as_f64().unwrap();
                        let height = crop["height"].as_f64().unwrap();
                        let epsilon = 16.0 * f64::EPSILON;
                        let source_width = asset["width"].as_f64().unwrap();
                        let source_height = asset["height"].as_f64().unwrap();
                        if x + width > 1.0 + epsilon
                            || y + height > 1.0 + epsilon
                            || width.min(1.0 - x) * source_width < 1.0 - epsilon * source_width
                            || height.min(1.0 - y) * source_height < 1.0 - epsilon * source_height
                        {
                            return Err(
                                "切出し範囲は画像の内側・元画像の1画素以上にしてください。".into(),
                            );
                        }
                    }
                }

                if (shape["type"] == "rectangle" || shape["type"] == "ellipse")
                    && shape["paint"]["fill"]["paint"]["type"] == "pattern"
                {
                    let pattern = &shape["paint"]["fill"]["paint"];
                    if pattern["size"].as_f64().unwrap()
                        > pattern["spacing"].as_f64().unwrap() / 2.0
                    {
                        return Err("模様の太さは間隔の半分以下にしてください。".into());
                    }
                }

                if (shape["type"] == "rectangle" || shape["type"] == "ellipse")
                    && shape["paint"]["fill"]["paint"]["type"] == "linearGradient"
                {
                    let width = object["width"].as_f64().unwrap();
                    let height = object["height"].as_f64().unwrap();
                    let radians = shape["paint"]["fill"]["paint"]["angle"]
                        .as_f64()
                        .unwrap()
                        .to_radians();
                    let clean = |v: f64| if v.abs() < 1e-12 { 0.0 } else { v };
                    let ux = clean(radians.cos());
                    let uy = clean(radians.sin());
                    let half = (width / 2.0) * ux.abs() + (height / 2.0) * uy.abs();
                    let dx = half * ux;
                    let dy = half * uy;
                    if [
                        width / 2.0 - dx,
                        height / 2.0 - dy,
                        width / 2.0 + dx,
                        height / 2.0 + dy,
                    ]
                    .iter()
                    .any(|v| !v.is_finite())
                    {
                        return Err("グラデーションの描画座標が有限の範囲を超えています。".into());
                    }
                }

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
        validate_groups(&value, &mut ids)?;
        equipment::validate(&value, &mut ids)?;
        validate_screen_views(&value)?;
        Ok(Self(value))
    }

    /// 初期開発用 JSON。0.1.0 は読込時に移行する。archive export はまだ行わない。
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(&self.0).expect("validated JSON") + "\n"
    }
}

/// One level only. Count hidden objects and Symbol children, without recursive rendering.
fn validate_groups<'a>(project: &'a Value, ids: &mut HashSet<&'a str>) -> Result<(), String> {
    for screen in project["screens"].as_array().unwrap() {
        let mut objects: Vec<_> = screen["objects"].as_array().unwrap().iter().collect();
        objects.sort_by(|a, b| {
            a["order"]
                .as_f64()
                .unwrap()
                .total_cmp(&b["order"].as_f64().unwrap())
        });
        let positions: HashMap<_, _> = objects
            .iter()
            .enumerate()
            .map(|(index, object)| (object["id"].as_str().unwrap(), index))
            .collect();
        let mut assigned = HashSet::new();
        for group in screen["groups"].as_array().unwrap() {
            if !ids.insert(group["id"].as_str().unwrap()) {
                return Err("ID が重複しています".into());
            }
            let members = group["memberIds"].as_array().unwrap();
            let start = *positions
                .get(members[0].as_str().unwrap())
                .ok_or("グループの配置が見つかりません")?;
            let folder = objects[start].get("folderId");
            for (index, member) in members.iter().enumerate() {
                let id = member.as_str().unwrap();
                if !assigned.insert(id) {
                    return Err("配置は複数グループに所属できません".into());
                }
                if positions.get(id) != Some(&(start + index)) {
                    return Err("グループは描画順で連続する配置を指定してください".into());
                }
                if objects[start + index].get("folderId") != folder {
                    return Err("グループは同じフォルダーの配置を指定してください".into());
                }
            }
        }
    }
    Ok(())
}

fn validate_screen_views(project: &Value) -> Result<(), String> {
    let screens = project["screens"].as_array().unwrap();
    let symbols: HashMap<_, _> = project["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["id"].as_str().unwrap(),
                s["objects"].as_array().unwrap().len(),
            )
        })
        .collect();
    let mut costs = HashMap::new();
    let mut refs: HashMap<&str, Vec<&str>> = HashMap::new();
    for screen in screens {
        let id = screen["id"].as_str().unwrap();
        let mut cost = 0usize;
        for object in screen["objects"].as_array().unwrap() {
            let shape = &object["shape"];
            if shape["type"] == "screenView" {
                let target = shape["screenId"].as_str().unwrap();
                if target == id {
                    return Err("自分自身の画面は埋め込めません。".into());
                }
                refs.entry(id).or_default().push(target);
            } else {
                cost += 1;
                if shape["type"] == "symbol" {
                    cost += symbols[shape["symbolId"].as_str().unwrap()];
                }
            }
        }
        costs.insert(id, cost);
    }
    for (id, targets) in &refs {
        if targets.len() > 32 {
            return Err("画面内の埋込Viewは32件以下にしてください。".into());
        }
        let mut cost = costs[id];
        for target in targets {
            let target_cost = costs.get(target).ok_or("参照する画面が見つかりません。")?;
            if refs.contains_key(target) {
                return Err("埋込Viewを持つ画面は埋め込めません（入れ子・循環参照）。".into());
            }
            cost += 1 + target_cost;
        }
        if cost > 20_000 {
            return Err("埋込後の描画配置数は20,000件以下にしてください。".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn geometric_groups_share_browser_contract() {
        let sample: Value =
            serde_json::from_str(include_str!("../../../examples/minimal.project.json")).unwrap();
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../examples/geometric-group-cases.json"))
                .unwrap();
        for case in cases {
            let mut value = sample.clone();
            value["screens"][0]["groups"] = case["groups"].clone();
            if case["foldered"] == true {
                value["screens"][0]["folders"] = serde_json::json!([{ "id":"0199f200-0000-7000-8000-000000000001", "name":"部分", "order":0 }]);
                value["screens"][0]["objects"][0]["folderId"] =
                    serde_json::json!("0199f200-0000-7000-8000-000000000001");
            }
            assert_eq!(
                Project::from_json(&value.to_string()).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
    #[test]
    fn screen_views_share_browser_contract() {
        let sample: Value = serde_json::from_str(include_str!(
            "../../../examples/embedded-screen.project.json"
        ))
        .unwrap();
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../examples/screen-view-cases.json")).unwrap();
        let original = Project::from_json(&sample.to_string()).unwrap();
        assert_eq!(Project::from_json(&original.to_json()).unwrap(), original);
        for case in cases {
            let mut value = sample.clone();
            let path = case["path"].as_str().unwrap();
            let (parent, key) = path.rsplit_once('/').unwrap();
            let target = value.pointer_mut(parent).unwrap();
            if target.is_array() {
                target[key.parse::<usize>().unwrap()] = case["value"].clone();
            } else {
                target[key] = case["value"].clone();
            }
            assert_eq!(
                Project::from_json(&value.to_string()).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
    #[test]
    fn screen_view_budgets_share_browser_contract() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../examples/screen-view-budget-cases.json"
        ))
        .unwrap();
        for case in cases {
            let mut value: Value = serde_json::from_str(include_str!(
                "../../../examples/embedded-screen.project.json"
            ))
            .unwrap();
            let count = |key: &str| case[key].as_u64().unwrap() as usize;
            let symbol_id = value["symbols"][0]["id"].clone();
            value["symbols"][0]["folders"] = serde_json::json!([]);
            value["symbols"][0]["objects"]=Value::Array((0..count("children")).map(|i|serde_json::json!({"id":format!("0199ff03-0000-7000-8000-{i:012}"),"order":i,"x":0,"y":0,"width":5,"height":5,"rotation":0,"visible":false,"shape":{"type":"rectangle","paint":{"fill":{"enabled":true,"paint":{"type":"solid","color":"#000000","alpha":1}},"stroke":null}}})).collect());
            value["screens"][1]["folders"] = serde_json::json!([]);
            value["screens"][1]["objects"]=Value::Array((0..count("instances")).map(|i|serde_json::json!({"id":format!("0199ff04-0000-7000-8000-{i:012}"),"order":i,"x":0,"y":0,"width":5,"height":5,"rotation":0,"fill":"#000000","visible":false,"shape":{"type":"symbol","symbolId":symbol_id,"colorMode":"definition"}})).collect());
            let template = value["screens"][0]["objects"][1].clone();
            let mut objects = vec![value["screens"][0]["objects"][0].clone()];
            for i in 0..count("views") {
                let mut object = template.clone();
                object["id"] = Value::String(format!("0199ff05-0000-7000-8000-{i:012}"));
                object["order"] = serde_json::json!(i + 1);
                object["visible"] = Value::Bool(false);
                objects.push(object);
            }
            value["screens"][0]["objects"] = Value::Array(objects);
            assert_eq!(
                Project::from_json(&value.to_string()).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
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
    fn image_crop_shares_the_browser_contract() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../examples/image-crop-cases.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let mut value: Value =
                serde_json::from_str(include_str!("../../../examples/minimal.project.json"))
                    .unwrap();
            let id = "0199fc00-0000-7000-8000-000000001100";
            value["assets"] = serde_json::json!([{"id":id,"sha256":"1".repeat(64),"mime":"image/png","byteLength":100,"width":400,"height":200,"name":"原本.png"}]);
            let mut object = serde_json::json!({"id":"0199fc00-0000-7000-8000-000000001101","order":0,"x":100,"y":120,"width":200,"height":150,"rotation":0,"fill":"#000000","shape":{"type":"image","assetId":id,"fit":"contain"}});
            if let Some(crop) = case.get("crop") {
                object["shape"]["crop"] = crop.clone();
            }
            value["screens"][0]["objects"] = serde_json::json!([object]);
            assert_eq!(
                Project::from_json(&value.to_string()).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn image_placements_share_assets_and_reject_missing_references_and_symbol_children() {
        let mut value: Value =
            serde_json::from_str(include_str!("../../../examples/minimal.project.json")).unwrap();
        let id = "0199fc00-0000-7000-8000-000000001100";
        value["assets"] = serde_json::json!([{"id":id,"sha256":"0".repeat(64),"mime":"image/png","byteLength":100,"width":400,"height":200,"name":"設備.png"}]);
        let object = serde_json::json!({"id":"0199fc00-0000-7000-8000-000000001101","order":0,"x":100,"y":120,"width":200,"height":150,"rotation":37,"opacity":0.4,"fill":"#000000","shape":{"type":"image","assetId":id,"fit":"contain"}});
        value["screens"][0]["objects"] = serde_json::json!([object]);
        assert!(Project::from_json(&value.to_string()).is_ok());
        value["screens"][0]["backgroundImage"] =
            serde_json::json!({"assetId":id,"fit":"contain","opacity":0.5});
        assert!(Project::from_json(&value.to_string()).is_ok());
        let mut missing = value.clone();
        missing["assets"] = serde_json::json!([]);
        assert!(Project::from_json(&missing.to_string())
            .unwrap_err()
            .contains("資産"));
        let mut alpha = value.clone();
        alpha["screens"][0]["objects"][0]["colorAlpha"] = serde_json::json!(0.5);
        assert!(Project::from_json(&alpha.to_string()).is_err());
        let mut child = object.clone();
        child["id"] = serde_json::json!("0199fc00-0000-7000-8000-000000001103");
        value["symbols"] = serde_json::json!([{"id":"0199fc00-0000-7000-8000-000000001102","name":"共有","width":200,"height":150,"folders":[],"objects":[child]}]);
        assert!(Project::from_json(&value.to_string()).is_err());
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
    fn image_assets_share_the_browser_contract() {
        let base: Value =
            serde_json::from_str(include_str!("../../../examples/minimal.project.json")).unwrap();
        let cases: Value =
            serde_json::from_str(include_str!("../../../examples/image-asset-cases.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let mut value = base.clone();
            let asset = serde_json::json!({"id":"0199fc00-0000-7000-8000-000000001100","sha256":"0".repeat(64),"mime":"image/png","byteLength":100,"width":100,"height":60,"name":"設備背景.png"});
            value["assets"] = serde_json::json!([asset]);
            value["screens"][0]["backgroundImage"] = serde_json::json!({"assetId":"0199fc00-0000-7000-8000-000000001100","fit":"contain","opacity":1});
            for (field, target) in [("assetPatch", "asset"), ("imagePatch", "image")] {
                if let Some(patch) = case[field].as_object() {
                    for (key, entry) in patch {
                        if target == "asset" {
                            value["assets"][0][key] = entry.clone();
                        } else {
                            value["screens"][0]["backgroundImage"][key] = entry.clone();
                        }
                    }
                }
            }
            if case["removeAssets"] == true {
                value["assets"] = serde_json::json!([]);
            }
            if case["omitImage"] == true {
                value["screens"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("backgroundImage");
            }
            if case["duplicateHash"] == true {
                let mut duplicate = value["assets"][0].clone();
                duplicate["id"] = serde_json::json!("0199fc00-0000-7000-8000-000000001101");
                value["assets"].as_array_mut().unwrap().push(duplicate);
            }
            if case["projectId"] == true {
                let id = value["manifest"]["projectId"].clone();
                value["assets"][0]["id"] = id.clone();
                value["screens"][0]["backgroundImage"]["assetId"] = id;
            }
            if case["oldVersion"] == true {
                value["manifest"]["schemaVersion"] = serde_json::json!("0.15.0");
                value["manifest"]["minRuntimeVersion"] = serde_json::json!("0.15.0");
            }
            assert_eq!(
                Project::from_json(&value.to_string()).is_ok(),
                case["valid"] == true,
                "{case}"
            );
        }
    }
    #[test]
    fn color_alpha_shares_the_browser_contract() {
        let base: Value =
            serde_json::from_str(include_str!("../../../examples/process.project.json")).unwrap();
        let cases: Value =
            serde_json::from_str(include_str!("../../../examples/opacity-cases.json")).unwrap();
        for owners in ["screens", "symbols"] {
            for index in 0..base[owners][0]["objects"].as_array().unwrap().len() {
                for field in ["colorAlpha", "strokeAlpha"] {
                    if field == "strokeAlpha"
                        && base[owners][0]["objects"][index]["shape"]["type"] != "rectangle"
                        && base[owners][0]["objects"][index]["shape"]["type"] != "ellipse"
                    {
                        continue;
                    }
                    for case in cases.as_array().unwrap() {
                        let mut value = base.clone();
                        let object = &mut value[owners][0]["objects"][index];
                        let (target, key) = if field == "colorAlpha" {
                            (object, "colorAlpha")
                        } else {
                            if object["shape"]["paint"]["stroke"].is_null() {
                                object["shape"]["paint"]["stroke"] =
                                    serde_json::json!({"color":"#334155", "width":4});
                            }
                            (&mut object["shape"]["paint"]["stroke"], "alpha")
                        };
                        if case["missing"] == true {
                            target.as_object_mut().unwrap().remove(key);
                        } else {
                            target[key] = case["value"].clone();
                        }
                        assert_eq!(
                            Project::from_json(&value.to_string()).is_ok(),
                            case["valid"] == true
                                && !(field == "colorAlpha"
                                    && ["rectangle", "ellipse"].contains(
                                        &base[owners][0]["objects"][index]["shape"]["type"]
                                            .as_str()
                                            .unwrap()
                                    )
                                    && case.get("missing").is_none()),
                            "{owners} {index} {field} {case}"
                        );
                    }
                }
            }
        }
    }
    #[test]
    fn opacity_shares_the_browser_contract() {
        let base: Value =
            serde_json::from_str(include_str!("../../../examples/process.project.json")).unwrap();
        let cases: Value =
            serde_json::from_str(include_str!("../../../examples/opacity-cases.json")).unwrap();
        for owners in ["screens", "symbols"] {
            for index in 0..base[owners][0]["objects"].as_array().unwrap().len() {
                for case in cases.as_array().unwrap() {
                    let mut value = base.clone();
                    let object = value[owners][0]["objects"][index].as_object_mut().unwrap();
                    if case["missing"] == true {
                        object.remove("opacity");
                    } else {
                        object.insert("opacity".into(), case["value"].clone());
                    }
                    assert_eq!(
                        Project::from_json(&value.to_string()).is_ok(),
                        case["valid"] == true,
                        "{owners} {index} {case}"
                    );
                }
            }
        }
        let mut old = base;
        old["manifest"]["schemaVersion"] = serde_json::json!("0.13.0");
        old["manifest"]["minRuntimeVersion"] = serde_json::json!("0.13.0");
        assert!(Project::from_json(&old.to_string()).is_err());
    }
    #[test]
    fn rotation_shares_the_browser_contract() {
        let base: Value =
            serde_json::from_str(include_str!("../../../examples/process.project.json")).unwrap();
        let cases: Value =
            serde_json::from_str(include_str!("../../../examples/rotation-cases.json")).unwrap();
        for owners in ["screens", "symbols"] {
            for index in 0..base[owners][0]["objects"].as_array().unwrap().len() {
                for case in cases.as_array().unwrap() {
                    let mut value = base.clone();
                    let object = value[owners][0]["objects"][index].as_object_mut().unwrap();
                    if case["missing"] == true {
                        object.remove("rotation");
                    } else {
                        object.insert("rotation".into(), case["angle"].clone());
                    }
                    assert_eq!(
                        Project::from_json(&value.to_string()).is_ok(),
                        case["valid"] == true,
                        "{owners} {index} {case}"
                    );
                }
            }
        }
        let mut old = base;
        old["manifest"]["schemaVersion"] = serde_json::json!("0.10.0");
        old["manifest"]["minRuntimeVersion"] = serde_json::json!("0.10.0");
        assert!(Project::from_json(&old.to_string()).is_err());
    }
    #[test]
    fn shape_paint_shares_the_browser_contract() {
        let pattern =
            Project::from_json(include_str!("../../../examples/pattern-paint.project.json"))
                .unwrap();
        assert_eq!(Project::from_json(&pattern.to_json()).unwrap(), pattern);
        let gradient = Project::from_json(include_str!(
            "../../../examples/gradient-paint.project.json"
        ))
        .unwrap();
        assert_eq!(Project::from_json(&gradient.to_json()).unwrap(), gradient);
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
            if let Some(patch) = case.get("objectPatch").and_then(Value::as_object) {
                object.as_object_mut().unwrap().extend(patch.clone());
            }
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
                value["screens"][0]["objects"][index]["shape"] = serde_json::json!({"type":"ellipse","paint":{"fill":{"enabled":true,"paint":{"type":"solid","color":"#83bfcd","alpha":1}},"stroke":null}});
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
    fn line_styles_share_the_browser_contract() {
        let sample: Value =
            serde_json::from_str(include_str!("../../../examples/process.project.json")).unwrap();
        let cases: Value =
            serde_json::from_str(include_str!("../../../examples/line-style-cases.json")).unwrap();
        for owner in ["screens", "symbols"] {
            for i in 0..sample[owner][0]["objects"].as_array().unwrap().len() {
                let kind = sample[owner][0]["objects"][i]["shape"]["type"]
                    .as_str()
                    .unwrap();
                if !["rectangle", "ellipse", "polyline"].contains(&kind) {
                    continue;
                }
                for case in cases.as_array().unwrap() {
                    let mut value = sample.clone();
                    let shape = &mut value[owner][0]["objects"][i]["shape"];
                    let target = if kind == "polyline" {
                        shape
                    } else {
                        if shape["paint"]["stroke"].is_null() {
                            shape["paint"]["stroke"] =
                                serde_json::json!({"color":"#334155","width":4});
                        }
                        &mut shape["paint"]["stroke"]
                    };
                    if case.get("missing").is_some() {
                        target.as_object_mut().unwrap().remove("lineStyle");
                    } else {
                        target["lineStyle"] = case["value"].clone();
                    }
                    assert_eq!(
                        Project::from_json(&value.to_string()).is_ok(),
                        case["valid"].as_bool().unwrap(),
                        "{owner}/{i}: {}",
                        case["name"]
                    );
                }
            }
        }
    }
    #[test]
    fn text_styles_share_the_browser_contract() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../examples/text-style-cases.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let mut value: Value = serde_json::from_str(SAMPLE).unwrap();
            let object = value["screens"][0]["objects"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|o| o["shape"]["type"] == "text")
                .unwrap();
            if case.get("missing").is_some() {
                object["shape"].as_object_mut().unwrap().remove("style");
            } else {
                object["shape"]["style"] = case["value"].clone();
            }
            assert_eq!(
                Project::from_json(&value.to_string()).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
        let lines: Value =
            serde_json::from_str(include_str!("../../../examples/text-line-cases.json")).unwrap();
        for case in lines.as_array().unwrap() {
            let mut value: Value = serde_json::from_str(SAMPLE).unwrap();
            let object = value["screens"][0]["objects"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|o| o["shape"]["type"] == "text")
                .unwrap();
            object["shape"]["text"] = case["text"].clone();
            assert_eq!(
                Project::from_json(&value.to_string()).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{:?}",
                case["text"]
            );
        }
    }
    #[test]
    fn migrates_legacy_without_losing_geometry_or_identity() {
        let input = include_str!("../../../examples/legacy.project.json");
        let old: Value = serde_json::from_str(input).unwrap();
        let project = Project::from_json(input).unwrap();
        assert_eq!(project.0["manifest"]["schemaVersion"], "0.23.0");
        assert_eq!(project.0["manifest"]["minRuntimeVersion"], "0.23.0");
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
            screen["groups"] = serde_json::json!([]);
            for object in screen["objects"].as_array_mut().unwrap() {
                object["rotation"] = serde_json::json!(0);
                if object["shape"]["type"] == "text" {
                    object["shape"]["style"] = serde_json::json!({"fontSize":(object["height"].as_f64().unwrap() * 0.7).min(512.0),"fontWeight":"normal","align":"left"});
                }
                if object["shape"]["type"] == "rectangle" || object["shape"]["type"] == "ellipse" {
                    object["shape"]["paint"] = serde_json::json!({"fill":{"enabled":true,"paint":{"type":"solid","color":object["fill"].clone(),"alpha":1}},"stroke":null});
                    object.as_object_mut().unwrap().remove("fill");
                }
            }
        }
        assert_eq!(project.0["screens"], screens);
        assert_eq!(project.0["symbols"], serde_json::json!([]));
        let mut large_text = old.clone();
        let text = large_text["screens"][0]["objects"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|o| o["shape"]["type"] == "text")
            .unwrap();
        text["height"] = serde_json::json!(1000);
        let migrated = Project::from_json(&large_text.to_string()).unwrap();
        let text = migrated.0["screens"][0]["objects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["shape"]["type"] == "text")
            .unwrap();
        assert_eq!(text["height"], 1000);
        assert_eq!(text["shape"]["style"]["fontSize"], 512.0);
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
