//! Pure wire JSON. No registry, authentication, lease issuance or transport.
mod capacity;
mod semantic;
use crate::json_contract::JsonBudget;
use crate::recording_operations::same_json;
pub use capacity::{recording_wire_reply_capacity, WireReplyCapacity, WIRE_OPERATION_RESULT_UPPER};
use serde_json::{json, Value};
use std::sync::LazyLock;
pub const RECORDING_WIRE_SCHEMA: &str = include_str!("../schema/recording-wire.schema.json");
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WireBound {
    pub bytes: usize,
    pub nodes: usize,
    pub depth: usize,
}
pub const WIRE_REQUEST_LIMIT: WireBound = WireBound {
    bytes: 256 * 1024,
    nodes: 8192,
    depth: 48,
};
pub const WIRE_REPLY_LIMIT: WireBound = WireBound {
    bytes: 2 * 1024 * 1024,
    nodes: 65536,
    depth: 80,
};
pub const WIRE_SNAPSHOT_LIMIT: WireBound = WireBound {
    bytes: 1024 * 1024,
    nodes: 32768,
    depth: 64,
};
pub const WIRE_INSPECTION_REQUEST_LIMIT: WireBound = WireBound {
    bytes: 1024 * 1024,
    nodes: 32768,
    depth: 64,
};
pub const WIRE_INSPECTION_REPLY_LIMIT: WireBound = WireBound {
    bytes: 4 * 1024 * 1024,
    nodes: 196608,
    depth: 96,
};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecordingWireError;
impl std::fmt::Display for RecordingWireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Recording wire: invalid")
    }
}
impl std::error::Error for RecordingWireError {}
fn require(ok: bool) -> Result<(), RecordingWireError> {
    if ok {
        Ok(())
    } else {
        Err(RecordingWireError)
    }
}
struct BundledOnly;
impl jsonschema::Retrieve for BundledOnly {
    fn retrieve(
        &self,
        _: &jsonschema::Uri<String>,
    ) -> Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        Err("Unregistered wire schema resource".into())
    }
}
static VALIDATOR: LazyLock<jsonschema::Validator> = LazyLock::new(|| {
    let mut options = jsonschema::options().with_retriever(BundledOnly);
    for text in [
        crate::recording_admission::RECORDING_ADMISSION_SCHEMA,
        crate::recording_operations::RECORDING_OPERATIONS_SCHEMA,
        crate::recording_management::RECORDING_MANAGEMENT_SCHEMA,
        crate::recording_plan::RECORDING_PLAN_SCHEMA,
        include_str!("../../scada-historian/schema/history-contract.schema.json"),
    ] {
        let v: Value = serde_json::from_str(text).expect("bundled JSON");
        let id = v["$id"].as_str().expect("bundled ID").to_owned();
        options = options.with_resource(
            id,
            jsonschema::Resource::from_contents(v).expect("bundled schema"),
        );
    }
    options
        .build(&serde_json::from_str::<Value>(RECORDING_WIRE_SCHEMA).expect("bundled JSON"))
        .expect("local wire schemas")
});
fn profile(kind: &str) -> WireBound {
    match kind {
        "recordingWireCallInspectionRequest" => WIRE_INSPECTION_REQUEST_LIMIT,
        "recordingWireCallInspectionReply" => WIRE_INSPECTION_REPLY_LIMIT,
        _ if kind.ends_with("Request") => WIRE_REQUEST_LIMIT,
        _ => WIRE_REPLY_LIMIT,
    }
}
fn measure(value: &Value, limit: WireBound) -> Result<WireBound, RecordingWireError> {
    let mut b = JsonBudget::conservative_with_limits(limit.bytes, limit.nodes, limit.depth);
    b.visit(value, 0).map_err(|_| RecordingWireError)?;
    let (bytes, nodes, depth) = b.metrics();
    Ok(WireBound {
        bytes,
        nodes,
        depth,
    })
}
/// Conservative structural JSON metrics only, not schema validity or execution authority.
/// Caller limits may shrink the largest wire profile, never increase traversal bounds.
pub fn conservative_recording_json_bound(
    value: &Value,
    limit: WireBound,
) -> Result<WireBound, RecordingWireError> {
    require(
        limit.bytes <= WIRE_INSPECTION_REPLY_LIMIT.bytes
            && limit.nodes <= WIRE_INSPECTION_REPLY_LIMIT.nodes
            && limit.depth <= WIRE_INSPECTION_REPLY_LIMIT.depth,
    )?;
    measure(value, limit)
}
fn known(kind: &str) -> bool {
    matches!(
        kind,
        "recordingWireLeaseRequest"
            | "recordingWireLeaseReply"
            | "recordingWireObservationRequest"
            | "recordingWireObservationReply"
            | "recordingWireCancelRequest"
            | "recordingWireCancelReply"
            | "recordingWireAttachRequest"
            | "recordingWireAttachReply"
            | "recordingWireStateFrame"
            | "recordingWireControlRequest"
            | "recordingWireControlReply"
            | "recordingWireControlFrame"
            | "recordingWireCallInspectionRequest"
            | "recordingWireCallInspectionReply"
    )
}
fn is_request(value: &Value) -> bool {
    value["kind"]
        .as_str()
        .is_some_and(|k| known(k) && k.ends_with("Request"))
}
pub fn validate_recording_wire(value: &Value) -> Result<(), RecordingWireError> {
    let kind = value["kind"].as_str().ok_or(RecordingWireError)?;
    require(known(kind))?;
    measure(value, profile(kind))?;
    require(VALIDATOR.is_valid(value))?;
    semantic::document(value)?;
    if is_request(value) {
        capacity::check(value, WIRE_REPLY_LIMIT, WIRE_INSPECTION_REPLY_LIMIT)?;
    }
    Ok(())
}
#[derive(Clone, Debug, PartialEq)]
pub struct RecordingWireDocument(Value);
impl RecordingWireDocument {
    pub fn from_value(value: Value) -> Result<Self, RecordingWireError> {
        validate_recording_wire(&value)?;
        Ok(Self(value))
    }
    pub fn as_value(&self) -> &Value {
        &self.0
    }
}
macro_rules! owned {
    ($name:ident,$kind:literal) => {
        #[derive(Clone, Debug, PartialEq)]
        pub struct $name(RecordingWireDocument);
        impl $name {
            pub fn from_value(value: Value) -> Result<Self, RecordingWireError> {
                let d = RecordingWireDocument::from_value(value)?;
                require(d.0["kind"] == $kind)?;
                Ok(Self(d))
            }
            pub fn as_value(&self) -> &Value {
                self.0.as_value()
            }
            pub fn as_document(&self) -> &RecordingWireDocument {
                &self.0
            }
        }
        impl From<$name> for RecordingWireDocument {
            fn from(v: $name) -> Self {
                v.0
            }
        }
    };
}
owned!(RecordingWireLeaseRequest, "recordingWireLeaseRequest");
owned!(RecordingWireLeaseReply, "recordingWireLeaseReply");
owned!(
    RecordingWireObservationRequest,
    "recordingWireObservationRequest"
);
owned!(
    RecordingWireObservationReply,
    "recordingWireObservationReply"
);
owned!(RecordingWireCancelRequest, "recordingWireCancelRequest");
owned!(RecordingWireCancelReply, "recordingWireCancelReply");
owned!(RecordingWireAttachRequest, "recordingWireAttachRequest");
owned!(RecordingWireAttachReply, "recordingWireAttachReply");
owned!(RecordingWireStateFrame, "recordingWireStateFrame");
owned!(RecordingWireControlRequest, "recordingWireControlRequest");
owned!(RecordingWireControlReply, "recordingWireControlReply");
owned!(RecordingWireControlFrame, "recordingWireControlFrame");
owned!(
    RecordingWireCallInspectionRequest,
    "recordingWireCallInspectionRequest"
);
owned!(
    RecordingWireCallInspectionReply,
    "recordingWireCallInspectionReply"
);

