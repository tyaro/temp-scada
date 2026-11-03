//! Desired settings shared by standalone inputs and Project validation. No binding or apply.
use crate::json_contract::{blank, JsonBudget};
use serde_json::Value;
use std::collections::HashSet;
use std::sync::LazyLock;

pub const RECORDING_PLAN_SCHEMA: &str = include_str!("../schema/recording-plan.schema.json");
pub const MAX_RECORDING_PLAN_JSON_BYTES: usize = 64 * 1024;
pub const MAX_RECORDING_PLAN_JSON_NODES: usize = 4096;
const HISTORY_SCHEMA: &str =
    include_str!("../../scada-historian/schema/history-contract.schema.json");
struct BundledOnly;
impl jsonschema::Retrieve for BundledOnly {
    fn retrieve(
        &self,
        _: &jsonschema::Uri<String>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        Err("Unregistered recording plan schema resource".into())
    }
}
static VALIDATOR: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    let history: Value = serde_json::from_str(HISTORY_SCHEMA).expect("bundled H1 JSON");
    let root: Value =
        serde_json::from_str(RECORDING_PLAN_SCHEMA).expect("bundled recording plan JSON");
    jsonschema::options()
        .with_retriever(BundledOnly)
        .with_resource(
            "https://temp-scada.invalid/schema/history-contract-v1.json",
            jsonschema::Resource::from_contents(history).expect("H1 resource"),
        )
        .build(&root)
        .expect("recording plan schema and H1 resource")
});
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecordingPlanError;
impl std::fmt::Display for RecordingPlanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Recording plan: invalid")
    }
}
impl std::error::Error for RecordingPlanError {}
/// Owns validated desired JSON, not a resolved or applied recording plan.
#[derive(Clone, Debug, PartialEq)]
pub struct DesiredRecordingPlan(Value);
impl DesiredRecordingPlan {
    pub fn from_value(value: Value) -> Result<Self, RecordingPlanError> {
        validate_recording_plan(&value)?;
        Ok(Self(value))
    }
    pub fn as_value(&self) -> &Value {
        &self.0
    }
}
/// Bounded structured JSON validation. Integer number spellings are normalized
/// only for byte accounting; the accepted value and member order are preserved.
/// Does not establish identity continuity or compare previously deployed versions.
pub fn validate_recording_plan(document: &Value) -> Result<(), RecordingPlanError> {
    JsonBudget::new(MAX_RECORDING_PLAN_JSON_BYTES, MAX_RECORDING_PLAN_JSON_NODES)
        .visit(document, 0)
        .map_err(|_| RecordingPlanError)?;
    if !VALIDATOR.is_valid(document) {
        return Err(RecordingPlanError);
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for member in document["group"]["members"]
        .as_array()
        .expect("schema members")
    {
        let id = member["memberId"].as_str().expect("schema ID");
        let name = member["externalName"].as_str().expect("schema name");
        if !ids.insert(id) || !names.insert(name) || blank(name) {
            return Err(RecordingPlanError);
        }
    }
    Ok(())
}
#[cfg(test)]
pub(crate) mod tests;
