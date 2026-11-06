//! Confirmed native pause/join qualifies only the first prepaid apply lease.
use super::{
    kernel::workflow as bounds,
    lease::same_scope,
    pause::{matches_pause_operation, PauseDispatchState, RecordingRegistryPauseTicket},
    workflow::{accepted_preflight_reply, PreflightDispatchState, RecordingRegistryWorkflowTicket},
    LeaseError, RecordingRegistryRoot, RecordingRegistrySession,
};
use crate::recording_operations::OperationsPhase;
use scada_model::recording_operations::{
    same_recording_operation_request, RecordingOperationRequest,
};
use scada_model::recording_wire::{RecordingWireLeaseReply, RecordingWireLeaseRequest};
use serde_json::json;
use std::time::Instant;

pub(super) struct ApplyLease {
    pause_sequence: u64,
    change_ref: String,
    operation_id: String,
    admission_id: String,
    lease_id: String,
}

impl RecordingRegistryRoot {
    /// Uses the stored native pause handle and confirmed join; no apply is dispatched.
    pub fn issue_apply_lease(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        pause_ticket: &RecordingRegistryPauseTicket,
        operation_id: &str,
        request: RecordingWireLeaseRequest,
    ) -> Result<RecordingWireLeaseReply, LeaseError> {
        let record = self.workflow_record(session, workflow)?;
        let registered = self.registered_pause(session, pause_ticket)?;
        if request.as_value()["role"] != "mutation"
            || !same_scope(&self.scope, &request.as_value()["scope"])
        {
            return Err(LeaseError::Forbidden);
        }
        if operation_id.len() > 64 || !operation_id.is_ascii() {
            return Err(LeaseError::InvalidInput);
        }
        RecordingOperationRequest::from_value(json!({
            "version":1, "kind":"recordingOperationRequest", "operationId":operation_id,
            "stage":"apply", "change":record.change.as_value()
        }))
        .map_err(|_| LeaseError::InvalidInput)?;
        let (stage, _) = bounds::stage(&record.change, &self.scope, "apply")
            .map_err(|_| LeaseError::Capacity)?;
        let pause = record
            .pause_lease
            .as_ref()
            .ok_or(LeaseError::InvalidInput)?;
        let preflight = record.registered.as_ref().ok_or(LeaseError::InvalidInput)?;
        let preflight_operation_id = preflight.binding.as_ref().map(|binding| {
            binding.operation.request().as_value()["operationId"]
                .as_str()
                .expect("native preflight ID")
        });
        if operation_id == pause.operation_id || preflight_operation_id == Some(operation_id) {
            return Err(LeaseError::ProtocolViolation);
        }
        let admission_id = request.as_value()["admissionId"]
            .as_str()
            .expect("validated ID");
        let lease_id = request.as_value()["leaseRequestId"]
            .as_str()
            .expect("validated ID");
        if let Some(existing) = &record.apply_lease {
            if existing.pause_sequence != pause_ticket.sequence()
                || existing.change_ref != pause.change_ref
                || existing.operation_id != operation_id
                || existing.admission_id != admission_id
                || existing.lease_id != lease_id
            {
                return Err(LeaseError::ProtocolViolation);
            }
            return self.issue_prepaid_lease_at(
                session,
                request,
                Instant::now(),
                stage.lease_bytes,
            );
        }
        if self.leases.contains_key(lease_id)
            || self
                .leases
                .values()
                .any(|lease| lease.request.as_value()["admissionId"] == admission_id)
        {
            return Err(LeaseError::ProtocolViolation);
        }
        if preflight.ticket.sequence() != pause.preflight_sequence {
            return Err(LeaseError::ProtocolViolation);
        }
        let preflight_binding = preflight.binding.as_ref().ok_or(LeaseError::Busy)?;
        let expected_preflight = accepted_preflight_reply(
            &preflight.request,
            preflight.ticket.sequence(),
            preflight_binding,
            preflight.budget,
        )
        .ok_or(LeaseError::Busy)?;
        let proof = match &preflight.state {
            PreflightDispatchState::Finished(reply)
                if reply.as_value()["outcome"]["kind"] == "accepted" =>
            {
                Some(reply)
            }
            _ => preflight
                .knowledge
                .as_ref()
                .filter(|reply| reply.as_value()["outcome"]["kind"] == "accepted"),
        }
        .ok_or(LeaseError::Busy)?;
        if proof.as_value() != expected_preflight.as_value()
            || proof.as_value()["outcome"]["handle"]["changeRef"] != pause.change_ref
        {
            return Err(LeaseError::ProtocolViolation);
        }
        let reply = match &registered.state {
            PauseDispatchState::Finished(reply)
                if reply.as_value()["outcome"]["kind"] == "accepted" =>
            {
                reply
            }
            _ => return Err(LeaseError::Busy),
        };
        let binding = registered.binding.as_ref().ok_or(LeaseError::Busy)?;
        let handle = &reply.as_value()["outcome"]["handle"];
        let echoed = RecordingOperationRequest::from_value(handle["request"].clone())
            .map_err(|_| LeaseError::ProtocolViolation)?;
        if handle["changeRef"] != pause.change_ref
            || handle["operationRef"] != pause.operation_id
            || !same_recording_operation_request(&echoed, binding.request())
            || !matches_pause_operation(&registered.request, binding.request())
        {
            return Err(LeaseError::ProtocolViolation);
        }
        let completion = self
            .pause_completion(session, pause_ticket)?
            .ok_or(LeaseError::Busy)?;
        if completion.as_value()["outcome"]["kind"] != "paused"
            || completion.as_value()["outcome"]["sessionId"]
                != self.seed.context().as_value()["sessionId"]
            || completion.as_value()["quiescence"] != "confirmed"
            || completion.as_value()["recoveryRequired"] != false
        {
            return Err(LeaseError::Busy);
        }
        let owner = self.seed.client().state();
        if owner.closed || owner.recovery_required || owner.phase != OperationsPhase::Paused {
            return Err(LeaseError::Busy);
        }
        let change_ref = pause.change_ref.clone();
        let admission_id = admission_id.to_owned();
        let lease_id = lease_id.to_owned();
        let reply =
            self.issue_prepaid_lease_at(session, request, Instant::now(), stage.lease_bytes)?;
        self.workflow
            .as_mut()
            .expect("qualified workflow")
            .apply_lease = Some(ApplyLease {
            pause_sequence: pause_ticket.sequence(),
            change_ref,
            operation_id: operation_id.to_owned(),
            admission_id,
            lease_id,
        });
        Ok(reply)
    }
}
