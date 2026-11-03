use super::*;
use crate::recorder_source::tests::{generation, plan};
use banto_tagclient::{ValueQuality, ValueSource};
use scada_historian::store::{Source, ValueType};
use std::sync::Arc;
#[test]
fn coherent_number_bool_and_bad_quality_are_resolved_without_recording_values() {
    for boolean in [false, true] {
        let p = plan();
        let mut s = p.session().clone();
        let mut g = generation(&p);
        if boolean {
            s.members[0].value_type = ValueType::Bool;
            Arc::make_mut(&mut g.catalog).tags[0].data_type = "bit".into();
            Arc::make_mut(g.values.as_mut().unwrap()).values[0].v = Some(1.0);
        }
        for q in [ValueQuality::Good, ValueQuality::Bad, ValueQuality::Stale] {
            Arc::make_mut(g.values.as_mut().unwrap()).values[0].q = q;
            let resolved = SdkRecorderPlan::from_generation(s.clone(), &g).unwrap();
            assert_eq!(resolved.session(), &s);
        }
    }
}
#[test]
fn resolution_rejects_missing_mixed_duplicate_or_changed_sdk_identity() {
    for kind in 0..12 {
        let p = plan();
        let mut g = generation(&p);
        match kind {
            0 => g.values = None,
            1 => Arc::make_mut(&mut g.resolution).resolved.clear(),
            2 => Arc::make_mut(&mut g.resolution).resolved[0].external_name = "other".into(),
            3 => Arc::make_mut(&mut g.resolution).resolved[0].tag_key = "other".into(),
            4 => Arc::make_mut(&mut g.catalog).tags[0].unit = Some("F".into()),
            5 => Arc::make_mut(&mut g.catalog).tags[0].data_type = "bit".into(),
            6 => Arc::make_mut(&mut g.catalog).tags[0].enabled = false,
            7 => Arc::make_mut(g.values.as_mut().unwrap()).run_id = Some(999),
            8 => Arc::make_mut(g.values.as_mut().unwrap()).revision = 999,
            9 => {
                Arc::make_mut(g.values.as_mut().unwrap()).values[0].value_source =
                    ValueSource::Simulation
            }
            10 => {
                let t = g.catalog.tags[0].clone();
                Arc::make_mut(&mut g.catalog).tags.push(t);
            }
            _ => {
                let v = g.values.as_ref().unwrap().values[0].clone();
                Arc::make_mut(g.values.as_mut().unwrap()).values.push(v);
            }
        }
        assert!(
            SdkRecorderPlan::from_generation(p.session().clone(), &g).is_err(),
            "case {kind}"
        );
    }
}
#[test]
fn value_source_is_authoritative_and_explicit_simulation_unknown_segments_keep_their_policy() {
    for (source, value_source) in [
        (Source::Simulation, ValueSource::Simulation),
        (Source::Unknown, ValueSource::Unknown("future".into())),
    ] {
        let p = plan();
        let mut s = p.session().clone();
        s.members[0].source = source;
        let mut g = generation(&p);
        Arc::make_mut(g.values.as_mut().unwrap()).values[0].value_source = value_source;
        assert!(SdkRecorderPlan::from_generation(s, &g).is_ok());
    }
    let p = plan();
    let mut g = generation(&p);
    Arc::make_mut(&mut g.catalog).tags[0].value_source = ValueSource::Simulation;
    assert!(SdkRecorderPlan::from_generation(p.session().clone(), &g).is_ok());
}
#[test]
fn row_and_total_sdk_string_bounds_are_checked_before_resolution_scans() {
    let p = plan();
    let mut g = generation(&p);
    Arc::make_mut(&mut g.catalog).tags = vec![g.catalog.tags[0].clone(); projection::MAX_ROWS + 1];
    assert!(SdkRecorderPlan::from_generation(p.session().clone(), &g).is_err());
    let mut g = generation(&p);
    Arc::make_mut(&mut g.catalog).tags[0].address = "x".repeat(MAX_BYTES + 1);
    assert!(SdkRecorderPlan::from_generation(p.session().clone(), &g).is_err());
}
