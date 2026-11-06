//! Request-derived lifetime bounds. No model clock, principal, or native authority.
use scada_model::recording_admission::RecordingAdmissionRequest;
use scada_model::recording_wire::{
    conservative_recording_json_bound, WireBound, WIRE_INSPECTION_REPLY_LIMIT,
};
use serde_json::{json, Value};

pub(crate) const READ_ID_BYTES: usize = 256;
const ENVELOPE: WireBound = WireBound {
    bytes: 65536,
    nodes: 4096,
    depth: 3,
};
const ZERO: WireBound = WireBound {
    bytes: 0,
    nodes: 0,
    depth: 0,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BudgetError {
    InvalidInput,
    Capacity,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct LifetimeBudget {
    pub request: WireBound,
    pub reply: WireBound,
    pub completion: WireBound,
}

pub(crate) fn measured(v: &Value) -> Result<WireBound, BudgetError> {
    conservative_recording_json_bound(v, WIRE_INSPECTION_REPLY_LIMIT)
        .map_err(|_| BudgetError::InvalidInput)
}

pub(crate) fn fits_bound(a: WireBound, b: WireBound) -> bool {
    a.bytes <= b.bytes && a.nodes <= b.nodes && a.depth <= b.depth
}

pub(crate) fn sum(a: usize, b: usize) -> Result<usize, BudgetError> {
    a.checked_add(b).ok_or(BudgetError::Capacity)
}

fn envelope(a: WireBound, b: WireBound, da: usize, db: usize) -> Result<WireBound, BudgetError> {
    Ok(WireBound {
        bytes: sum(sum(a.bytes, b.bytes)?, ENVELOPE.bytes)?,
        nodes: sum(sum(a.nodes, b.nodes)?, ENVELOPE.nodes)?,
        depth: (a.depth + da).max(b.depth + db).max(3),
    })
}

impl LifetimeBudget {
    pub(crate) fn for_request(q: &RecordingAdmissionRequest) -> Result<Self, BudgetError> {
        let v = q.as_value();
        let action = &v["action"];
        let handle = match action["kind"].as_str().expect("validated action") {
            "preflight" => Some(
                json!({"version":1,"kind":"recordingOperationRequest","operationId":"r".repeat(64),"stage":"preflight","change":action["change"]}),
            ),
            "pauseJoin" | "apply" => Some(action["operation"].clone()),
            "reconcile" => Some(action["reconciliation"].clone()),
            "discard" => None,
            _ => unreachable!("closed action"),
        };
        let h = handle.as_ref().map(measured).transpose()?.unwrap_or(ZERO);
        let request = measured(v)?;
        let reply = envelope(request, h, 1, 3)?;
        let completion = if handle.is_none() {
            ZERO
        } else if action["kind"] == "reconcile" {
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

    pub(crate) fn bytes(self) -> Result<usize, BudgetError> {
        sum(
            sum(self.request.bytes, sum(self.reply.bytes, self.reply.bytes)?)?,
            self.completion.bytes,
        )
    }

    pub(crate) fn covers(self, actual: Self) -> bool {
        fits_bound(actual.request, self.request)
            && fits_bound(actual.reply, self.reply)
            && fits_bound(actual.completion, self.completion)
    }

    pub(crate) fn check_request(self, v: &Value) -> Result<(), BudgetError> {
        check(v, self.request)
    }
    pub(crate) fn check_reply(self, v: &Value) -> Result<(), BudgetError> {
        check(v, self.reply)
    }
    pub(crate) fn check_completion(self, v: &Value) -> Result<(), BudgetError> {
        check(v, self.completion)
    }
}

fn check(v: &Value, bound: WireBound) -> Result<(), BudgetError> {
    if fits_bound(measured(v)?, bound) {
        Ok(())
    } else {
        Err(BudgetError::Capacity)
    }
}
