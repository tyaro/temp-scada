//! SDK の current snapshot を SCADA の読み取り表示へ変換する。
//! 接続・再試行・Stale 判定・式評価を実装せず、書込み API を公開しない。
use std::collections::{BTreeMap, HashMap};

use banto_tagclient::{
    resolve_bindings, BindingRequest, CatalogSnapshot, CollectionMode, TagClientConnectionState,
    TagClientState, ValueQuality, ValueSource, ValuesSnapshot,
};
use scada_model::{Project, TextBinding};
use serde::Serialize;

#[derive(Debug, Clone)]
pub struct BindingPlan {
    project_id: String,
    project_revision: u64,
    references: BTreeMap<String, Vec<TextBinding>>,
}

impl BindingPlan {
    pub fn new(project: &Project) -> Self {
        let mut references: BTreeMap<String, Vec<TextBinding>> = BTreeMap::new();
        for binding in project.text_bindings() {
            references
                .entry(binding.external_name.clone())
                .or_default()
                .push(binding);
        }
        Self {
            project_id: project.id().into(),
            project_revision: project.revision(),
            references,
        }
    }

    /// SDK は要求の外部名重複を拒否するため、一意な名前だけを要求する。
    pub fn requests(&self) -> Vec<BindingRequest> {
        self.references
            .keys()
            .map(|name| BindingRequest {
                binding_key: name.clone(),
                external_name: name.clone(),
            })
            .collect()
    }

