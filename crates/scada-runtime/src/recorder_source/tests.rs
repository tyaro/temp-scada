use super::*;
use banto_tagclient::{
    resolve_bindings, CatalogSnapshot, CollectionMode, GenerationSnapshot, StableTagId,
    ValueQuality, ValueSource,
};
use scada_historian::store::{
    IdentityDescriptor, ObservationValue, Quality, SessionSpec, Source, ValueType,
};
use std::sync::Arc;

fn plan() -> SdkRecorderPlan {
    SdkRecorderPlan::new(
        SessionSpec {
            session_id: "recording".into(),
            members: vec![IdentityDescriptor {
                series_id: "number".into(),
                hub_instance_id: "hub-a".into(),
                incarnation_id: "life-a".into(),
                external_name: crate::tests::catalog().tags[0].external_name.clone(),
                segment_id: "segment-a".into(),
                value_type: ValueType::Number,
                unit: Some("%".into()),
                period_ms: 1000,
                source: Source::Real,
            }],
        },
        SdkGenerationPin {
            catalog_revision: 3,
            run_id: Some(7),
            collection_mode: CollectionMode::Configured,
        },
        vec![SdkBindingPin {
            series_id: "number".into(),
            stable_id: StableTagId::new(1, 2, 3),
            tag_key: "key".into(),
            data_type: "f64".into(),
        }],
    )
    .unwrap()
}

fn generation(plan: &SdkRecorderPlan) -> GenerationSnapshot {
    let catalog = crate::tests::catalog();
    GenerationSnapshot {
        generation: u64::MAX,
        resolution: Arc::new(resolve_bindings(&plan.requests(), &catalog.tags).unwrap()),
        catalog: Arc::new(catalog),
        values: Some(Arc::new(crate::tests::snapshot())),
    }
}

#[test]
fn value_provenance_comes_from_one_snapshot_and_repeated_source_time_is_valid() {
    let plan = plan();
    let mut generation = generation(&plan);
    Arc::make_mut(&mut generation.catalog).tags[0].value_source = ValueSource::Simulation;
    Arc::make_mut(&mut generation.catalog).tags[0].period_ms = 100;
    let first = projection::capture(&plan, &generation).unwrap().remove(0);
    assert_eq!(first.value, Some(ObservationValue::Number(12.5)));
    assert_eq!(first.source, Some(Source::Real));
    assert_eq!(first.source_time_ms, Some(10));
    assert_eq!(
        first.source_epoch.as_ref().unwrap().sdk_generation,
        u64::MAX
    );
    assert_eq!(first.source_epoch.as_ref().unwrap().run_id, Some(7));
    assert_eq!(
        projection::capture(&plan, &generation).unwrap()[0].source_time_ms,
        Some(10)
    );
}

#[test]
fn quality_and_value_nulls_preserve_provenance_and_never_copy_a_retained_value() {
    let plan = plan();
    for (quality, number, reason) in [
        (ValueQuality::Bad, Some(100.0), Reason::Bad),
        (ValueQuality::Stale, Some(100.0), Reason::Stale),
        (
            ValueQuality::Unknown("future".into()),
            Some(100.0),
            Reason::UnknownQuality,
        ),
        (ValueQuality::Good, None, Reason::MissingValue),
        (ValueQuality::Good, Some(f64::NAN), Reason::NonFinite),
        (ValueQuality::Good, Some(f64::INFINITY), Reason::NonFinite),
    ] {
        let mut generation = generation(&plan);
        let entry = &mut Arc::make_mut(generation.values.as_mut().unwrap()).values[0];
        entry.q = quality;
        entry.v = number;
        let observation = projection::capture(&plan, &generation).unwrap().remove(0);
        assert_eq!(observation.value, None);
        assert_eq!(observation.reason, Some(reason));
        assert_eq!(observation.source, Some(Source::Real));
        assert_eq!(observation.source_time_ms, Some(10));
        assert!(observation.source_epoch.is_some());
    }
}

#[test]
fn simulation_and_unknown_sources_require_their_own_fixed_segment() {
    for (source, sdk_source, reason) in [
        (
            Source::Simulation,
            ValueSource::Simulation,
            Reason::SimulationExcluded,
        ),
        (
            Source::DerivedSimulation,
            ValueSource::DerivedSimulation,
            Reason::SimulationExcluded,
        ),
        (
            Source::Unknown,
            ValueSource::Unknown("future".into()),
            Reason::UnknownSource,
        ),
    ] {
        let mut plan = plan();
        let mut generation = generation(&plan);
        Arc::make_mut(generation.values.as_mut().unwrap()).values[0].value_source = sdk_source;
        assert!(projection::capture(&plan, &generation).is_err());
        plan.session.members[0].source = source;
        let observation = projection::capture(&plan, &generation).unwrap().remove(0);
        assert_eq!(observation.reason, Some(reason));
        assert_eq!(observation.value, None);
    }
}

