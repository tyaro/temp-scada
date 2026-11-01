use std::collections::HashSet;

use banto_tagclient::{BindingRequest, CollectionMode, StableTagId};
use scada_historian::{
    recorder::SourceError,
    store::{Reason, SessionSpec, TickObservation, ValueType},
};

/// Caller-confirmed metadata from one coherent SDK generation. These counters
/// are not a Hub instance identity and do not prove an incarnation's continuity.
#[derive(Clone, Debug)]
pub struct SdkGenerationPin {
    pub catalog_revision: u64,
    pub run_id: Option<u64>,
    pub collection_mode: CollectionMode,
}

#[derive(Clone, Debug)]
pub struct SdkBindingPin {
    pub series_id: String,
    pub stable_id: StableTagId,
    pub tag_key: String,
    pub data_type: String,
}

/// Immutable fixed group. History identities are supplied by the caller, never
/// generated from an external name, run ID, or the Hub's reusable numeric IDs.
#[derive(Clone, Debug)]
pub struct SdkRecorderPlan {
    pub(super) session: SessionSpec,
    pub(super) generation: SdkGenerationPin,
    pub(super) bindings: Vec<SdkBindingPin>,
}

impl SdkRecorderPlan {
    pub fn new(
        mut session: SessionSpec,
        generation: SdkGenerationPin,
        mut bindings: Vec<SdkBindingPin>,
    ) -> Result<Self, SourceError> {
        let invalid = SourceError("invalid SDK recording plan");
        session.validate().map_err(|_| invalid)?;
        if !(1..=8).contains(&session.members.len())
            || session.members.len() != bindings.len()
            || matches!(generation.collection_mode, CollectionMode::Unknown(_))
        {
            return Err(invalid);
        }
        session
            .members
            .sort_by(|a, b| a.series_id.cmp(&b.series_id));
        bindings.sort_by(|a, b| a.series_id.cmp(&b.series_id));
        let first = &session.members[0];
        let mut names = HashSet::new();
        let mut series = HashSet::new();
        for (member, binding) in session.members.iter().zip(&bindings) {
            if member.series_id != binding.series_id
                || !series.insert(&member.series_id)
                || !names.insert(&member.external_name)
                || member.hub_instance_id != first.hub_instance_id
                || member.period_ms != first.period_ms
                || !(100..=3_600_000).contains(&member.period_ms)
                || binding.tag_key.is_empty()
                || binding.tag_key.len() > 1024
                || !compatible(member.value_type, &binding.data_type)
            {
                return Err(invalid);
            }
        }
        Ok(Self {
            session,
            generation,
            bindings,
        })
    }

    /// Pass this same fixed session to RecorderConfig; the recorder validates
    /// its session ID and schedule before any SQLite session begins.
    pub fn session(&self) -> &SessionSpec {
        &self.session
    }

    pub(super) fn requests(&self) -> Vec<BindingRequest> {
        self.session
            .members
            .iter()
            .map(|member| BindingRequest {
                binding_key: member.series_id.clone(),
                external_name: member.external_name.clone(),
            })
            .collect()
    }

    pub(super) fn empty(&self, reason: Reason) -> Vec<TickObservation> {
        self.session
            .members
            .iter()
            .map(|member| TickObservation {
                series_id: member.series_id.clone(),
                source_time_ms: None,
                quality: None,
                source: None,
                value: None,
                reason: Some(reason),
                source_epoch: None,
            })
            .collect()
    }
}

fn compatible(expected: ValueType, data_type: &str) -> bool {
    match expected {
        ValueType::Bool => data_type == "bit",
        ValueType::Number => matches!(
            data_type,
            "i16" | "u16" | "i32" | "u32" | "i64" | "u64" | "f32" | "f64"
        ),
    }
}
