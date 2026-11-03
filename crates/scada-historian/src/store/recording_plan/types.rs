use super::super::{evidence::PlanRef, IdentityDescriptor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordingMappingMember {
    pub member_id: String,
    pub identity: IdentityDescriptor,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordingMapping {
    pub hub_ref: String,
    pub hub_instance_id: String,
    pub members: Vec<RecordingMappingMember>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterMappingRequest {
    pub request_id: String,
    pub expected_mapping_revision: Option<u64>,
    pub mapping: RecordingMapping,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MappingReceipt {
    pub request_id: String,
    pub mapping_revision: u64,
    pub commit_version: u64,
    pub mapping_hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyRecordingPlanRequest {
    pub request_id: String,
    pub expected_applied_revision: Option<u64>,
    pub desired: Value,
    pub expected_mapping_revision: Option<u64>,
    pub expected_retention_applied_revision: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordingPlanReceipt {
    pub request_id: String,
    pub applied_revision: u64,
    pub commit_version: u64,
    pub desired_plan_id: String,
    pub desired_revision: u64,
    pub desired_hash: String,
    pub resolved_config_hash: String,
    pub plan: PlanRef,
    pub mapping_revision: Option<u64>,
    pub retention_applied_revision: Option<u64>,
    pub enabled: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppliedRecordingPlan {
    pub request: ApplyRecordingPlanRequest,
    pub receipt: RecordingPlanReceipt,
    pub resolution: Option<RecordingMapping>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisteredRecordingMapping {
    pub receipt: MappingReceipt,
    pub mapping: RecordingMapping,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordingPlanState {
    pub snapshot_commit: u64,
    pub ledger_plan_id: Option<String>,
    pub mapping: Option<RegisteredRecordingMapping>,
    pub applied: Option<AppliedRecordingPlan>,
    pub activation_supported: bool,
}