#[test]
fn boolean_decoding_accepts_only_zero_and_one() {
    let mut plan = plan();
    plan.session.members[0].value_type = ValueType::Bool;
    plan.bindings[0].data_type = "bit".into();
    for (number, expected) in [(0.0, Some(false)), (1.0, Some(true)), (0.5, None)] {
        let mut generation = generation(&plan);
        Arc::make_mut(&mut generation.catalog).tags[0].data_type = "bit".into();
        Arc::make_mut(generation.values.as_mut().unwrap()).values[0].v = Some(number);
        let observation = projection::capture(&plan, &generation).unwrap().remove(0);
        assert_eq!(observation.value, expected.map(ObservationValue::Bool));
        assert_eq!(
            observation.reason,
            expected.is_none().then_some(Reason::TypeMismatch)
        );
    }
}

#[test]
fn absence_has_no_fabricated_provenance() {
    let plan = plan();
    let mut generation = generation(&plan);
    generation.catalog = Arc::new(CatalogSnapshot {
        tags: vec![],
        ..(*generation.catalog).clone()
    });
    generation.values = None;
    generation.resolution = Arc::new(resolve_bindings(&plan.requests(), &[]).unwrap());
    let observation = projection::capture(&plan, &generation).unwrap().remove(0);
    assert_eq!(observation.reason, Some(Reason::Unresolved));
    assert_eq!(observation.quality, None);
    assert_eq!(observation.source_time_ms, None);
    assert_eq!(observation.source_epoch, None);
    assert_eq!(plan.empty(Reason::SourceUnavailable)[0].source, None);
}

#[test]
fn identity_epoch_and_timestamp_changes_fail_the_entire_capture() {
    let plan = plan();
    for change in 0..12 {
        let mut generation = generation(&plan);
        match change {
            0 => Arc::make_mut(&mut generation.catalog).revision += 1,
            1 => Arc::make_mut(&mut generation.catalog).run_id = None,
            2 => {
                Arc::make_mut(&mut generation.catalog).collection_mode =
                    CollectionMode::AllSimulation
            }
            3 => Arc::make_mut(&mut generation.catalog).tags[0].ids = StableTagId::new(1, 2, 4),
            4 => Arc::make_mut(&mut generation.catalog).tags[0].tag_key = "reused".into(),
            5 => Arc::make_mut(&mut generation.catalog).tags[0].unit = None,
            6 => Arc::make_mut(&mut generation.catalog).tags[0].enabled = false,
            7 => Arc::make_mut(&mut generation.catalog).tags[0].data_type = "f32".into(),
            8 => Arc::make_mut(generation.values.as_mut().unwrap()).revision += 1,
            9 => {
                Arc::make_mut(generation.values.as_mut().unwrap()).values[0].t =
                    9_007_199_254_740_992
            }
            10 => generation.values = None,
            _ => {
                generation.resolution =
                    Arc::new(resolve_bindings(&[], &generation.catalog.tags).unwrap())
            }
        }
        assert!(
            projection::capture(&plan, &generation).is_err(),
            "change {change}"
        );
    }
}

#[test]
fn duplicate_and_oversize_snapshots_are_rejected_before_linear_binding_lookups() {
    let plan = plan();
    for change in 0..4 {
        let mut generation = generation(&plan);
        match change {
            0 => {
                let catalog = Arc::make_mut(&mut generation.catalog);
                catalog.tags.push(catalog.tags[0].clone());
            }
            1 => {
                let values = Arc::make_mut(generation.values.as_mut().unwrap());
                values.values.push(values.values[0].clone());
            }
            2 => {
                let catalog = Arc::make_mut(&mut generation.catalog);
                catalog.tags = vec![catalog.tags[0].clone(); 4097];
            }
            _ => {
                let values = Arc::make_mut(generation.values.as_mut().unwrap());
                values.values = vec![values.values[0].clone(); 4097];
            }
        }
        assert!(projection::capture(&plan, &generation).is_err());
    }
}

#[test]
fn plans_reuse_history_validation_and_require_one_hub_and_exact_pins() {
    let base = plan();
    for change in 0..7 {
        let mut session = base.session.clone();
        let mut generation = base.generation.clone();
        let mut bindings = base.bindings.clone();
        match change {
            0 => session.session_id = "invalid session".into(),
            1 => session.members.clear(),
            2 => session.members[0].period_ms = 99,
            3 => bindings[0].series_id = "other".into(),
            4 => bindings[0].data_type = "bit".into(),
            5 => generation.collection_mode = CollectionMode::Unknown("future".into()),
            _ => {
                let mut second = session.members[0].clone();
                second.series_id = "other".into();
                second.incarnation_id = "other".into();
                second.hub_instance_id = "hub-b".into();
                second.external_name = "other".into();
                session.members.push(second);
                let mut second = bindings[0].clone();
                second.series_id = "other".into();
                bindings.push(second);
            }
        }
        assert!(
            SdkRecorderPlan::new(session, generation, bindings).is_err(),
            "change {change}"
        );
    }
    assert_eq!(
        projection::capture(&base, &generation(&base)).unwrap()[0].quality,
        Some(Quality::Good)
    );
}
