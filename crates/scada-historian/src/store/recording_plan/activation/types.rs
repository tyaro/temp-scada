use super::super::super::{
    evidence::{ClockStamp, PlanRef},
    SessionSpec, SessionStatus,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivateRecordingPlanRequest {
    pub activation_id: String,
    pub expected_applied_revision: u64,
    pub expected_mapping_revision: u64,
    pub expected_retention_applied_revision: u64,
    pub session_id: String,
    pub start: ClockStamp,
}
/// Immutable evidence of the session-begin commit, never SDK/worker Running.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordingActivationReceipt {
    pub activation_id: String,
    pub sequence: u64,
    pub applied_revision: u64,
    pub mapping_revision: u64,
    pub retention_applied_revision: u64,
    pub commit_version: u64,
    pub resolved_config_hash: String,
    pub spec: SessionSpec,
    pub plan: PlanRef,
    pub start: ClockStamp,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingActivation {
    pub receipt: RecordingActivationReceipt,
    pub session: SessionStatus,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingActivationState {
    pub snapshot_commit: u64,
    pub latest: Option<RecordingActivation>,
}
