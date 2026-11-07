//! Read-only terminal inspection of original calls (wire-host design §9, acceptance 2).
//! A call inspection only looks up saved records: an unregistered original is never
//! registered, dispatched, leased, notified or subscribed, and a saved original reply is
//! returned unchanged, so an `unknown` original admission stays `unknown` forever.
use super::{
    kernel::budget::measured, lease::same_scope, LeaseError, LeaseRole, RecordingRegistryRoot,
    RecordingRegistrySession,
};
use scada_model::recording_admission::{
    same_recording_admission_inspection_request, same_recording_admission_request,
    RecordingAdmissionInspectionRequest, RecordingAdmissionRequest,
};
use scada_model::recording_wire::{
    recording_wire_reply_capacity, same_recording_wire_request, RecordingWireCallInspectionReply,
    RecordingWireCallInspectionRequest, RecordingWireDocument,
};
use serde_json::{json, Value};
use std::sync::Arc;

/// One call inspection ID, fixed to its original call and principal at first use.
pub(super) struct CallInspectionRecord {
    request: RecordingWireCallInspectionRequest,
    principal: String,
}

impl RecordingRegistryRoot {
    /// Looks up the original call named by kind and ID and returns its saved reply as
    /// `terminal`, `pending` while a registered admission has no reply yet, or `notFound`.
    /// The session needs the role of the original call; a found record also needs its
    /// principal. `notFound` is not proof that the original can no longer arrive.
    pub fn inspect_call(
        &mut self,
        session: &RecordingRegistrySession,
        request: RecordingWireCallInspectionRequest,
    ) -> Result<RecordingWireCallInspectionReply, LeaseError> {
        self.check_grant(session)?;
        if self.closed {
            return Err(LeaseError::Closed);
        }
        let value = request.as_value();
        let original = &value["original"];
        if !Arc::ptr_eq(&self.identity, &session.root_identity)
            || session.scope != self.scope
            || !same_scope(&self.scope, &value["scope"])
            || session.role != original_role(original)
        {
            return Err(LeaseError::Forbidden);
        }
        let id = value["callInspectionId"].as_str().expect("validated ID");
        let fresh = match self.call_inspections.get(id) {
            Some(record) => {
                if record.principal != session.principal {
                    return Err(LeaseError::Forbidden);
                }
                if !same_recording_wire_request(record.request.as_document(), request.as_document())
                {
                    return Err(LeaseError::ProtocolViolation);
                }
                false
            }
            None => true,
        };
        let outcome = match self.saved_original(session, original)? {
            Some(Saved::Terminal(reply)) => json!({"kind":"terminal","reply":reply}),
            Some(Saved::Pending) => json!({"kind":"pending"}),
            None => json!({"kind":"notFound"}),
        };
        let reply = RecordingWireCallInspectionReply::from_value(json!({
            "version":1, "kind":"recordingWireCallInspectionReply",
            "request":value, "outcome":outcome
        }))
        .map_err(|_| LeaseError::ProtocolViolation)?;
        if fresh {
            if self.call_inspections.len() >= self.count_limits.call_inspections {
                return Err(LeaseError::Capacity);
            }
            // The reply is rebuilt from immutable saved records, so only the request is
            // retained; its maximum reply closure must still fit the inspection profile.
            recording_wire_reply_capacity(request.as_document())
                .map_err(|_| LeaseError::Capacity)?;
            let next_bytes = measured(value)
                .ok()
                .and_then(|bound| self.read_bytes.checked_add(bound.bytes))
                .filter(|bytes| *bytes <= self.read_byte_limit)
                .ok_or(LeaseError::Capacity)?;
            self.read_bytes = next_bytes;
            self.call_inspections.insert(
                id.to_owned(),
                CallInspectionRecord {
                    request,
                    principal: session.principal.clone(),
                },
            );
        }
        Ok(reply)
    }

