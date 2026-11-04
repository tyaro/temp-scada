//! Request-derived lifetime bounds. Stored knowledge and original replies are independent.
use super::*;
pub(super) const READ_ID_BYTES: usize = 256;
pub(super) const ENVELOPE: WireBound = WireBound {
    bytes: 65536,
    nodes: 4096,
    depth: 3,
};
const ZERO: WireBound = WireBound {
    bytes: 0,
    nodes: 0,
    depth: 0,
};
#[derive(Clone, Copy, Debug)]
pub(super) struct LifetimeBudget {
    pub request: WireBound,
    pub reply: WireBound,
    pub completion: WireBound,
}
pub(super) fn measured(v: &Value) -> Result<WireBound, ModelError> {
    conservative_recording_json_bound(v, WIRE_INSPECTION_REPLY_LIMIT)
        .map_err(|_| ModelError::InvalidInput)
}
pub(super) fn envelope(
    a: WireBound,
    b: WireBound,
    da: usize,
    db: usize,
) -> Result<WireBound, ModelError> {
    Ok(WireBound {
        bytes: sum(sum(a.bytes, b.bytes)?, ENVELOPE.bytes)?,
        nodes: sum(sum(a.nodes, b.nodes)?, ENVELOPE.nodes)?,
        depth: (a.depth + da).max(b.depth + db).max(3),
    })
}
impl LifetimeBudget {
    pub fn for_request(q: &RecordingAdmissionRequest) -> Result<Self, ModelError> {
        let v = q.as_value();
        let a = &v["action"];
        let handle = match a["kind"].as_str().expect("validated action") {
            "preflight" => Some(
                json!({"version":1,"kind":"recordingOperationRequest","operationId":"r".repeat(64),"stage":"preflight","change":a["change"]}),
            ),
            "pauseJoin" | "apply" => Some(a["operation"].clone()),
            "reconcile" => Some(a["reconciliation"].clone()),
            "discard" => None,
            _ => unreachable!("closed action"),
        };
        let h = handle.as_ref().map(measured).transpose()?.unwrap_or(ZERO);
        let request = measured(v)?;
        let reply = envelope(request, h, 1, 3)?;
        let completion = if handle.is_none() {
            ZERO
        } else if admission_role(v) == Role::Read {
            let mut b = envelope(h, h, 3, 3)?;
            b.depth = b.depth.max(6);
            b
        } else {
            let mut b = envelope(h, ZERO, 1, 0)?;
            b.depth = b.depth.max(4);
            b
        };
        Ok(Self {
            request,
            reply,
            completion,
        })
    }
    pub fn bytes(self) -> Result<usize, ModelError> {
        sum(
            sum(self.request.bytes, sum(self.reply.bytes, self.reply.bytes)?)?,
            self.completion.bytes,
        )
    }
    pub fn check_request(self, v: &Value) -> Result<(), ModelError> {
        check(v, self.request)
    }
    pub fn check_reply(self, v: &Value) -> Result<(), ModelError> {
        check(v, self.reply)
    }
    pub fn check_completion(self, v: &Value) -> Result<(), ModelError> {
        check(v, self.completion)
    }
}
fn check(v: &Value, b: WireBound) -> Result<(), ModelError> {
    require(
        projection::fits_bound(measured(v)?, b),
        ModelError::Capacity,
    )
}
