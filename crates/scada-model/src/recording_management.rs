//! Read-only recording management JSON. No native projection, transport or writer control.
use crate::json_contract::{blank, JsonBudget};
use crate::recording_plan::{validate_recording_plan, RECORDING_PLAN_SCHEMA};
use serde_json::Value;
use std::sync::LazyLock;

pub const RECORDING_MANAGEMENT_SCHEMA: &str =
    include_str!("../schema/recording-management.schema.json");
pub const MAX_RECORDING_MANAGEMENT_JSON_BYTES: usize = 128 * 1024;
pub const MAX_RECORDING_MANAGEMENT_JSON_NODES: usize = 4096;
pub const MAX_RECORDING_INSPECTION_RESPONSE_JSON_BYTES: usize = 1024 * 1024;
pub const MAX_RECORDING_INSPECTION_RESPONSE_JSON_NODES: usize = 16384;
const HISTORY_SCHEMA: &str =
    include_str!("../../scada-historian/schema/history-contract.schema.json");
struct BundledOnly;
impl jsonschema::Retrieve for BundledOnly {
    fn retrieve(
        &self,
        _: &jsonschema::Uri<String>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        Err("Unregistered recording management schema resource".into())
    }
}
static VALIDATOR: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    let root: Value =
        serde_json::from_str(RECORDING_MANAGEMENT_SCHEMA).expect("bundled management JSON");
    let mut options = jsonschema::options().with_retriever(BundledOnly);
    for (uri, schema) in [
        (
            "https://temp-scada.invalid/schema/history-contract-v1.json",
            HISTORY_SCHEMA,
        ),
        (
            "https://temp-scada.invalid/schema/recording-plan-v1.json",
            RECORDING_PLAN_SCHEMA,
        ),
    ] {
        options = options.with_resource(
            uri,
            jsonschema::Resource::from_contents(
                serde_json::from_str::<Value>(schema).expect("bundled JSON"),
            )
            .expect("bundled resource"),
        );
    }
    options
        .build(&root)
        .expect("management schema and local resources")
});
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecordingManagementError;
impl std::fmt::Display for RecordingManagementError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Recording management: invalid")
    }
}
impl std::error::Error for RecordingManagementError {}
fn small(value: &Value) -> Result<(), RecordingManagementError> {
    JsonBudget::new(
        MAX_RECORDING_MANAGEMENT_JSON_BYTES,
        MAX_RECORDING_MANAGEMENT_JSON_NODES,
    )
    .visit(value, 0)
    .map_err(|_| RecordingManagementError)
}
/// Bounded pure validation; accepted declarations do not establish authorization,
/// real store identity or freshness. Nested desired has its own H5a budget/checks.
pub fn validate_recording_management(value: &Value) -> Result<(), RecordingManagementError> {
    let response = value["kind"] == "recordingInspectionResponse";
    let (bytes, nodes) = if response {
        (
            MAX_RECORDING_INSPECTION_RESPONSE_JSON_BYTES,
            MAX_RECORDING_INSPECTION_RESPONSE_JSON_NODES,
        )
    } else {
        (
            MAX_RECORDING_MANAGEMENT_JSON_BYTES,
            MAX_RECORDING_MANAGEMENT_JSON_NODES,
        )
    };
    JsonBudget::new(bytes, nodes)
        .visit(value, 0)
        .map_err(|_| RecordingManagementError)?;
    let request = if response { &value["request"] } else { value };
    small(request)?;
    let context = if request["kind"] == "recordingInspectionRequest" {
        &request["context"]
    } else {
        request
    };
    small(context)?;
    if !VALIDATOR.is_valid(value)
        || blank(
            context["projectId"]
                .as_str()
                .ok_or(RecordingManagementError)?,
        )
    {
        return Err(RecordingManagementError);
    }
    if response {
        if !semantic::database_consistent(&value["database"]) {
            return Err(RecordingManagementError);
        }
        let applied = &value["database"]["applied"];
        if !applied.is_null() {
            validate_recording_plan(&applied["desired"]).map_err(|_| RecordingManagementError)?;
        }
    }
    Ok(())
}
macro_rules! owned_document {
    ($name:ident, $kind:literal) => {
        /// Owned, validated immutable JSON. Construct only through `from_value`.
        #[derive(Clone, Debug, PartialEq)]
        pub struct $name(Value);
        impl $name {
            pub fn from_value(value: Value) -> Result<Self, RecordingManagementError> {
                validate_recording_management(&value)?;
                if value["kind"] != $kind {
                    return Err(RecordingManagementError);
                }
                Ok(Self(value))
            }
            pub fn as_value(&self) -> &Value {
                &self.0
            }
        }
    };
}
owned_document!(RecordingManagementContext, "recordingManagementContext");
owned_document!(RecordingInspectionRequest, "recordingInspectionRequest");
owned_document!(RecordingInspectionResponse, "recordingInspectionResponse");

mod comparison;
mod semantic;
pub use comparison::{
    compare_desired_applied, same_recording_inspection_request, DesiredAppliedComparison,
};
#[cfg(test)]
mod tests;
