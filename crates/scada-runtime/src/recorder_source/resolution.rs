//! Caller-provided coherent SDK evidence; never a network freshness/Hub identity proof.
use super::{projection, SdkBindingPin, SdkGenerationPin, SdkRecorderPlan};
use banto_tagclient::{BindingView, GenerationSnapshot};
use scada_historian::{recorder::SourceError, store::SessionSpec};
const MAX_BYTES: usize = 8 * 1024 * 1024;
fn bounded(g: &GenerationSnapshot) -> Result<(), SourceError> {
    let invalid = SourceError("SDK resolution exceeds recording bounds");
    if g.catalog.tags.len() > projection::MAX_ROWS
        || g.values
            .as_ref()
            .is_none_or(|v| v.values.len() > projection::MAX_ROWS)
        || g.resolution.resolved.len() > 8
        || !g.resolution.unresolved.is_empty()
    {
        return Err(invalid);
    }
    let mut bytes = 0usize;
    let mut add = |s: &str| {
        bytes = bytes
            .checked_add(s.len())
            .filter(|n| *n <= MAX_BYTES)
            .ok_or(invalid)?;
        Ok::<_, SourceError>(())
    };
    add(g.catalog.collection_mode.as_str())?;
    for t in &g.catalog.tags {
        for s in [
            &t.external_name,
            &t.tag_key,
            &t.connection,
            &t.group,
            &t.name,
            &t.address,
            &t.data_type,
            &t.tag_kind,
        ] {
            add(s)?;
        }
        if let Some(s) = &t.unit {
            add(s)?;
        }
        if let Some(s) = &t.expression {
            add(s)?;
        }
        add(t.value_source.as_str())?;
    }
    for r in &g.resolution.resolved {
        add(&r.binding_key)?;
        add(&r.external_name)?;
        add(&r.tag_key)?;
    }
    if let Some(v) = &g.values {
        add(v.collection_mode.as_str())?;
        for r in &v.values {
            add(&r.tag)?;
            add(r.q.as_str())?;
            add(r.value_source.as_str())?;
        }
    }
    Ok(())
}
impl SdkRecorderPlan {
    /// Resolve all saved members from one caller-confirmed current generation.
    /// Stored Hub/incarnation identities are never inferred from SDK numeric IDs.
    pub fn from_generation(
        session: SessionSpec,
        generation: &GenerationSnapshot,
    ) -> Result<Self, SourceError> {
        let invalid = SourceError("SDK resume resolution mismatch");
        session.validate().map_err(|_| invalid)?;
        bounded(generation)?;
        if generation.resolution.resolved.len() != session.members.len() {
            return Err(invalid);
        }
        let mut pins = Vec::with_capacity(session.members.len());
        for m in &session.members {
            let Some(BindingView::Resolved {
                binding,
                tag,
                value: Some(_),
            }) = generation.binding(&m.series_id)
            else {
                return Err(invalid);
            };
            if binding.external_name != m.external_name
                || tag.external_name != m.external_name
                || binding.tag_key != tag.tag_key
                || tag.tag_key.len() > 1024
                || !super::plan::compatible(m.value_type, &tag.data_type)
            {
                return Err(invalid);
            }
            pins.push(SdkBindingPin {
                series_id: m.series_id.clone(),
                stable_id: tag.ids,
                tag_key: tag.tag_key.clone(),
                data_type: tag.data_type.clone(),
            });
        }
        let plan = Self::new(
            session,
            SdkGenerationPin {
                catalog_revision: generation.catalog.revision,
                run_id: generation.catalog.run_id,
                collection_mode: generation.catalog.collection_mode.clone(),
            },
            pins,
        )?;
        // Shares generation/identity/source checks. Temporary observations are not recorded.
        projection::capture(&plan, generation)?;
        Ok(plan)
    }
}

#[cfg(test)]
mod tests;
