use std::collections::HashSet;

use banto_tagclient::{BindingView, GenerationSnapshot, ValueQuality, ValueSource};
use scada_historian::{
    recorder::SourceError,
    store::{ObservationValue, Quality, Reason, Source, SourceEpoch, TickObservation, ValueType},
};

use super::SdkRecorderPlan;

// binding() performs linear SDK lookups. Check sizes before scanning so the
// synchronous adapter has an explicit finite work bound, independent of UI.
const MAX_ROWS: usize = 4096;
const MAX_SAFE: i64 = 9_007_199_254_740_991;

pub(super) fn capture(
    plan: &SdkRecorderPlan,
    generation: &GenerationSnapshot,
) -> Result<Vec<TickObservation>, SourceError> {
    let catalog = &generation.catalog;
    let values = generation.values.as_deref();
    let resolution = &generation.resolution;
    if catalog.tags.len() > MAX_ROWS
        || values.is_some_and(|v| v.values.len() > MAX_ROWS)
        || resolution.resolved.len() > 8
        || resolution.unresolved.len() > 8
        || resolution.resolved.len() + resolution.unresolved.len() != plan.bindings.len()
    {
        return Err(SourceError("SDK snapshot exceeds recording bounds"));
    }
    if catalog.revision != plan.generation.catalog_revision
        || catalog.run_id != plan.generation.run_id
        || catalog.collection_mode != plan.generation.collection_mode
        || values.is_some_and(|v| {
            v.revision != catalog.revision
                || v.run_id != catalog.run_id
                || v.collection_mode != catalog.collection_mode
        })
    {
        return Err(SourceError("SDK recording generation changed"));
    }
    let mut names = HashSet::new();
    if catalog
        .tags
        .iter()
        .any(|t| !names.insert(t.external_name.as_str()))
    {
        return Err(SourceError("duplicate SDK catalog rows"));
    }
    names.clear();
    if values.is_some_and(|v| v.values.iter().any(|v| !names.insert(v.tag.as_str()))) {
        return Err(SourceError("duplicate SDK value rows"));
    }
    let mut observations = plan.empty(Reason::Unresolved);
    for ((member, pin), observation) in plan
        .session
        .members
        .iter()
        .zip(&plan.bindings)
        .zip(&mut observations)
    {
        match generation.binding(&member.series_id) {
            Some(BindingView::Unresolved(binding))
                if binding.external_name == member.external_name => {}
            Some(BindingView::Resolved {
                binding,
                tag,
                value,
            }) => {
                if binding.external_name != member.external_name
                    || binding.tag_key != pin.tag_key
                    || tag.ids != pin.stable_id
                    || tag.tag_key != pin.tag_key
                    || tag.data_type != pin.data_type
                    || tag.unit != member.unit
                    || !tag.enabled
                {
                    return Err(SourceError("SDK recording identity changed"));
                }
                let value = value.ok_or(SourceError("resolved SDK value missing"))?;
                let source = match value.value_source {
                    ValueSource::Real => Source::Real,
                    ValueSource::Computed => Source::Computed,
                    ValueSource::Internal => Source::Internal,
                    ValueSource::Db => Source::Db,
                    ValueSource::Simulation => Source::Simulation,
                    ValueSource::DerivedSimulation => Source::DerivedSimulation,
                    ValueSource::Unknown(_) => Source::Unknown,
                };
                // ValueEntry owns source. Catalog simulation labels are not evidence.
                if source != member.source {
                    return Err(SourceError("SDK recording source changed"));
                }
                if !(-MAX_SAFE..=MAX_SAFE).contains(&value.t) {
                    return Err(SourceError("SDK source timestamp out of range"));
                }
                let quality = match value.q {
                    ValueQuality::Good => Quality::Good,
                    ValueQuality::Bad => Quality::Bad,
                    ValueQuality::Stale => Quality::Stale,
                    ValueQuality::Unknown(_) => Quality::Unknown,
                };
                observation.source_time_ms = Some(value.t);
                observation.source = Some(source);
                observation.quality = Some(quality);
                observation.source_epoch = Some(SourceEpoch {
                    hub_instance_id: member.hub_instance_id.clone(),
                    run_id: catalog.run_id,
                    catalog_revision: catalog.revision,
                    sdk_generation: generation.generation,
                });
                let reason = match source {
                    Source::Simulation | Source::DerivedSimulation => {
                        Some(Reason::SimulationExcluded)
                    }
                    Source::Unknown => Some(Reason::UnknownSource),
                    _ => match quality {
                        Quality::Bad => Some(Reason::Bad),
                        Quality::Stale => Some(Reason::Stale),
                        Quality::Unknown => Some(Reason::UnknownQuality),
                        Quality::Good => match value.v {
                            None => Some(Reason::MissingValue),
                            Some(v) if !v.is_finite() => Some(Reason::NonFinite),
                            Some(v) => {
                                observation.value = match member.value_type {
                                    ValueType::Number => Some(ObservationValue::Number(v)),
                                    ValueType::Bool if v == 0.0 || v == 1.0 => {
                                        Some(ObservationValue::Bool(v == 1.0))
                                    }
                                    ValueType::Bool => None,
                                };
                                observation.value.is_none().then_some(Reason::TypeMismatch)
                            }
                        },
                    },
                };
                observation.reason = reason;
            }
            _ => return Err(SourceError("SDK recording binding missing")),
        }
    }
    Ok(observations)
}
