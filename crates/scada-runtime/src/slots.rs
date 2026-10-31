//! Equipment永続化の前段となる、Host内部の型付き読取context。Project形式ではない。
use std::collections::{BTreeMap, BTreeSet};

use banto_tagclient::{BindingRequest, TagClientConnectionState, TagClientState};
#[cfg(test)]
use banto_tagclient::{CatalogSnapshot, ValuesSnapshot};
use serde::Serialize;

use crate::{projection::SnapshotIndex, Provenance, Quality};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReadSlotType {
    Bool,
    Number,
}

/// 区切り文字を連結してkeyを作らず、機器とslotを別々に識別する。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSlotKey {
    pub equipment_id: String,
    pub slot_name: String,
}

#[derive(Debug, Clone)]
pub struct ReadSlotRequest {
    pub key: ReadSlotKey,
    pub expected_type: ReadSlotType,
    /// Noneは採用済みだが未割付。機能未採用のslotはplanへ入れない。
    pub external_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadSlotPlanError {
    BlankProjectId,
    BlankEquipmentId,
    BlankSlotName,
    BlankExternalName,
    DuplicateKey(ReadSlotKey),
}

#[derive(Debug, Clone)]
pub struct ReadSlotPlan {
    project_id: String,
    project_revision: u64,
    slots: BTreeMap<ReadSlotKey, ReadSlotRequest>,
}

impl ReadSlotPlan {
    /// Builds only adopted read slots from the validated Project. Values stay outside it.
    pub fn from_project(project: &scada_model::Project) -> Result<Self, ReadSlotPlanError> {
        let requests = project
            .equipment_read_bindings()
            .into_iter()
            .map(|binding| ReadSlotRequest {
                key: ReadSlotKey {
                    equipment_id: binding.equipment_id,
                    slot_name: binding.slot_name,
                },
                expected_type: match binding.slot_type {
                    scada_model::EquipmentReadType::Bool => ReadSlotType::Bool,
                    scada_model::EquipmentReadType::Number => ReadSlotType::Number,
                },
                external_name: binding.external_name,
            });
        Self::new(project.id().into(), project.revision(), requests)
    }

    /// IDと外部名は呼出元の確定値を保持する。trim・名前推測・タグ作成をしない。
    pub fn new(
        project_id: String,
        project_revision: u64,
        requests: impl IntoIterator<Item = ReadSlotRequest>,
    ) -> Result<Self, ReadSlotPlanError> {
        if project_id.trim().is_empty() {
            return Err(ReadSlotPlanError::BlankProjectId);
        }
        let mut slots = BTreeMap::new();
        for request in requests {
            if request.key.equipment_id.trim().is_empty() {
                return Err(ReadSlotPlanError::BlankEquipmentId);
            }
            if request
                .key
                .slot_name
                .chars()
                .all(|ch| ch.is_whitespace() || ch == '\u{feff}')
            {
                return Err(ReadSlotPlanError::BlankSlotName);
            }
            if request.external_name.as_ref().is_some_and(|name| {
                name.chars()
                    .all(|ch| ch.is_whitespace() || ch == '\u{feff}')
            }) {
                return Err(ReadSlotPlanError::BlankExternalName);
            }
            let key = request.key.clone();
            if slots.insert(key.clone(), request).is_some() {
                return Err(ReadSlotPlanError::DuplicateKey(key));
            }
        }
        Ok(Self {
            project_id,
            project_revision,
            slots,
        })
    }

