//! Pure upper bounds for one four-stage workflow. Templates grant no native authority.
use super::budget::{fits_bound, measured, sum, BudgetError, LifetimeBudget};
use scada_model::recording_admission::RecordingAdmissionRequest;
use scada_model::recording_operations::RecordingChangeRequest;
use scada_model::recording_wire::{WireBound, WIRE_SNAPSHOT_LIMIT};
use serde_json::{json, Value};

const METADATA_BYTES: usize = 1024;
const SNAPSHOT_ENVELOPE: WireBound = WireBound {
    bytes: 65536,
    nodes: 4096,
    depth: 3,
};

#[derive(Clone, Copy, Debug)]
pub(crate) struct StageBudget {
    pub storage: LifetimeBudget,
    pub lease_bytes: usize,
}

impl StageBudget {
    pub fn bytes(self) -> Result<usize, BudgetError> {
        sum(self.storage.bytes()?, self.lease_bytes)
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct WorkflowBudget {
    pub total_bytes: usize,
}

pub(crate) fn stage(
    change: &RecordingChangeRequest,
    scope: &Value,
    name: &str,
) -> Result<(StageBudget, RecordingAdmissionRequest), BudgetError> {
    let max = "r".repeat(64);
    let operation = json!({
        "version":1, "kind":"recordingOperationRequest", "operationId":max,
        "stage":name, "change":change.as_value()
    });
    let action = match name {
        "preflight" => json!({"kind":"preflight", "change":change.as_value()}),
        "discard" => json!({"kind":"discard", "changeRef":max, "change":change.as_value()}),
        "pauseJoin" | "apply" => {
            json!({"kind":name, "changeRef":max, "operation":operation})
        }
        _ => return Err(BudgetError::InvalidInput),
    };
    let request = RecordingAdmissionRequest::from_value(json!({
        "version":1, "kind":"recordingAdmissionRequest", "ownerRef":scope["ownerRef"],
        "admissionId":max, "context":scope["context"],
        "deadlineLeaseRef":max, "action":action
    }))
    .map_err(|_| BudgetError::Capacity)?;
    let lease = json!({
        "version":1, "kind":"recordingWireLeaseRequest", "scope":scope,
        "leaseRequestId":max, "admissionId":max,
        "role":"mutation", "requestedBudgetMs":10000
    });
    let reply = json!({
        "version":1, "kind":"recordingWireLeaseReply", "request":lease,
        "outcome":{"kind":"issued", "deadlineLeaseRef":max, "grantedBudgetMs":10000}
    });
    let lease_bytes = sum(measured(&lease)?.bytes, measured(&reply)?.bytes)?;
    Ok((
        StageBudget {
            storage: LifetimeBudget::for_request(&request)?,
            lease_bytes,
        },
        request,
    ))
}

pub(crate) fn workflow(
    change: &RecordingChangeRequest,
    scope: &Value,
) -> Result<WorkflowBudget, BudgetError> {
    let mut total_bytes = sum(measured(change.as_value())?.bytes, METADATA_BYTES)?;
    let mut admission = WireBound {
        bytes: 0,
        nodes: 0,
        depth: 0,
    };
    let mut operation = admission;
    for name in ["preflight", "pauseJoin", "apply", "discard"] {
        let (budget, _) = stage(change, scope, name)?;
        total_bytes = sum(total_bytes, budget.bytes()?)?;
        admission = max_bound(admission, budget.storage.reply);
        if name != "discard" {
            operation = max_bound(operation, budget.storage.completion);
        }
    }
    let scope_bound = measured(scope)?;
    let snapshot = WireBound {
        bytes: sum(
            sum(sum(scope_bound.bytes, admission.bytes)?, operation.bytes)?,
            SNAPSHOT_ENVELOPE.bytes,
        )?,
        nodes: sum(
            sum(sum(scope_bound.nodes, admission.nodes)?, operation.nodes)?,
            SNAPSHOT_ENVELOPE.nodes,
        )?,
        depth: (scope_bound.depth + 1)
            .max(admission.depth + 1)
            .max(operation.depth + 2)
            .max(3),
    };
    if !fits_bound(snapshot, WIRE_SNAPSHOT_LIMIT) {
        return Err(BudgetError::Capacity);
    }
    Ok(WorkflowBudget { total_bytes })
}

fn max_bound(a: WireBound, b: WireBound) -> WireBound {
    WireBound {
        bytes: a.bytes.max(b.bytes),
        nodes: a.nodes.max(b.nodes),
        depth: a.depth.max(b.depth),
    }
}
