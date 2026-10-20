use serde_json::Value;
use std::collections::{HashMap, HashSet};
pub(crate) fn validate<'a>(project: &'a Value, ids: &mut HashSet<&'a str>) -> Result<(), String> {
    let mut types = HashMap::new();
    for kind in project["equipmentTypes"].as_array().into_iter().flatten() {
        let id = kind["id"].as_str().unwrap();
        if !ids.insert(id) {
            return Err("ID が重複しています".into());
        }
        types.insert(id, kind);
        let mut names = HashSet::new();
        for slot in kind["slots"].as_array().unwrap() {
            if !names.insert(slot["name"].as_str().unwrap()) {
                return Err("slot名が重複しています".into());
            }
        }
    }
    let mut codes = HashSet::new();
    for equipment in project["equipment"].as_array().into_iter().flatten() {
        if !ids.insert(equipment["id"].as_str().unwrap()) {
            return Err("ID が重複しています".into());
        }
        if !codes.insert(equipment["code"].as_str().unwrap()) {
            return Err("機器番号が重複しています".into());
        }
        let Some(kind) = types.get(equipment["typeId"].as_str().unwrap()) else {
            return Err("機器種別が見つかりません".into());
        };
        let slots: HashSet<_> = kind["slots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|slot| slot["name"].as_str().unwrap())
            .collect();
        let mut bound = HashSet::new();
        for binding in equipment["bindings"].as_array().unwrap() {
            let name = binding["slotName"].as_str().unwrap();
            if !slots.contains(name) {
                return Err("未宣言のslotです".into());
            }
            if !bound.insert(name) {
                return Err("slot割付が重複しています".into());
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EquipmentReadType {
    Bool,
    Number,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EquipmentReadBinding {
    pub equipment_id: String,
    pub slot_name: String,
    pub slot_type: EquipmentReadType,
    pub external_name: Option<String>,
}
impl crate::Project {
    /// Declared but unadopted slots are absent; adopted/unassigned slots keep None.
    pub fn equipment_read_bindings(&self) -> Vec<EquipmentReadBinding> {
        let types: HashMap<_, _> = self.0["equipmentTypes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|kind| (kind["id"].as_str().unwrap(), kind))
            .collect();
        self.0["equipment"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|item| {
                let kind = types[item["typeId"].as_str().unwrap()];
                item["bindings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(move |binding| {
                        let slot = kind["slots"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|slot| slot["name"] == binding["slotName"])
                            .unwrap();
                        EquipmentReadBinding {
                            equipment_id: item["id"].as_str().unwrap().into(),
                            slot_name: binding["slotName"].as_str().unwrap().into(),
                            slot_type: if slot["type"] == "bool" {
                                EquipmentReadType::Bool
                            } else {
                                EquipmentReadType::Number
                            },
                            external_name: binding["externalName"].as_str().map(String::from),
                        }
                    })
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_contract_and_roundtrip() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../examples/equipment-cases.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let mut project: Value =
                serde_json::from_str(include_str!("../../../examples/minimal.project.json"))
                    .unwrap();
            project["equipmentTypes"] = case["equipmentTypes"].clone();
            project["equipment"] = case["equipment"].clone();
            let result = crate::Project::from_json(&project.to_string());
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}: {:?}",
                case["name"],
                result.err()
            );
        }
    }
    #[test]
    fn adopted_unassigned_and_unadopted_are_distinct() {
        let project =
            crate::Project::from_json(include_str!("../../../examples/equipment.project.json"))
                .unwrap();
        let bindings = project.equipment_read_bindings();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].slot_name, "running");
        assert_eq!(bindings[0].slot_type, EquipmentReadType::Bool);
        assert!(bindings[0].external_name.is_none());
        assert!(
            crate::Project::from_json(include_str!("../../../examples/minimal.project.json"))
                .unwrap()
                .equipment_read_bindings()
                .is_empty()
        );
    }
}