    pub fn references(&self) -> &BTreeMap<String, Vec<TextBinding>> {
        &self.references
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum NumericReading {
    Disconnected,
    Unresolved,
    Invalid,
    Resolved {
        quality: Quality,
        numeric_value: Option<f64>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Good,
    Stale,
    Bad,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub catalog_revision: u64,
    pub run_id: Option<u64>,
    pub collection_mode: String,
    pub value_source: String,
    pub source_timestamp_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeView {
    pub project_id: String,
    pub project_revision: u64,
    pub connection: String,
    pub last_error: Option<String>,
    pub metadata_ready: bool,
    pub readings: BTreeMap<String, NumericReading>,
    pub provenance: BTreeMap<String, Provenance>,
}

/// catalog は同じ revision / run_id / collection_mode のものだけを使用する。
/// host は各 SDK watch 更新で投影し、非 Live 状態の旧値を保持しないこと。
pub fn project_view(
    plan: &BindingPlan,
    state: &TagClientState,
    catalog: Option<&CatalogSnapshot>,
) -> RuntimeView {
    let mut view = RuntimeView {
        project_id: plan.project_id.clone(),
        project_revision: plan.project_revision,
        connection: state.connection_state().to_string(),
        last_error: state.last_error().map(|kind| kind.as_str().into()),
        metadata_ready: false,
        readings: plan
            .references
            .keys()
            .map(|name| (name.clone(), NumericReading::Disconnected))
            .collect(),
        provenance: BTreeMap::new(),
    };
    if state.connection_state() == TagClientConnectionState::Live {
        if let (Some(snapshot), Some(catalog)) = (state.current(), catalog) {
            project_snapshot(plan, snapshot, catalog, &mut view);
        } else {
            view.readings
                .values_mut()
                .for_each(|reading| *reading = NumericReading::Invalid);
        }
    }
    view
}

fn project_snapshot(
    plan: &BindingPlan,
    snapshot: &ValuesSnapshot,
    catalog: &CatalogSnapshot,
    view: &mut RuntimeView,
) {
    view.readings
        .values_mut()
        .for_each(|reading| *reading = NumericReading::Invalid);
    if snapshot.revision != catalog.revision
        || snapshot.run_id != catalog.run_id
        || snapshot.collection_mode != catalog.collection_mode
        || matches!(catalog.collection_mode, CollectionMode::Unknown(_))
        || resolve_bindings(&plan.requests(), &catalog.tags).is_err()
    {
        return;
    }
    view.metadata_ready = true;
    let tags: HashMap<_, _> = catalog
        .tags
        .iter()
        .map(|tag| (tag.external_name.as_str(), tag))
        .collect();
    let mut values = HashMap::new();
    for value in &snapshot.values {
        // SDK の current snapshot に同名が複数あっても任意の 1 件を採用しない。
        if values.insert(value.tag.as_str(), value).is_some() {
            view.metadata_ready = false;
            return;
        }
    }
    for (name, reading) in &mut view.readings {
        let Some(tag) = tags.get(name.as_str()) else {
            *reading = NumericReading::Unresolved;
            continue;
        };
        if !tag.enabled
            || !matches!(
                tag.data_type.as_str(),
                "i16" | "u16" | "i32" | "u32" | "f32" | "i64" | "u64" | "f64"
            )
            || matches!(tag.value_source, ValueSource::Unknown(_))
        {
            continue;
        }
        let Some(value) = values.get(name.as_str()) else {
            continue;
        };
        if value.value_source != tag.value_source {
            continue;
        }
        *reading = match value.q {
            ValueQuality::Good => match value.v.filter(|v| v.is_finite()) {
                Some(value) => NumericReading::Resolved {
                    quality: Quality::Good,
                    numeric_value: Some(value),
                },
                None => NumericReading::Invalid,
            },
            // 欠測状態で過去値を数値として再利用できないように payload にも含めない。
            ValueQuality::Stale => NumericReading::Resolved {
                quality: Quality::Stale,
                numeric_value: None,
            },
            ValueQuality::Bad => NumericReading::Resolved {
                quality: Quality::Bad,
                numeric_value: None,
            },
            ValueQuality::Unknown(_) => NumericReading::Invalid,
        };
        if matches!(reading, NumericReading::Resolved { .. }) {
            view.provenance.insert(
                name.clone(),
                Provenance {
                    catalog_revision: catalog.revision,
                    run_id: catalog.run_id,
                    collection_mode: catalog.collection_mode.as_str().into(),
                    value_source: value.value_source.as_str().into(),
                    source_timestamp_ms: value.t,
                },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use banto_tagclient::{CatalogTag, StableTagId, ValueEntry};
    use serde_json::json;
    fn plan() -> BindingPlan {
        BindingPlan::new(
            &Project::from_json(include_str!("../../../examples/tag-binding.project.json"))
                .unwrap(),
        )
    }
    fn name() -> &'static str {
        "PLC01.Fast.Tank01.Level"
    }
    fn catalog() -> CatalogSnapshot {
        CatalogSnapshot {
            revision: 3,
            run_id: Some(7),
            collection_mode: CollectionMode::Configured,
            tags: vec![CatalogTag {
                external_name: name().into(),
                tag_key: "key".into(),
                ids: StableTagId::new(1, 2, 3),
                connection: "PLC01".into(),
                group: "Fast".into(),
                name: "Tank01.Level".into(),
                address: "D100".into(),
                data_type: "f64".into(),
                unit: Some("%".into()),
                decimals: 1,
                period_ms: 100,
                enabled: true,
                writable: false,
                tag_kind: "tag".into(),
                expression: None,
                retain: false,
                simulation: false,
                configured_simulation: false,
                effective_simulation: false,
                value_source: ValueSource::Real,
            }],
        }
    }
    fn snapshot() -> ValuesSnapshot {
        ValuesSnapshot {
            revision: 3,
            run_id: Some(7),
            collection_mode: CollectionMode::Configured,
            t: 10,
            values: vec![ValueEntry {
                tag: name().into(),
                v: Some(12.5),
                q: ValueQuality::Good,
                t: 10,
                value_source: ValueSource::Real,
            }],
        }
    }
    fn view(
        plan: &BindingPlan,
        snapshot: &ValuesSnapshot,
        catalog: &CatalogSnapshot,
    ) -> RuntimeView {
        let mut view = RuntimeView {
            project_id: plan.project_id.clone(),
            project_revision: plan.project_revision,
            connection: "live".into(),
            last_error: None,
            metadata_ready: false,
            readings: plan
                .references
                .keys()
                .map(|name| (name.clone(), NumericReading::Disconnected))
                .collect(),
            provenance: BTreeMap::new(),
        };
        project_snapshot(plan, snapshot, catalog, &mut view);
        view
    }
    #[test]
    fn presentation_fixture_matches_typescript_and_never_leaks_retained_values() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../examples/runtime-reading-cases.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            let mut snapshot = snapshot();
            snapshot.values[0].q = ValueQuality::parse(case["quality"].as_str().unwrap());
            snapshot.values[0].v = case["value"].as_f64();
            let view = view(&plan(), &snapshot, &catalog());
            let mut expected = case["reading"].clone();
            // JSON の 0 と 0.0 は同じ数値。serde_json の内部表現だけを揃えて比較する。
            if let Some(value) = expected["numericValue"].as_f64() {
                expected["numericValue"] = json!(value);
            }
            assert_eq!(
                serde_json::to_value(&view.readings[name()]).unwrap(),
                expected,
                "{}",
                case["name"]
            );
        }
    }
    #[test]
    fn metadata_changes_never_publish_a_value_from_another_generation() {
        for change in 0..4 {
            let mut catalog = catalog();
            match change {
                0 => catalog.revision += 1,
                1 => catalog.run_id = Some(8),
                2 => catalog.collection_mode = CollectionMode::AllSimulation,
                _ => catalog.collection_mode = CollectionMode::Unknown("future".into()),
            }
            let view = view(&plan(), &snapshot(), &catalog);
            assert!(!view.metadata_ready);
            assert_eq!(view.readings[name()], NumericReading::Invalid);
            assert!(view.provenance.is_empty());
        }
    }
    #[test]
    fn type_and_source_checks_fail_closed_without_dropping_the_project() {
        for change in 0..6 {
            let mut catalog = catalog();
            match change {
                0 => catalog.tags[0].data_type = "string".into(),
                1 => catalog.tags[0].data_type = "bit".into(),
                2 => catalog.tags[0].data_type = "future".into(),
                3 => catalog.tags[0].enabled = false,
                4 => catalog.tags[0].value_source = ValueSource::Simulation,
                _ => catalog.tags[0].value_source = ValueSource::Unknown("future".into()),
            }
            assert_eq!(
                view(&plan(), &snapshot(), &catalog).readings[name()],
                NumericReading::Invalid
            );
        }
    }
    #[test]
    fn simulation_provenance_is_retained_and_non_finite_values_are_invalid() {
        let mut snapshot = snapshot();
        let mut catalog = catalog();
        snapshot.collection_mode = CollectionMode::AllSimulation;
        catalog.collection_mode = CollectionMode::AllSimulation;
        snapshot.values[0].value_source = ValueSource::Simulation;
        catalog.tags[0].value_source = ValueSource::Simulation;
        let result = view(&plan(), &snapshot, &catalog);
        assert_eq!(result.provenance[name()].value_source, "simulation");
        assert_eq!(result.provenance[name()].collection_mode, "all_simulation");
        for value in [f64::NAN, f64::INFINITY] {
            snapshot.values[0].v = Some(value);
            assert_eq!(
                view(&plan(), &snapshot, &catalog).readings[name()],
                NumericReading::Invalid
            );
        }
    }
    #[test]
    fn duplicate_rows_are_not_arbitrarily_resolved_and_missing_names_are_local() {
        let mut catalog = catalog();
        catalog.tags.push(catalog.tags[0].clone());
        assert!(!view(&plan(), &snapshot(), &catalog).metadata_ready);
        let mut snapshot = snapshot();
        snapshot.values.push(snapshot.values[0].clone());
        assert!(!view(&plan(), &snapshot, &self::catalog()).metadata_ready);
        let mut project: serde_json::Value =
            serde_json::from_str(include_str!("../../../examples/tag-binding.project.json"))
                .unwrap();
        let mut other = project["screens"][0]["objects"][2].clone();
        other["id"] = json!("0199f000-0000-7000-8000-000000000006");
        other["order"] = json!(6);
        other["shape"]["binding"]["externalName"] = json!("missing");
        project["screens"][0]["objects"]
            .as_array_mut()
            .unwrap()
            .push(other);
        let plan = BindingPlan::new(&Project::from_json(&project.to_string()).unwrap());
        let result = view(&plan, &self::snapshot(), &self::catalog());
        assert_eq!(result.readings["missing"], NumericReading::Unresolved);
        assert!(matches!(
            result.readings[name()],
            NumericReading::Resolved { .. }
        ));
    }
    #[test]
    fn request_plan_groups_shared_names_without_losing_placement_ids() {
        let mut project: serde_json::Value =
            serde_json::from_str(include_str!("../../../examples/tag-binding.project.json"))
                .unwrap();
        let mut copy = project["screens"][0]["objects"][2].clone();
        copy["id"] = json!("0199f000-0000-7000-8000-000000000006");
        copy["order"] = json!(6);
        project["screens"][0]["objects"]
            .as_array_mut()
            .unwrap()
            .push(copy);
        let plan = BindingPlan::new(&Project::from_json(&project.to_string()).unwrap());
        assert_eq!(plan.requests().len(), 1);
        assert_eq!(plan.references()[name()].len(), 2);
        assert_ne!(
            plan.references()[name()][0].object_id,
            plan.references()[name()][1].object_id
        );
        assert!(BindingPlan::new(
            &Project::from_json(include_str!("../../../examples/minimal.project.json")).unwrap()
        )
        .requests()
        .is_empty());
    }
}
