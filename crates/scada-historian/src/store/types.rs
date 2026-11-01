use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{invalid, StoreResult};

pub(crate) const MAX_SAFE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreIdentity {
    pub store_id: String,
    pub deployment_id: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Real,
    Computed,
    Internal,
    Db,
    Simulation,
    DerivedSimulation,
    Unknown,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ValueType {
    Number,
    Bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Quality {
    Good,
    Bad,
    Stale,
    Unknown,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    Bad,
    Stale,
    UnknownQuality,
    SimulationExcluded,
    UnknownSource,
    SourceUnavailable,
    Unresolved,
    IdentityPending,
    MissingValue,
    NonFinite,
    TypeMismatch,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityDescriptor {
    pub series_id: String,
    pub hub_instance_id: String,
    pub incarnation_id: String,
    pub external_name: String,
    pub segment_id: String,
    pub value_type: ValueType,
    pub unit: Option<String>,
    pub period_ms: u64,
    pub source: Source,
}

/// A fixed recording group, not the product recording-plan distribution API.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSpec {
    pub session_id: String,
    pub members: Vec<IdentityDescriptor>,
}

/// Internal provenance; counters retain all 64 bits and are not a public DTO.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceEpoch {
    pub hub_instance_id: String,
    pub run_id: Option<u64>,
    pub catalog_revision: u64,
    pub sdk_generation: u64,
}

impl SourceEpoch {
    pub(super) fn canonical(&self) -> Value {
        json!({
            "hubInstanceId": self.hub_instance_id,
            "runId": self.run_id.map(|n| n.to_string()),
            "catalogRevision": self.catalog_revision.to_string(),
            "sdkGeneration": self.sdk_generation.to_string(),
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum ObservationValue {
    Number(f64),
    Bool(bool),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TickObservation {
    pub series_id: String,
    pub source_time_ms: Option<i64>,
    pub quality: Option<Quality>,
    pub source: Option<Source>,
    pub value: Option<ObservationValue>,
    pub reason: Option<Reason>,
    pub source_epoch: Option<SourceEpoch>,
}

/// Exactly one observation for every session member; no caller watermark.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tick {
    pub session_id: String,
    pub sequence: u64,
    pub clock_epoch: String,
    pub sample_time_ms: i64,
    pub ingested_at_ms: i64,
    pub observations: Vec<TickObservation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionState {
    Active,
    Closed,
    Interrupted,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionStatus {
    pub spec: SessionSpec,
    pub state: SessionState,
    pub committed_through: u64,
    pub begin_commit_version: u64,
    /// Closure or interruption-detection commit, not a guessed crash time.
    pub end_commit_version: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitReceipt {
    pub session_id: String,
    pub committed_through: u64,
    pub commit_version: u64,
}

pub(crate) fn id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

impl SessionSpec {
    /// Validate a fixed recording group without starting a database session.
    pub fn validate(&self) -> StoreResult<()> {
        self.clone().validated().map(|_| ())
    }

    pub(crate) fn validated(mut self) -> StoreResult<Self> {
        if !id(&self.session_id) || !(1..=8).contains(&self.members.len()) {
            return invalid("session identity or member count");
        }
        self.members.sort_by(|a, b| a.series_id.cmp(&b.series_id));
        if self
            .members
            .windows(2)
            .any(|w| w[0].series_id == w[1].series_id)
            || self
                .members
                .iter()
                .any(|m| m.period_ms != self.members[0].period_ms)
        {
            return invalid("duplicate member or different recording periods");
        }
        crate::validate_history_identities(&serde_json::to_value(&self.members)?)?;
        Ok(self)
    }
}

impl Tick {
    pub(crate) fn validated(mut self, spec: &SessionSpec) -> StoreResult<(Self, String)> {
        if self.session_id != spec.session_id || self.observations.len() != spec.members.len() {
            return invalid("tick does not explain the complete recording group");
        }
        self.observations
            .sort_by(|a, b| a.series_id.cmp(&b.series_id));
        let mut samples = Vec::new();
        let mut epochs = std::collections::HashMap::new();
        for (observation, member) in self.observations.iter_mut().zip(&spec.members) {
            if observation.series_id != member.series_id {
                return invalid("missing or duplicate tick member");
            }
            if let Some(ObservationValue::Number(number)) = &mut observation.value {
                if !number.is_finite() {
                    return invalid("non-finite observation value");
                }
                if *number == 0.0 {
                    *number = 0.0;
                }
            }
            let provenance = observation.quality.is_some()
                || observation.source.is_some()
                || observation.source_time_ms.is_some();
            if provenance && observation.source_epoch.is_none() {
                return invalid("observation provenance needs its source epoch");
            }
            if observation
                .source_epoch
                .as_ref()
                .is_some_and(|epoch| epoch.hub_instance_id != member.hub_instance_id)
            {
                return invalid("source epoch belongs to another hub");
            }
            if let Some(epoch) = &observation.source_epoch {
                if epochs
                    .insert(epoch.hub_instance_id.clone(), epoch.clone())
                    .is_some_and(|previous| previous != *epoch)
                {
                    return invalid("tick mixes source generations from the same hub");
                }
            }
            samples.push(json!({
                "seriesId": member.series_id, "segmentId": member.segment_id,
                "recordId": {"sessionId": self.session_id, "sequence": self.sequence},
                "clockEpoch": self.clock_epoch, "sampleTimeMs": self.sample_time_ms,
                "sourceTimeMs": observation.source_time_ms, "ingestedAtMs": self.ingested_at_ms,
                "quality": observation.quality, "source": observation.source,
                "value": observation.value, "reason": observation.reason
            }));
        }
        crate::validate_history_contract(&json!({
            "version": 1, "kind": "sampleBatch", "sessionId": self.session_id,
            "series": spec.members, "samples": samples, "committedThrough": null
        }))?;
        let mut canonical = serde_json::to_value(&self)?;
        for (json, observation) in canonical["observations"]
            .as_array_mut()
            .expect("serialized observations")
            .iter_mut()
            .zip(&self.observations)
        {
            json["sourceEpoch"] = observation
                .source_epoch
                .as_ref()
                .map_or(Value::Null, SourceEpoch::canonical);
        }
        Ok((self, serde_json::to_string(&canonical)?))
    }
}