    /// 同じタグを複数機器・用途で使っても、SDKへは外部名を一度だけ要求する。
    pub fn requests(&self) -> Vec<BindingRequest> {
        self.slots
            .values()
            .filter_map(|slot| slot.external_name.as_ref())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(|name| BindingRequest {
                binding_key: name.clone(),
                external_name: name.clone(),
            })
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "lowercase")]
pub enum ReadSlotValue {
    Bool(bool),
    Number(f64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadSlotInvalidReason {
    MetadataUnavailable,
    MetadataMismatch,
    InvalidCatalog,
    DuplicateValues,
    Disabled,
    TypeMismatch,
    UnknownSource,
    SourceMismatch,
    MissingValue,
    InvalidValue,
    UnknownQuality,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum ReadSlotReading {
    Unassigned,
    Disconnected,
    Unresolved,
    Invalid {
        reason: ReadSlotInvalidReason,
    },
    Resolved {
        quality: Quality,
        value: Option<ReadSlotValue>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSlotResult {
    pub key: ReadSlotKey,
    pub expected_type: ReadSlotType,
    pub external_name: Option<String>,
    pub reading: ReadSlotReading,
    pub provenance: Option<Provenance>,
}

/// Vecにすることで、構造化keyをJSON objectの文字列keyへ無理に変換しない。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadSlotView {
    pub project_id: String,
    pub project_revision: u64,
    pub connection: String,
    pub last_error: Option<String>,
    pub metadata_ready: bool,
    pub slots: Vec<ReadSlotResult>,
}

/// SDK更新ごとに全結果を作り直す。未割付を未接続やfalseへ変換しない。
/// session世代の所有・旧task通知の破棄はReadHostの責務。
pub fn read_slot_view(plan: &ReadSlotPlan, state: &TagClientState) -> ReadSlotView {
    let mut view = ReadSlotView::pending(
        plan,
        state.connection_state().to_string(),
        state.last_error().map(|kind| kind.as_str().into()),
    );
    if matches!(
        state.connection_state(),
        TagClientConnectionState::Live | TagClientConnectionState::Unbound
    ) {
        let index = state
            .snapshot()
            .ok_or(ReadSlotInvalidReason::MetadataUnavailable)
            .and_then(|generation| SnapshotIndex::from_generation(&plan.requests(), generation));
        project_slot_index(index, &mut view);
    }
    view
}

impl ReadSlotView {
    pub(crate) fn pending(
        plan: &ReadSlotPlan,
        connection: String,
        last_error: Option<String>,
    ) -> Self {
        ReadSlotView {
            project_id: plan.project_id.clone(),
            project_revision: plan.project_revision,
            connection,
            last_error,
            metadata_ready: false,
            slots: plan
                .slots
                .values()
                .map(|slot| ReadSlotResult {
                    key: slot.key.clone(),
                    expected_type: slot.expected_type,
                    external_name: slot.external_name.clone(),
                    reading: if slot.external_name.is_some() {
                        ReadSlotReading::Disconnected
                    } else {
                        ReadSlotReading::Unassigned
                    },
                    provenance: None,
                })
                .collect(),
        }
    }
}

#[cfg(test)]
fn project_slot_snapshot(
    plan: &ReadSlotPlan,
    snapshot: Option<&ValuesSnapshot>,
    catalog: Option<&CatalogSnapshot>,
    view: &mut ReadSlotView,
) {
    let index = match (snapshot, catalog) {
        (Some(snapshot), Some(catalog)) => {
            SnapshotIndex::new(&plan.requests(), Some(snapshot), catalog)
        }
        _ => Err(ReadSlotInvalidReason::MetadataUnavailable),
    };
    project_slot_index(index, view);
}

fn project_slot_index(
    index: Result<SnapshotIndex<'_>, ReadSlotInvalidReason>,
    view: &mut ReadSlotView,
) {
    match index {
        Ok(index) => {
            view.metadata_ready = true;
            for result in &mut view.slots {
                if let Some(name) = &result.external_name {
                    (result.reading, result.provenance) = index.read(name, result.expected_type);
                }
            }
        }
        Err(reason) => {
            for result in &mut view.slots {
                if result.external_name.is_some() {
                    result.reading = ReadSlotReading::Invalid { reason };
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{catalog, snapshot};
    use banto_tagclient::{CollectionMode, ValueQuality, ValueSource};
    use serde_json::json;

    fn request(
        equipment: &str,
        slot: &str,
        expected_type: ReadSlotType,
        name: Option<&str>,
    ) -> ReadSlotRequest {
        ReadSlotRequest {
            key: ReadSlotKey {
                equipment_id: equipment.into(),
                slot_name: slot.into(),
            },
            expected_type,
            external_name: name.map(String::from),
        }
    }
    fn plan(requests: Vec<ReadSlotRequest>) -> ReadSlotPlan {
        ReadSlotPlan::new("project".into(), 17, requests).unwrap()
    }
    fn name() -> &'static str {
        "PLC01.Fast.Tank01.Level"
    }
    fn view(
        plan: &ReadSlotPlan,
        snapshot: Option<&ValuesSnapshot>,
        catalog: Option<&CatalogSnapshot>,
    ) -> ReadSlotView {
        let mut view = ReadSlotView::pending(plan, "live".into(), None);
        project_slot_snapshot(plan, snapshot, catalog, &mut view);
        view
    }
    fn number_plan() -> ReadSlotPlan {
        plan(vec![
            request("e1", "value", ReadSlotType::Number, Some(name())),
            request("e2", "value", ReadSlotType::Number, None),
        ])
    }
    fn invalid(view: &ReadSlotView, reason: ReadSlotInvalidReason) {
        assert_eq!(view.slots[0].reading, ReadSlotReading::Invalid { reason });
        assert!(view.slots[0].provenance.is_none());
        if view.slots.len() > 1 {
            assert_eq!(view.slots[1].reading, ReadSlotReading::Unassigned);
        }
    }
    #[test]
    fn browser_read_slot_fixtures_are_actual_rust_projection_and_schema_valid() {
        let schema: serde_json::Value =
            serde_json::from_str(include_str!("../schema/read-slot-view.schema.json")).unwrap();
        let validator = jsonschema::validator_for(&schema).unwrap();
        let fixtures: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../../examples/read-slot-view-cases.json"))
                .unwrap();
        for fixture in fixtures {
            let input = &fixture["input"];
            let mut expected = fixture["view"].clone();
            // JSON integers and floats share the same number semantics in the browser.
            if expected["slots"][0]["reading"]["value"]["type"] == "number" {
                let number = expected["slots"][0]["reading"]["value"]["value"]
                    .as_f64()
                    .unwrap();
                expected["slots"][0]["reading"]["value"]["value"] = json!(number);
            }
            let expected_row = &expected["slots"][0];
            let kind = if input["slotType"] == "bool" {
                ReadSlotType::Bool
            } else {
                ReadSlotType::Number
            };
            let plan = ReadSlotPlan::new(
                expected["projectId"].as_str().unwrap().into(),
                expected["projectRevision"].as_u64().unwrap(),
                [request(
                    expected_row["key"]["equipmentId"].as_str().unwrap(),
                    expected_row["key"]["slotName"].as_str().unwrap(),
                    kind,
                    Some("Demo.Value"),
                )],
            )
            .unwrap();
            let mut metadata = catalog();
            metadata.revision = 7;
            metadata.run_id = Some(17);
            metadata.collection_mode = CollectionMode::parse(input["mode"].as_str().unwrap());
            metadata.tags[0].external_name = "Demo.Value".into();
            metadata.tags[0].data_type = if kind == ReadSlotType::Bool {
                "bit"
            } else {
                "f64"
            }
            .into();
            metadata.tags[0].value_source = ValueSource::parse(
                input["catalogSource"]
                    .as_str()
                    .unwrap_or(input["source"].as_str().unwrap()),
            );
            let mut values = snapshot();
            values.revision = metadata.revision;
            values.run_id = metadata.run_id;
            values.collection_mode = metadata.collection_mode.clone();
            values.values[0].tag = "Demo.Value".into();
            values.values[0].v = input["value"].as_f64();
            values.values[0].t = 1000;
            values.values[0].q = match input["quality"].as_str().unwrap() {
                "good" => ValueQuality::Good,
                "stale" => ValueQuality::Stale,
                _ => ValueQuality::Bad,
            };
            values.values[0].value_source = ValueSource::parse(input["source"].as_str().unwrap());
            if input["missingTag"] == true {
                metadata.tags.clear();
                values.values.clear();
            }
            let projected = if input["connected"] == false {
                ReadSlotView::pending(&plan, "stopped".into(), None)
            } else if input["metadata"] == false {
                view(&plan, None, None)
            } else if input["unbound"] == true {
                let generation = banto_tagclient::GenerationSnapshot {
                    generation: 1,
                    resolution: std::sync::Arc::new(
                        banto_tagclient::resolve_bindings(&plan.requests(), &metadata.tags)
                            .unwrap(),
                    ),
                    catalog: std::sync::Arc::new(metadata),
                    values: None,
                };
                let mut projected = ReadSlotView::pending(&plan, "unbound".into(), None);
                project_slot_index(
                    SnapshotIndex::from_generation(&plan.requests(), &generation),
                    &mut projected,
                );
                projected
            } else {
                view(&plan, Some(&values), Some(&metadata))
            };
            let serialized = serde_json::to_value(projected).unwrap();
            assert_eq!(serialized, expected, "{}", fixture["name"]);
            assert!(validator.is_valid(&serialized), "{}", fixture["name"]);
        }
    }

    #[test]
    fn validated_equipment_project_builds_context_without_copying_placements_or_values() {
        let mut value: serde_json::Value =
            serde_json::from_str(include_str!("../../../examples/equipment.project.json")).unwrap();
        let mut second = value["equipment"][0].clone();
        second["id"] = json!("0199f700-0000-7000-8000-000000000003");
        second["code"] = json!("FAN-102");
        second["bindings"] = json!([{ "slotName": "running", "externalName": "shared" }, { "slotName": "current", "externalName": "shared" }]);
        value["equipment"].as_array_mut().unwrap().push(second);
        let project = scada_model::Project::from_json(&value.to_string()).unwrap();
        let plan = ReadSlotPlan::from_project(&project).unwrap();
        assert_eq!(plan.slots.len(), 3);
        assert_eq!(plan.requests().len(), 1);
        let unassigned = plan
            .slots
            .values()
            .find(|slot| slot.external_name.is_none())
            .unwrap();
        assert_eq!(unassigned.expected_type, ReadSlotType::Bool);
        assert_eq!(
            plan.slots
                .values()
                .filter(|slot| slot.expected_type == ReadSlotType::Number)
                .count(),
            1
        );
        assert_eq!(plan.project_id, project.id());
        assert_eq!(plan.project_revision, project.revision());
    }
    #[test]
    fn plan_validates_keys_without_normalizing_or_guessing_names() {
        let request = request(
            "equipment",
            "value",
            ReadSlotType::Number,
            Some(" exact name "),
        );
        assert_eq!(
            plan(vec![request.clone()]).requests()[0].external_name,
            " exact name "
        );
        assert_eq!(
            ReadSlotPlan::new("p".into(), 0, vec![request.clone(), request.clone()]).unwrap_err(),
            ReadSlotPlanError::DuplicateKey(request.key)
        );
        for (request, expected) in [
            (
                self::request(" ", "value", ReadSlotType::Number, None),
                ReadSlotPlanError::BlankEquipmentId,
            ),
            (
                self::request("e", " ", ReadSlotType::Number, None),
                ReadSlotPlanError::BlankSlotName,
            ),
            (
                self::request("e", "value", ReadSlotType::Number, Some(" ")),
                ReadSlotPlanError::BlankExternalName,
            ),
        ] {
            assert_eq!(
                ReadSlotPlan::new("p".into(), 0, [request]).unwrap_err(),
                expected
            );
        }
        assert_eq!(
            ReadSlotPlan::new(" ".into(), 0, []).unwrap_err(),
            ReadSlotPlanError::BlankProjectId
        );
        assert!(plan(vec![]).requests().is_empty());
        assert!(plan(vec![self::request(
            "e",
            "optional",
            ReadSlotType::Bool,
            None
        )])
        .requests()
        .is_empty());
    }
    #[test]
    fn shared_external_names_fan_out_by_structured_key_and_type_errors_stay_local() {
        let plan = plan(vec![
            request("a:b", "c", ReadSlotType::Number, Some(name())),
            request("a", "b:c", ReadSlotType::Number, Some(name())),
            request("c", "running", ReadSlotType::Bool, Some(name())),
            request("d", "value", ReadSlotType::Number, Some("missing")),
        ]);
        assert_eq!(plan.requests().len(), 2);
        let view = view(&plan, Some(&snapshot()), Some(&catalog()));
        assert!(view.metadata_ready);
        assert_ne!(view.slots[0].key, view.slots[1].key);
        assert_eq!(view.slots[0].reading, view.slots[1].reading);
        assert_eq!(
            view.slots[0].reading,
            ReadSlotReading::Resolved {
                quality: Quality::Good,
                value: Some(ReadSlotValue::Number(12.5))
            }
        );
        assert_eq!(
            view.slots[2].reading,
            ReadSlotReading::Invalid {
                reason: ReadSlotInvalidReason::TypeMismatch
            }
        );
        assert_eq!(view.slots[3].reading, ReadSlotReading::Unresolved);
        let wire = serde_json::to_value(view).unwrap();
        assert_eq!(wire["slots"][0]["key"]["equipmentId"], "a");
        assert_eq!(
            wire["slots"][0]["reading"]["value"],
            json!({ "type": "number", "value": 12.5 })
        );
    }
    #[test]
    fn bool_accepts_only_bit_zero_or_one_and_keeps_polarity_outside_projection() {
        let plan = plan(vec![request(
            "e",
            "running",
            ReadSlotType::Bool,
            Some(name()),
        )]);
        let mut catalog = catalog();
        catalog.tags[0].data_type = "bit".into();
        let mut snapshot = snapshot();
        for (value, expected) in [(0.0, false), (1.0, true)] {
            snapshot.values[0].v = Some(value);
            assert_eq!(
                view(&plan, Some(&snapshot), Some(&catalog)).slots[0].reading,
                ReadSlotReading::Resolved {
                    quality: Quality::Good,
                    value: Some(ReadSlotValue::Bool(expected))
                }
            );
        }
        for value in [
            None,
            Some(2.0),
            Some(-1.0),
            Some(0.5),
            Some(f64::NAN),
            Some(f64::INFINITY),
        ] {
            snapshot.values[0].v = value;
            invalid(
                &view(&plan, Some(&snapshot), Some(&catalog)),
                ReadSlotInvalidReason::InvalidValue,
            );
        }
        for kind in ["bool", "i16", "string", "future"] {
            catalog.tags[0].data_type = kind.into();
            invalid(
                &view(&plan, Some(&snapshot), Some(&catalog)),
                ReadSlotInvalidReason::TypeMismatch,
            );
        }
    }
    #[test]
    fn number_accepts_eight_numeric_types_without_rounding_scaling_or_using_writable() {
        let mut catalog = catalog();
        let mut snapshot = snapshot();
        snapshot.values[0].v = Some(-12.75);
        for kind in ["i16", "u16", "i32", "u32", "f32", "i64", "u64", "f64"] {
            catalog.tags[0].data_type = kind.into();
            for writable in [false, true] {
                catalog.tags[0].writable = writable;
                assert_eq!(
                    view(&number_plan(), Some(&snapshot), Some(&catalog)).slots[0].reading,
                    ReadSlotReading::Resolved {
                        quality: Quality::Good,
                        value: Some(ReadSlotValue::Number(-12.75))
                    }
                );
            }
        }
        for kind in ["bit", "string", "future"] {
            catalog.tags[0].data_type = kind.into();
            invalid(
                &view(&number_plan(), Some(&snapshot), Some(&catalog)),
                ReadSlotInvalidReason::TypeMismatch,
            );
        }
    }
    #[test]
    fn quality_never_exposes_retained_payload_and_preserves_simulation_provenance() {
        let mut catalog = catalog();
        let mut snapshot = snapshot();
        catalog.collection_mode = CollectionMode::AllSimulation;
        snapshot.collection_mode = CollectionMode::AllSimulation;
        catalog.tags[0].value_source = ValueSource::Simulation;
        snapshot.values[0].value_source = ValueSource::Simulation;
        for expected_type in [ReadSlotType::Bool, ReadSlotType::Number] {
            catalog.tags[0].data_type = if expected_type == ReadSlotType::Bool {
                "bit"
            } else {
                "f64"
            }
            .into();
            let plan = plan(vec![request("e", "value", expected_type, Some(name()))]);
            for (quality, expected) in [
                (ValueQuality::Bad, Quality::Bad),
                (ValueQuality::Stale, Quality::Stale),
            ] {
                snapshot.values[0].q = quality;
                snapshot.values[0].v = Some(987.0);
                let result = view(&plan, Some(&snapshot), Some(&catalog));
                assert_eq!(
                    result.slots[0].reading,
                    ReadSlotReading::Resolved {
                        quality: expected,
                        value: None
                    }
                );
                let provenance = result.slots[0].provenance.as_ref().unwrap();
                assert_eq!(provenance.value_source, "simulation");
                assert_eq!(provenance.collection_mode, "all_simulation");
                assert_eq!(provenance.source_timestamp_ms, 10);
                assert!(!serde_json::to_string(&result).unwrap().contains("987"));
            }
            snapshot.values[0].q = ValueQuality::Unknown("future".into());
            invalid(
                &view(&plan, Some(&snapshot), Some(&catalog)),
                ReadSlotInvalidReason::UnknownQuality,
            );
        }
    }
    #[test]
    fn metadata_absence_and_generation_mismatch_keep_unassigned_distinct() {
        let plan = number_plan();
        let pending = ReadSlotView::pending(&plan, "disconnected".into(), None);
        assert_eq!(pending.slots[0].reading, ReadSlotReading::Disconnected);
        assert_eq!(pending.slots[1].reading, ReadSlotReading::Unassigned);
        for (snapshot, catalog) in [(None, Some(catalog())), (Some(snapshot()), None)] {
            let result = view(&plan, snapshot.as_ref(), catalog.as_ref());
            assert!(!result.metadata_ready);
            invalid(&result, ReadSlotInvalidReason::MetadataUnavailable);
        }
        for change in 0..4 {
            let mut catalog = catalog();
            match change {
                0 => catalog.revision += 1,
                1 => catalog.run_id = None,
                2 => catalog.collection_mode = CollectionMode::AllSimulation,
                _ => catalog.collection_mode = CollectionMode::Unknown("future".into()),
            }
            let result = view(&plan, Some(&snapshot()), Some(&catalog));
            assert!(!result.metadata_ready);
            invalid(&result, ReadSlotInvalidReason::MetadataMismatch);
        }
    }
    #[test]
    fn duplicate_catalog_and_value_rows_invalidate_all_bound_slots() {
        let mut catalog = catalog();
        catalog.tags.push(catalog.tags[0].clone());
        let result = view(&number_plan(), Some(&snapshot()), Some(&catalog));
        assert!(!result.metadata_ready);
        invalid(&result, ReadSlotInvalidReason::InvalidCatalog);
        let mut snapshot = snapshot();
        snapshot.values.push(snapshot.values[0].clone());
        let result = view(&number_plan(), Some(&snapshot), Some(&self::catalog()));
        assert!(!result.metadata_ready);
        invalid(&result, ReadSlotInvalidReason::DuplicateValues);
    }
    #[test]
    fn missing_disabled_and_source_failures_are_local_and_never_publish_provenance() {
        for change in 0..3 {
            let mut catalog = catalog();
            let mut snapshot = snapshot();
            let expected = match change {
                0 => {
                    catalog.tags[0].enabled = false;
                    ReadSlotInvalidReason::Disabled
                }
                1 => {
                    snapshot.values.clear();
                    ReadSlotInvalidReason::MissingValue
                }
                _ => {
                    snapshot.values[0].value_source = ValueSource::Unknown("future".into());
                    ReadSlotInvalidReason::UnknownSource
                }
            };
            let mut other_tag = self::catalog().tags[0].clone();
            other_tag.external_name = "other".into();
            other_tag.tag_key = "other-key".into();
            other_tag.ids = banto_tagclient::StableTagId::new(1, 2, 4);
            other_tag.name = "Other".into();
            catalog.tags.push(other_tag);
            let mut other_value = self::snapshot().values[0].clone();
            other_value.tag = "other".into();
            other_value.v = Some(42.0);
            snapshot.values.push(other_value);
            let plan = plan(vec![
                request("e1", "value", ReadSlotType::Number, Some(name())),
                request("e2", "value", ReadSlotType::Number, None),
                request("e3", "value", ReadSlotType::Number, Some("other")),
            ]);
            let result = view(&plan, Some(&snapshot), Some(&catalog));
            assert!(result.metadata_ready);
            invalid(&result, expected);
            assert_eq!(
                result.slots[2].reading,
                ReadSlotReading::Resolved {
                    quality: Quality::Good,
                    value: Some(ReadSlotValue::Number(42.0)),
                }
            );
            assert!(result.slots[2].provenance.is_some());
        }
    }
}
