//! Pure recording operation JSON. No service, native handle registry or mutation.
use crate::json_contract::JsonBudget;
use crate::recording_management::{validate_recording_management, RECORDING_MANAGEMENT_SCHEMA};
use crate::recording_plan::{validate_recording_plan, RECORDING_PLAN_SCHEMA};
use serde_json::Value;
use std::sync::LazyLock;

pub const RECORDING_OPERATIONS_SCHEMA: &str =
    include_str!("../schema/recording-operations.schema.json");
pub const MAX_RECORDING_OPERATIONS_JSON_BYTES: usize = 128 * 1024;
pub const MAX_RECORDING_OPERATIONS_JSON_NODES: usize = 4096;
pub const MAX_RECORDING_OPERATION_RESULT_JSON_BYTES: usize = 256 * 1024;
pub const MAX_RECORDING_OPERATION_RESULT_JSON_NODES: usize = 8192;
const HISTORY_SCHEMA: &str =
    include_str!("../../scada-historian/schema/history-contract.schema.json");
struct BundledOnly;
impl jsonschema::Retrieve for BundledOnly {
    fn retrieve(
        &self,
        _: &jsonschema::Uri<String>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        Err("Unregistered recording operations schema resource".into())
    }
}
static VALIDATOR: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    let root: Value =
        serde_json::from_str(RECORDING_OPERATIONS_SCHEMA).expect("bundled operations JSON");
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
        (
            "https://temp-scada.invalid/schema/recording-management-v1.json",
            RECORDING_MANAGEMENT_SCHEMA,
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
        .expect("operations schema with local resources")
});
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecordingOperationsError;
impl std::fmt::Display for RecordingOperationsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Recording operations: invalid")
    }
}
impl std::error::Error for RecordingOperationsError {}
fn small(value: &Value) -> Result<(), RecordingOperationsError> {
    JsonBudget::new(
        MAX_RECORDING_OPERATIONS_JSON_BYTES,
        MAX_RECORDING_OPERATIONS_JSON_NODES,
    )
    .visit(value, 0)
    .map_err(|_| RecordingOperationsError)
}
/// Finite structured-data validation. Acceptance is not native execution evidence,
/// authorization, a current-owner check or proof of stateful reconciliation rules.
pub fn validate_recording_operations(value: &Value) -> Result<(), RecordingOperationsError> {
    let result = matches!(
        value["kind"].as_str(),
        Some("recordingOperationResult" | "recordingReconciliationResult")
    );
    let (bytes, nodes) = if result {
        (
            MAX_RECORDING_OPERATION_RESULT_JSON_BYTES,
            MAX_RECORDING_OPERATION_RESULT_JSON_NODES,
        )
    } else {
        (
            MAX_RECORDING_OPERATIONS_JSON_BYTES,
            MAX_RECORDING_OPERATIONS_JSON_NODES,
        )
    };
    JsonBudget::new(bytes, nodes)
        .visit(value, 0)
        .map_err(|_| RecordingOperationsError)?;
    if !VALIDATOR.is_valid(value) {
        return Err(RecordingOperationsError);
    }
    let mut nested = value;
    if nested["kind"] == "recordingReconciliationResult" {
        nested = &nested["request"];
    }
    if nested["kind"] == "recordingReconciliationRequest" {
        small(nested)?;
        if nested["operation"]["stage"] != "apply" {
            return Err(RecordingOperationsError);
        }
        nested = &nested["operation"];
    }
    if nested["kind"] == "recordingOperationResult" {
        nested = &nested["request"];
    }
    if nested["kind"] == "recordingOperationRequest" {
        small(nested)?;
        nested = &nested["change"];
    }
    if nested["kind"] == "recordingChangeRequest" {
        small(nested)?;
        validate_recording_plan(&nested["apply"]["desired"])
            .map_err(|_| RecordingOperationsError)?;
        if !semantic::apply_consistent(&nested["apply"]) {
            return Err(RecordingOperationsError);
        }
        nested = &nested["context"];
    }
    small(nested)?;
    validate_recording_management(&nested["target"]).map_err(|_| RecordingOperationsError)?;
    if (value["kind"] == "recordingOperationResult" && !semantic::operation_consistent(value))
        || (value["kind"] == "recordingReconciliationResult"
            && !semantic::reconciliation_consistent(value))
    {
        return Err(RecordingOperationsError);
    }
    Ok(())
}
macro_rules! owned_document {
    ($name:ident,$kind:literal) => {
        /// Immutable owned JSON, validated before construction.
        #[derive(Clone, Debug, PartialEq)]
        pub struct $name(Value);
        impl $name {
            pub fn from_value(value: Value) -> Result<Self, RecordingOperationsError> {
                validate_recording_operations(&value)?;
                if value["kind"] != $kind {
                    return Err(RecordingOperationsError);
                }
                Ok(Self(value))
            }
            pub fn as_value(&self) -> &Value {
                &self.0
            }
        }
    };
}
owned_document!(RecordingOperationsContext, "recordingOperationsContext");
owned_document!(RecordingChangeRequest, "recordingChangeRequest");
owned_document!(RecordingOperationRequest, "recordingOperationRequest");
owned_document!(RecordingOperationResult, "recordingOperationResult");
owned_document!(
    RecordingReconciliationRequest,
    "recordingReconciliationRequest"
);
owned_document!(
    RecordingReconciliationResult,
    "recordingReconciliationResult"
);
mod equality;
mod semantic;
pub use equality::{
    same_recording_change_request, same_recording_operation_request,
    same_recording_operations_context, same_recording_reconciliation_request,
};
#[cfg(test)]
mod tests;