    /// Finds the saved original by its kind-specific ID. A different body under the same ID
    /// is a protocol violation and another principal's record is forbidden.
    fn saved_original(
        &self,
        session: &RecordingRegistrySession,
        original: &Value,
    ) -> Result<Option<Saved>, LeaseError> {
        let id = |field: &str| original[field].as_str().expect("validated ID");
        let terminal = |reply: &Value| Some(Saved::Terminal(reply.clone()));
        match original["kind"].as_str().expect("validated kind") {
            "recordingAdmissionRequest" => {
                let current = RecordingAdmissionRequest::from_value(original.clone())
                    .map_err(|_| LeaseError::InvalidInput)?;
                let entries = self.admission_entries();
                let Some(entry) = entries
                    .iter()
                    .find(|entry| entry.request.as_value()["admissionId"] == id("admissionId"))
                else {
                    return Ok(None);
                };
                self.check_workflow_principal(session)?;
                if !same_recording_admission_request(entry.request, &current) {
                    return Err(LeaseError::ProtocolViolation);
                }
                Ok(match entry.reply {
                    Some(reply) => terminal(reply.as_value()),
                    None => Some(Saved::Pending),
                })
            }
            "recordingAdmissionInspectionRequest" => {
                let current = RecordingAdmissionInspectionRequest::from_value(original.clone())
                    .map_err(|_| LeaseError::InvalidInput)?;
                let Some((saved, reply)) = self.admission_inspections.get(id("inspectionId"))
                else {
                    return Ok(None);
                };
                self.check_workflow_principal(session)?;
                if !same_recording_admission_inspection_request(saved, &current) {
                    return Err(LeaseError::ProtocolViolation);
                }
                Ok(terminal(reply.as_value()))
            }
            kind => {
                let current = RecordingWireDocument::from_value(original.clone())
                    .map_err(|_| LeaseError::InvalidInput)?;
                Ok(match kind {
                    "recordingWireLeaseRequest" => {
                        let Some(lease) = self.leases.get(id("leaseRequestId")) else {
                            return Ok(None);
                        };
                        if lease.principal != session.principal || lease.role != session.role {
                            return Err(LeaseError::Forbidden);
                        }
                        if !same_recording_wire_request(lease.request.as_document(), &current) {
                            return Err(LeaseError::ProtocolViolation);
                        }
                        terminal(lease.reply.as_value())
                    }
                    "recordingWireCancelRequest" => self
                        .saved_cancel(id("cancelId"), &session.principal, &current)?
                        .and_then(|reply| terminal(reply.as_value())),
                    "recordingWireAttachRequest" => self
                        .saved_attach(session, &current)?
                        .and_then(|reply| terminal(reply.as_value())),
                    "recordingWireControlRequest" => self
                        .saved_control(session, &current)?
                        .and_then(|reply| terminal(reply.as_value())),
                    _ => return Err(LeaseError::InvalidInput),
                })
            }
        }
    }

    fn check_workflow_principal(
        &self,
        session: &RecordingRegistrySession,
    ) -> Result<(), LeaseError> {
        match &self.workflow {
            Some(workflow) if workflow.principal == session.principal => Ok(()),
            _ => Err(LeaseError::Forbidden),
        }
    }

    #[cfg(test)]
    pub(crate) fn test_call_inspection_count(&self) -> usize {
        self.call_inspections.len()
    }
}

enum Saved {
    Terminal(Value),
    Pending,
}

/// The role the original call itself requires, so inspection never crosses roles.
fn original_role(original: &Value) -> LeaseRole {
    let read = match original["kind"].as_str() {
        Some("recordingWireLeaseRequest") => original["role"] == "reconciliation",
        Some("recordingAdmissionRequest") => original["action"]["kind"] == "reconcile",
        Some("recordingWireCancelRequest") => original["target"]["kind"] != "operation",
        _ => true,
    };
    if read {
        LeaseRole::Reconciliation
    } else {
        LeaseRole::Mutation
    }
}
