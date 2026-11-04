//! Pure asynchronous admission JSON, not an adapter, lease issuer or execution proof.
mod capacity;
mod semantic;
use crate::json_contract::JsonBudget;
use crate::recording_operations::{
    same_json, validate_recording_operations, RECORDING_OPERATIONS_SCHEMA,
};
use serde_json::Value;
use std::sync::LazyLock;
pub const RECORDING_ADMISSION_SCHEMA: &str =
    include_str!("../schema/recording-admission.schema.json");
pub const MAX_RECORDING_ADMISSION_JSON_BYTES: usize = 512 * 1024;
pub const MAX_RECORDING_ADMISSION_JSON_NODES: usize = 16384;
pub const MAX_RECORDING_ADMISSION_JSON_DEPTH: usize = 48;
struct BundledOnly;
impl jsonschema::Retrieve for BundledOnly {
    fn retrieve(
        &self,
        _: &jsonschema::Uri<String>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        Err("Unregistered admission schema resource".into())
    }
}
static VALIDATOR: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    let mut options = jsonschema::options().with_retriever(BundledOnly);
    for text in [
        RECORDING_OPERATIONS_SCHEMA,
        crate::recording_management::RECORDING_MANAGEMENT_SCHEMA,
        crate::recording_plan::RECORDING_PLAN_SCHEMA,
        include_str!("../../scada-historian/schema/history-contract.schema.json"),
    ] {
        let schema: Value = serde_json::from_str(text).expect("bundled JSON");
        let uri = schema["$id"].as_str().expect("bundled ID").to_owned();
        options = options.with_resource(
            uri,
            jsonschema::Resource::from_contents(schema).expect("bundled resource"),
        );
    }
    options
        .build(&serde_json::from_str::<Value>(RECORDING_ADMISSION_SCHEMA).expect("bundled JSON"))
        .expect("local admission schemas")
});
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecordingAdmissionError;
impl std::fmt::Display for RecordingAdmissionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Recording admission: invalid")
    }
}
impl std::error::Error for RecordingAdmissionError {}
fn require(ok: bool) -> Result<(), RecordingAdmissionError> {
    if ok {
        Ok(())
    } else {
        Err(RecordingAdmissionError)
    }
}
fn budget(value: &Value) -> Result<(), RecordingAdmissionError> {
    JsonBudget::admission()
        .visit(value, 0)
        .map_err(|_| RecordingAdmissionError)
}
/// Bounded shape, independent nested validation, full echo checks and worst reply capacity.
/// This does not establish native acceptance, reference ownership, a lease or safe retry.
pub fn validate_recording_admission(value: &Value) -> Result<(), RecordingAdmissionError> {
    budget(value)?;
    require(VALIDATOR.is_valid(value))?;
    semantic::document(value)
}
macro_rules! owned {
    ($name:ident,$kind:literal) => {
        #[derive(Clone, Debug, PartialEq)]
        pub struct $name(Value);
        impl $name {
            pub fn from_value(value: Value) -> Result<Self, RecordingAdmissionError> {
                validate_recording_admission(&value)?;
                require(value["kind"] == $kind)?;
                Ok(Self(value))
            }
            pub fn as_value(&self) -> &Value {
                &self.0
            }
        }
    };
}
owned!(RecordingAdmissionRequest, "recordingAdmissionRequest");
owned!(RecordingAdmissionReply, "recordingAdmissionReply");
owned!(
    RecordingAdmissionInspectionRequest,
    "recordingAdmissionInspectionRequest"
);
owned!(
    RecordingAdmissionInspectionReply,
    "recordingAdmissionInspectionReply"
);
owned!(
    RecordingReconciliationDelivery,
    "recordingReconciliationDelivery"
);
/// Already mandatory in the request constructor; available explicitly for dispatch guards.
pub fn validate_recording_admission_reply_capacity(
    request: &RecordingAdmissionRequest,
) -> Result<(), RecordingAdmissionError> {
    capacity::check(request.as_value())
}
pub fn same_recording_admission_request(
    a: &RecordingAdmissionRequest,
    b: &RecordingAdmissionRequest,
) -> bool {
    same_json(a.as_value(), b.as_value())
}
pub fn same_recording_admission_inspection_request(
    a: &RecordingAdmissionInspectionRequest,
    b: &RecordingAdmissionInspectionRequest,
) -> bool {
    same_json(a.as_value(), b.as_value())
}
pub fn recording_admission_reply_matches_request(
    reply: &RecordingAdmissionReply,
    request: &RecordingAdmissionRequest,
) -> bool {
    same_json(&reply.as_value()["request"], request.as_value())
}
pub fn recording_admission_inspection_reply_matches_request(
    reply: &RecordingAdmissionInspectionReply,
    request: &RecordingAdmissionInspectionRequest,
) -> bool {
    same_json(&reply.as_value()["request"], request.as_value())
}
/// Correlates only these two validated documents; it is not a registry lookup.
pub fn recording_reconciliation_delivery_matches_admission(
    delivery: &RecordingReconciliationDelivery,
    reply: &RecordingAdmissionReply,
) -> bool {
    let d = delivery.as_value();
    let r = reply.as_value();
    r["request"]["action"]["kind"] == "reconcile"
        && r["outcome"]["kind"] == "accepted"
        && d["ownerRef"] == r["request"]["ownerRef"]
        && d["readRef"] == r["outcome"]["handle"]["readRef"]
        && same_json(&d["request"], &r["outcome"]["handle"]["request"])
}
#[cfg(test)]
mod tests;
