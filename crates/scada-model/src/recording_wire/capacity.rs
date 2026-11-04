use super::*;
// Closed reply fields outside request/payload use <1KiB/32 nodes.
// This fixed 64KiB/4096 reservation covers maximum IDs/errors and structure.
const ENVELOPE: WireBound = WireBound {
    bytes: 64 * 1024,
    nodes: 4096,
    depth: 3,
};
// Scalar compact JSON: control escaping <=3x, number1byte ->24 is <=3x+21.
pub const WIRE_OPERATION_RESULT_UPPER: WireBound = WireBound {
    bytes: 3 * 256 * 1024 + 21 * 8192,
    nodes: 8192,
    depth: 32,
};
const DELIVERY: WireBound = WireBound {
    bytes: 512 * 1024,
    nodes: 16384,
    depth: 48,
};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WireReplyCapacity {
    pub reply: WireBound,
    pub call_inspection: Option<WireBound>,
}
fn sum(a: usize, b: usize, c: usize) -> Result<usize, RecordingWireError> {
    a.checked_add(b)
        .and_then(|n| n.checked_add(c))
        .ok_or(RecordingWireError)
}
fn inspection_upper() -> Result<WireBound, RecordingWireError> {
    Ok(WireBound {
        bytes: sum(
            WIRE_INSPECTION_REQUEST_LIMIT.bytes,
            WIRE_REPLY_LIMIT.bytes,
            ENVELOPE.bytes,
        )?,
        nodes: sum(
            WIRE_INSPECTION_REQUEST_LIMIT.nodes,
            WIRE_REPLY_LIMIT.nodes,
            ENVELOPE.nodes,
        )?,
        depth: (WIRE_INSPECTION_REQUEST_LIMIT.depth + 1)
            .max(WIRE_REPLY_LIMIT.depth + 2)
            .max(ENVELOPE.depth),
    })
}
fn upper(request: &Value) -> Result<WireReplyCapacity, RecordingWireError> {
    if request["kind"] == "recordingWireCallInspectionRequest" {
        return Ok(WireReplyCapacity {
            reply: inspection_upper()?,
            call_inspection: None,
        });
    }
    let size = measure(request, WIRE_REQUEST_LIMIT)?;
    let payload = match request["kind"].as_str() {
        Some("recordingWireObservationRequest") => {
            if request["target"]["kind"] == "operation" {
                WIRE_OPERATION_RESULT_UPPER
            } else {
                DELIVERY
            }
        }
        Some("recordingWireAttachRequest") => WIRE_SNAPSHOT_LIMIT,
        Some("recordingWireControlRequest") if request["action"] == "snapshot" => {
            WIRE_SNAPSHOT_LIMIT
        }
        _ => WireBound {
            bytes: 0,
            nodes: 0,
            depth: 0,
        },
    };
    let reply = WireBound {
        bytes: sum(size.bytes, payload.bytes, ENVELOPE.bytes)?,
        nodes: sum(size.nodes, payload.nodes, ENVELOPE.nodes)?,
        depth: (size.depth + 1).max(payload.depth + 2).max(ENVELOPE.depth),
    };
    let call_inspection = if request["kind"] == "recordingWireObservationRequest" {
        None
    } else {
        measure(
            &json!({"version":1,"kind":"recordingWireCallInspectionRequest","scope":request["scope"],"callInspectionId":"r".repeat(64),"original":request}),
            WIRE_INSPECTION_REQUEST_LIMIT,
        )?;
        Some(inspection_upper()?)
    };
    Ok(WireReplyCapacity {
        reply,
        call_inspection,
    })
}
fn fits(b: WireBound, limit: WireBound) -> Result<(), RecordingWireError> {
    require(b.bytes <= limit.bytes && b.nodes <= limit.nodes && b.depth <= limit.depth)
}
pub(super) fn check(
    request: &Value,
    reply_limit: WireBound,
    inspection_reply_limit: WireBound,
) -> Result<WireReplyCapacity, RecordingWireError> {
    let u = upper(request)?;
    fits(
        u.reply,
        if request["kind"] == "recordingWireCallInspectionRequest" {
            inspection_reply_limit
        } else {
            reply_limit
        },
    )?;
    if let Some(b) = u.call_inspection {
        fits(b, inspection_reply_limit)?;
    }
    Ok(u)
}
pub fn recording_wire_reply_capacity(
    request: &RecordingWireDocument,
) -> Result<WireReplyCapacity, RecordingWireError> {
    require(is_request(request.as_value()))?;
    check(
        request.as_value(),
        WIRE_REPLY_LIMIT,
        WIRE_INSPECTION_REPLY_LIMIT,
    )
}
