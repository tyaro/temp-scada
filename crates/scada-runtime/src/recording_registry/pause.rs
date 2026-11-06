//! Candidate-qualified reservation for the first pause/join lease; no native stop is issued here.
use super::{
    kernel::workflow as bounds,
    lease::same_scope,
    workflow::{
        accepted_preflight_reply, PreflightDispatchState, RecordingRegistryAdmissionTicket,
        RecordingRegistryWorkflowTicket,
    },
    LeaseError, RecordingRegistryRoot, RecordingRegistrySession,
};
use scada_model::recording_operations::{
    same_recording_operation_request, RecordingOperationRequest,
};
use scada_model::recording_wire::{RecordingWireLeaseReply, RecordingWireLeaseRequest};
use serde_json::json;
use std::time::Instant;

pub(super) struct PauseLease {
    admission_id: String,
    lease_id: String,
    operation_id: String,
    change_ref: String,
    preflight_operation_id: String,
    preflight_sequence: u64,
}

impl RecordingRegistryRoot {
    /// Binds one caller operation ID to a real, confirmed Candidate before issuing its prepaid lease.
    pub fn issue_pause_join_lease(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        preflight: &RecordingRegistryAdmissionTicket,
        operation_id: &str,
        request: RecordingWireLeaseRequest,
    ) -> Result<RecordingWireLeaseReply, LeaseError> {
        let record = self.workflow_record(session, workflow)?;
        let registered = self.registered_preflight(session, preflight)?;
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
            "stage":"pauseJoin", "change":record.change.as_value()
        }))
        .map_err(|_| LeaseError::InvalidInput)?;
        let (stage, _) = bounds::stage(&record.change, &self.scope, "pauseJoin")
            .map_err(|_| LeaseError::Capacity)?;
        let native_operation_id = registered.binding.as_ref().map(|binding| {
            binding.operation.request().as_value()["operationId"]
                .as_str()
                .expect("native ID")
        });
        if native_operation_id == Some(operation_id) {
            return Err(LeaseError::ProtocolViolation);
        }
        let proof = match &registered.state {
            PreflightDispatchState::Finished(reply)
                if reply.as_value()["outcome"]["kind"] == "accepted" =>
            {
                Some(reply)
            }
            _ => registered
                .knowledge
                .as_ref()
                .filter(|reply| reply.as_value()["outcome"]["kind"] == "accepted"),
        }
        .ok_or(LeaseError::Busy)?;
        let binding = registered.binding.as_ref().ok_or(LeaseError::Busy)?;
        let expected = accepted_preflight_reply(
            &registered.request,
            registered.ticket.sequence(),
            binding,
            registered.budget,
        )
        .ok_or(LeaseError::Busy)?;
        if proof.as_value() != expected.as_value() {
            return Err(LeaseError::ProtocolViolation);
        }
        let change_ref = proof.as_value()["outcome"]["handle"]["changeRef"]
            .as_str()
            .expect("accepted change ref")
            .to_owned();
        let native_operation_id = native_operation_id.expect("saved binding").to_owned();
        let admission_id = request.as_value()["admissionId"]
            .as_str()
            .expect("validated ID")
            .to_owned();
        let lease_id = request.as_value()["leaseRequestId"]
            .as_str()
            .expect("validated ID")
            .to_owned();
        if let Some(existing) = &record.pause_lease {
            if existing.preflight_sequence != preflight.sequence()
                || existing.change_ref != change_ref
                || existing.preflight_operation_id != native_operation_id
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
        if self.leases.contains_key(&lease_id)
            || self
                .leases
                .values()
                .any(|lease| lease.request.as_value()["admissionId"] == admission_id)
        {
            return Err(LeaseError::ProtocolViolation);
        }
        let receiver = binding.operation.watch();
        let completion = receiver.borrow().clone().ok_or(LeaseError::Busy)?;
        registered
            .budget
            .check_completion(completion.as_value())
            .map_err(|_| LeaseError::Capacity)?;
        let completed_request =
            RecordingOperationRequest::from_value(completion.as_value()["request"].clone())
                .map_err(|_| LeaseError::ProtocolViolation)?;
        if !same_recording_operation_request(&completed_request, binding.operation.request()) {
            return Err(LeaseError::ProtocolViolation);
        }
        if completion.as_value()["outcome"]["kind"] != "candidate"
            || completion.as_value()["quiescence"] != "confirmed"
            || completion.as_value()["recoveryRequired"] != false
        {
            return Err(LeaseError::Busy);
        }
        let reply =
            self.issue_prepaid_lease_at(session, request, Instant::now(), stage.lease_bytes)?;
        self.workflow
            .as_mut()
            .expect("qualified workflow")
            .pause_lease = Some(PauseLease {
            admission_id,
            lease_id,
            operation_id: operation_id.to_owned(),
            change_ref,
            preflight_operation_id: native_operation_id,
            preflight_sequence: preflight.sequence(),
        });
        Ok(reply)
    }
}