/// Full validated request equality; array order remains significant.
pub fn same_recording_wire_request(a: &RecordingWireDocument, b: &RecordingWireDocument) -> bool {
    is_request(a.as_value()) && is_request(b.as_value()) && same_json(a.as_value(), b.as_value())
}
/// Correlation only; never global opaque ownership or authentication.
pub fn recording_wire_reply_matches_request(
    reply: &RecordingWireDocument,
    request: &RecordingWireDocument,
) -> bool {
    let (r, q) = (reply.as_value(), request.as_value());
    let Some(k) = q["kind"].as_str() else {
        return false;
    };
    is_request(q) && r["kind"] == k.replace("Request", "Reply") && same_json(&r["request"], q)
}
pub fn recording_wire_frame_matches_subscription(
    frame: &RecordingWireDocument,
    attach: &RecordingWireDocument,
) -> bool {
    let (f, a) = (frame.as_value(), attach.as_value());
    if a["kind"] != "recordingWireAttachReply" || a["outcome"]["kind"] != "attached" {
        return false;
    }
    let scope = match f["kind"].as_str() {
        Some("recordingWireStateFrame") => {
            if f["snapshot"]["revision"].as_f64() < a["outcome"]["snapshot"]["revision"].as_f64() {
                return false;
            }
            &f["snapshot"]["scope"]
        }
        Some("recordingWireControlFrame") => &f["scope"],
        _ => return false,
    };
    f["subscriptionRef"] == a["outcome"]["subscriptionRef"]
        && same_json(scope, &a["request"]["scope"])
}
/// Prospective read-only inspection envelope capacity for a legacy or wire call.
/// Does not change the legacy validator or dispatch/inspect anything.
pub fn recording_wire_original_capacity(
    scope: Value,
    original: Value,
) -> Result<WireReplyCapacity, RecordingWireError> {
    let v = RecordingWireCallInspectionRequest::from_value(
        json!({"version":1,"kind":"recordingWireCallInspectionRequest","scope":scope,"callInspectionId":"r".repeat(64),"original":original}),
    )?;
    recording_wire_reply_capacity(v.as_document())
}
#[cfg(test)]
mod tests;
