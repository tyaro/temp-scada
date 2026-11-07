//! Read-only preflight admission knowledge with immutable, bounded query history.
use super::{
    kernel::budget::measured,
    workflow::{accepted_preflight_reply, PreflightDispatchState, RecordingRegistryWorkflowTicket},
    LeaseError, LeaseRole, RecordingRegistryRoot, RecordingRegistrySession,
};
use scada_model::recording_admission::{
    same_recording_admission_inspection_request, same_recording_admission_request,
    RecordingAdmissionInspectionReply, RecordingAdmissionInspectionRequest,
    RecordingAdmissionReply, RecordingAdmissionRequest,
};
use scada_model::recording_operations::{
    same_recording_change_request, same_recording_operations_context, RecordingChangeRequest,
    RecordingOperationsContext,
};
use serde_json::json;
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::Arc,
};

const MAX_ADMISSION_INSPECTIONS: usize = 4096;

impl RecordingRegistryRoot {
    /// Freezes one observation of native preflight acceptance without changing its original call reply.
    pub fn inspect_preflight_admission(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        request: RecordingAdmissionInspectionRequest,
    ) -> Result<RecordingAdmissionInspectionReply, LeaseError> {
        if self.closed {
            return Err(LeaseError::Closed);
        }
        self.check_grant(session)?;
        if !Arc::ptr_eq(&self.identity, &session.root_identity)
            || !Arc::ptr_eq(&self.identity, &workflow.identity)
            || session.scope != self.scope
            || session.role != LeaseRole::Reconciliation
        {
            return Err(LeaseError::Forbidden);
        }
        let record = self.workflow.as_ref().ok_or(LeaseError::InvalidInput)?;
        if record.principal != session.principal {
            return Err(LeaseError::Forbidden);
        }
        if record.ticket.sequence() != workflow.sequence()
            || record.ticket.change_id() != workflow.change_id()
        {
            return Err(LeaseError::ProtocolViolation);
        }
        let value = request.as_value();
        let original = RecordingAdmissionRequest::from_value(value["original"].clone())
            .map_err(|_| LeaseError::InvalidInput)?;
        let source = original.as_value();
        if source["ownerRef"] != self.scope["ownerRef"] || source["action"]["kind"] != "preflight" {
            return Err(LeaseError::Forbidden);
        }
        let context = RecordingOperationsContext::from_value(source["context"].clone())
            .map_err(|_| LeaseError::InvalidInput)?;
        if !same_recording_operations_context(&context, self.seed.context()) {
            return Err(LeaseError::Forbidden);
        }
        let change = RecordingChangeRequest::from_value(source["action"]["change"].clone())
            .map_err(|_| LeaseError::InvalidInput)?;
        if !same_recording_change_request(&record.change, &change) {
            return Err(LeaseError::ProtocolViolation);
        }
        let id = value["inspectionId"].as_str().expect("validated ID");
        if let Some((existing, reply)) = self.admission_inspections.get(id) {
            if !same_recording_admission_inspection_request(existing, &request) {
                return Err(LeaseError::ProtocolViolation);
            }
            return Ok(reply.clone());
        }
        if self.admission_inspections.len() >= MAX_ADMISSION_INSPECTIONS {
            return Err(LeaseError::Capacity);
        }
        let mut new_knowledge = None;
        let outcome = if let Some(registered) = record.registered.as_ref().filter(|r| {
            r.ticket.admission_id() == source["admissionId"].as_str().expect("validated ID")
        }) {
            if !same_recording_admission_request(&registered.request, &original) {
                return Err(LeaseError::ProtocolViolation);
            }
            let unknown = || {
                RecordingAdmissionReply::from_value(json!({
                "version":1, "kind":"recordingAdmissionReply",
                "request":original.as_value(), "outcome":{"kind":"unknown","error":"workerFailure"}
            })).expect("validated original request")
            };
            let proof = match &registered.state {
                PreflightDispatchState::Finished(reply)
                    if reply.as_value()["outcome"]["kind"] != "unknown" =>
                {
                    reply.clone()
                }
                _ if registered.knowledge.is_some() => {
                    registered.knowledge.as_ref().unwrap().clone()
                }
                _ => registered
                    .binding
                    .as_ref()
                    .and_then(|binding| {
                        catch_unwind(AssertUnwindSafe(|| {
                            #[cfg(test)]
                            if registered.inspection_projection_panic {
                                panic!("test inspection projection panic");
                            }
                            accepted_preflight_reply(
                                &registered.request,
                                registered.ticket.sequence(),
                                binding,
                                registered.budget,
                            )
                        }))
                        .ok()
                        .flatten()
                    })
                    .unwrap_or_else(unknown),
            };
            registered
                .budget
                .check_reply(proof.as_value())
                .map_err(|_| LeaseError::Capacity)?;
            if registered.knowledge.is_none() && proof.as_value()["outcome"]["kind"] == "accepted" {
                new_knowledge = Some(proof.clone());
            }
            json!({"kind":"found","reply":proof.as_value()})
        } else {
            json!({"kind":"notFound"})
        };
        let reply = RecordingAdmissionInspectionReply::from_value(json!({
            "version":1, "kind":"recordingAdmissionInspectionReply",
            "request":value, "outcome":outcome
        }))
        .map_err(|_| LeaseError::InvalidInput)?;
        let bytes = measured(value)
            .map_err(|_| LeaseError::Capacity)?
            .bytes
            .checked_add(
                measured(reply.as_value())
                    .map_err(|_| LeaseError::Capacity)?
                    .bytes,
            )
            .ok_or(LeaseError::Capacity)?;
        let next_bytes = self
            .read_bytes
            .checked_add(bytes)
            .ok_or(LeaseError::Capacity)?;
        if next_bytes > self.read_byte_limit {
            return Err(LeaseError::Capacity);
        }
        if let Some(proof) = new_knowledge {
            self.workflow
                .as_mut()
                .expect("qualified workflow")
                .registered
                .as_mut()
                .expect("qualified admission")
                .knowledge = Some(proof);
        }
        self.read_bytes = next_bytes;
        self.admission_inspections
            .insert(id.to_owned(), (request, reply.clone()));
        Ok(reply)
    }
}
