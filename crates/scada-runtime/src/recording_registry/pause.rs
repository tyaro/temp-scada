//! Candidate-qualified pause/join admission and one-time native dispatch.
use super::{
    kernel::{budget::LifetimeBudget, workflow as bounds},
    lease::same_scope,
    workflow::{
        accepted_preflight_reply, PreflightDispatchState, RecordingRegistryAdmissionTicket,
        RecordingRegistryWorkflowTicket,
    },
    LeaseError, LeaseRole, RecordingRegistryRoot, RecordingRegistrySession,
};
use crate::recording_operations::RecordingOperationHandle;
use scada_historian::store::query::{CancellationToken, QueryControl, QueryLimits};
use scada_model::recording_admission::{
    same_recording_admission_request, RecordingAdmissionReply, RecordingAdmissionRequest,
};
use scada_model::recording_operations::{
    same_recording_operation_request, same_recording_operations_context, RecordingOperationRequest,
    RecordingOperationResult, RecordingOperationsContext,
};
use scada_model::recording_wire::{RecordingWireLeaseReply, RecordingWireLeaseRequest};
use serde_json::json;
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::Arc,
    time::Instant,
};

pub(super) struct PauseLease {
    admission_id: String,
    lease_id: String,
    pub(super) operation_id: String,
    pub(super) change_ref: String,
    preflight_operation_id: String,
    pub(super) preflight_sequence: u64,
    pub(super) registered: Option<RegisteredPause>,
}

#[derive(Clone)]
pub struct RecordingRegistryPauseTicket {
    identity: Arc<()>,
    sequence: u64,
    admission_id: String,
}

impl RecordingRegistryPauseTicket {
    pub fn admission_id(&self) -> &str {
        &self.admission_id
    }
    pub fn sequence(&self) -> u64 {
        self.sequence
    }
}

pub enum PauseRegistration {
    Registered(RecordingRegistryPauseTicket),
    Existing(RecordingRegistryPauseTicket),
}

pub(super) struct RegisteredPause {
    ticket: RecordingRegistryPauseTicket,
    pub(super) request: RecordingAdmissionRequest,
    budget: LifetimeBudget,
    pub(super) state: PauseDispatchState,
    pub(super) binding: Option<RecordingOperationHandle>,
    #[cfg(test)]
    fault: Option<PauseDispatchFault>,
}

pub(super) enum PauseDispatchState {
    Registered,
    Calling,
    Finished(RecordingAdmissionReply),
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum PauseDispatchFault {
    NativePanicAfterCall,
    ProjectionPanic,
}

impl PauseLease {
    pub(super) fn is_uncertain(&self) -> bool {
        self.registered
            .as_ref()
            .is_some_and(|record| match &record.state {
                PauseDispatchState::Calling => true,
                PauseDispatchState::Finished(reply) => {
                    reply.as_value()["outcome"]["kind"] == "unknown"
                }
                PauseDispatchState::Registered => false,
            })
    }
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
            registered: None,
        });
        Ok(reply)
    }
}

impl RecordingRegistryRoot {
    /// Stores the original pause admission and consumes its lease before native dispatch.
    pub fn register_pause_join(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        preflight: &RecordingRegistryAdmissionTicket,
        request: RecordingAdmissionRequest,
    ) -> Result<PauseRegistration, LeaseError> {
        self.register_pause_join_with_clock(session, workflow, preflight, request, Instant::now)
    }

    #[cfg(test)]
    pub(crate) fn register_pause_join_at(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        preflight: &RecordingRegistryAdmissionTicket,
        request: RecordingAdmissionRequest,
        now: Instant,
    ) -> Result<PauseRegistration, LeaseError> {
        self.register_pause_join_with_clock(session, workflow, preflight, request, || now)
    }

    fn register_pause_join_with_clock(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        preflight: &RecordingRegistryAdmissionTicket,
        request: RecordingAdmissionRequest,
        clock: impl FnOnce() -> Instant,
    ) -> Result<PauseRegistration, LeaseError> {
        let record = self.workflow_record(session, workflow)?;
        self.registered_preflight(session, preflight)?;
        let pause = record
            .pause_lease
            .as_ref()
            .ok_or(LeaseError::InvalidInput)?;
        let value = request.as_value();
        if value["ownerRef"] != self.scope["ownerRef"] || value["action"]["kind"] != "pauseJoin" {
            return Err(LeaseError::Forbidden);
        }
        let context = RecordingOperationsContext::from_value(value["context"].clone())
            .map_err(|_| LeaseError::InvalidInput)?;
        if !same_recording_operations_context(&context, self.seed.context()) {
            return Err(LeaseError::Forbidden);
        }
        if pause.preflight_sequence != preflight.sequence()
            || value["admissionId"] != pause.admission_id
            || value["action"]["changeRef"] != pause.change_ref
        {
            return Err(LeaseError::ProtocolViolation);
        }
        let operation = RecordingOperationRequest::from_value(value["action"]["operation"].clone())
            .map_err(|_| LeaseError::InvalidInput)?;
        let expected = RecordingOperationRequest::from_value(json!({
            "version":1, "kind":"recordingOperationRequest",
            "operationId":pause.operation_id, "stage":"pauseJoin", "change":record.change.as_value()
        }))
        .map_err(|_| LeaseError::InvalidInput)?;
        if !same_recording_operation_request(&operation, &expected) {
            return Err(LeaseError::ProtocolViolation);
        }
        if let Some(existing) = &pause.registered {
            if !same_recording_admission_request(&existing.request, &request) {
                return Err(LeaseError::ProtocolViolation);
            }
            return Ok(PauseRegistration::Existing(existing.ticket.clone()));
        }
        let lease = self
            .leases
            .get(&pause.lease_id)
            .ok_or(LeaseError::InvalidInput)?;
        if !lease.workflow_owned
            || lease.principal != session.principal
            || lease.role != LeaseRole::Mutation
        {
            return Err(LeaseError::Forbidden);
        }
        if lease.request.as_value()["admissionId"] != value["admissionId"]
            || lease.reply.as_value()["outcome"]["deadlineLeaseRef"] != value["deadlineLeaseRef"]
        {
            return Err(LeaseError::ProtocolViolation);
        }
        if lease.consumed {
            return Err(LeaseError::ProtocolViolation);
        }
        let (stage, _) = bounds::stage(&record.change, &self.scope, "pauseJoin")
            .map_err(|_| LeaseError::Capacity)?;
        let budget = LifetimeBudget::for_request(&request).map_err(|_| LeaseError::Capacity)?;
        if !stage.storage.covers(budget) {
            return Err(LeaseError::Capacity);
        }
        let sequence = self.sequence.checked_add(1).ok_or(LeaseError::Capacity)?;
        let ticket = RecordingRegistryPauseTicket {
            identity: self.identity.clone(),
            sequence,
            admission_id: pause.admission_id.clone(),
        };
        if clock() >= lease.deadline {
            return Err(LeaseError::Expired);
        }
        let lease_id = pause.lease_id.clone();
        self.sequence = sequence;
        self.leases
            .get_mut(&lease_id)
            .expect("qualified lease")
            .consumed = true;
        self.workflow
            .as_mut()
            .expect("qualified workflow")
            .pause_lease
            .as_mut()
            .expect("qualified pause lease")
            .registered = Some(RegisteredPause {
            ticket: ticket.clone(),
            request,
            budget: stage.storage,
            state: PauseDispatchState::Registered,
            binding: None,
            #[cfg(test)]
            fault: None,
        });
        Ok(PauseRegistration::Registered(ticket))
    }

    pub(super) fn registered_pause(
        &self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryPauseTicket,
    ) -> Result<&RegisteredPause, LeaseError> {
        if self.closed {
            return Err(LeaseError::Closed);
        }
        if !Arc::ptr_eq(&self.identity, &session.root_identity)
            || !Arc::ptr_eq(&self.identity, &ticket.identity)
            || session.scope != self.scope
            || session.role != LeaseRole::Mutation
        {
            return Err(LeaseError::Forbidden);
        }
        let record = self.workflow.as_ref().ok_or(LeaseError::InvalidInput)?;
        if record.principal != session.principal {
            return Err(LeaseError::Forbidden);
        }
        let pause = record
            .pause_lease
            .as_ref()
            .ok_or(LeaseError::InvalidInput)?;
        let registered = pause.registered.as_ref().ok_or(LeaseError::InvalidInput)?;
        if registered.ticket.sequence != ticket.sequence
            || registered.ticket.admission_id != ticket.admission_id
        {
            return Err(LeaseError::ProtocolViolation);
        }
        Ok(registered)
    }

    pub fn pause_reply(
        &self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryPauseTicket,
    ) -> Result<Option<RecordingAdmissionReply>, LeaseError> {
        let registered = self.registered_pause(session, ticket)?;
        Ok(match &registered.state {
            PauseDispatchState::Finished(reply) => Some(reply.clone()),
            _ => None,
        })
    }

    pub fn pause_completion(
        &self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryPauseTicket,
    ) -> Result<Option<Arc<RecordingOperationResult>>, LeaseError> {
        let registered = self.registered_pause(session, ticket)?;
        let Some(binding) = &registered.binding else {
            return Ok(None);
        };
        let receiver = binding.watch();
        let result = receiver.borrow().clone();
        if let Some(value) = &result {
            registered
                .budget
                .check_completion(value.as_value())
                .map_err(|_| LeaseError::Capacity)?;
            let completed_request =
                RecordingOperationRequest::from_value(value.as_value()["request"].clone())
                    .map_err(|_| LeaseError::ProtocolViolation)?;
            if !matches_pause_operation(&registered.request, &completed_request) {
                return Err(LeaseError::ProtocolViolation);
            }
        }
        Ok(result)
    }

    /// Dispatches the registered pause exactly once and keeps its native join handle.
    pub fn dispatch_pause_join(
        &mut self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryPauseTicket,
    ) -> Result<RecordingAdmissionReply, LeaseError> {
        let registered = self.registered_pause(session, ticket)?;
        match &registered.state {
            PauseDispatchState::Finished(reply) => return Ok(reply.clone()),
            PauseDispatchState::Calling => return Err(LeaseError::Busy),
            PauseDispatchState::Registered => {}
        }
        let request = registered.request.clone();
        let budget = registered.budget;
        #[cfg(test)]
        let fault = registered.fault;
        let record = self.workflow.as_ref().expect("qualified workflow");
        let pause = record.pause_lease.as_ref().expect("qualified pause lease");
        let lease_id = pause.lease_id.clone();
        let operation_id = pause.operation_id.clone();
        let change_ref = pause.change_ref.clone();
        let change = record
            .registered
            .as_ref()
            .and_then(|preflight| preflight.binding.as_ref())
            .ok_or(LeaseError::Busy)?
            .change
            .clone();
        let deadline = self.leases[&lease_id].deadline;
        let unknown =
            pause_admission_reply(&request, json!({"kind":"unknown","error":"workerFailure"}));
        budget
            .check_reply(unknown.as_value())
            .map_err(|_| LeaseError::Capacity)?;
        let expired = Instant::now() >= deadline;
        let registered = self
            .workflow
            .as_mut()
            .expect("qualified workflow")
            .pause_lease
            .as_mut()
            .expect("qualified pause lease")
            .registered
            .as_mut()
            .expect("qualified admission");
        if expired {
            let reply = pause_admission_reply(
                &request,
                json!({"kind":"rejected","error":"deadlineExceeded"}),
            );
            budget
                .check_reply(reply.as_value())
                .map_err(|_| LeaseError::Capacity)?;
            registered.state = PauseDispatchState::Finished(reply.clone());
            return Ok(reply);
        }
        registered.state = PauseDispatchState::Calling;
        let control = QueryControl {
            cancellation: CancellationToken::default(),
            deadline,
            limits: QueryLimits::default(),
        };
        let result = catch_unwind(AssertUnwindSafe(|| {
            let result = self
                .seed
                .client()
                .pause_join(&change, &operation_id, control);
            #[cfg(test)]
            if fault == Some(PauseDispatchFault::NativePanicAfterCall) {
                panic!("test pause panic after native call");
            }
            result
        }));
        let registered = self
            .workflow
            .as_mut()
            .expect("qualified workflow")
            .pause_lease
            .as_mut()
            .expect("qualified pause lease")
            .registered
            .as_mut()
            .expect("qualified admission");
        let reply = match result {
            Ok(Ok(binding)) => {
                registered.binding = Some(binding);
                catch_unwind(AssertUnwindSafe(|| {
                    #[cfg(test)]
                    if fault == Some(PauseDispatchFault::ProjectionPanic) {
                        panic!("test pause projection panic after handle save");
                    }
                    let binding = registered.binding.as_ref().expect("saved pause handle");
                    if !matches_pause_operation(&request, binding.request()) {
                        return None;
                    }
                    let reply = pause_admission_reply(
                        &request,
                        json!({
                            "kind":"accepted", "handle":{
                                "kind":"operation", "changeRef":change_ref,
                                "operationRef":binding.request().as_value()["operationId"],
                                "request":binding.request().as_value()
                            }
                        }),
                    );
                    budget.check_reply(reply.as_value()).ok()?;
                    Some(reply)
                }))
                .ok()
                .flatten()
                .unwrap_or_else(|| unknown.clone())
            }
            Ok(Err(rejection)) => pause_admission_reply(
                &request,
                json!({"kind":"rejected","error":rejection.code.as_str()}),
            ),
            Err(_) => unknown.clone(),
        };
        if budget.check_reply(reply.as_value()).is_err() {
            registered.state = PauseDispatchState::Finished(unknown.clone());
            return Ok(unknown);
        }
        registered.state = PauseDispatchState::Finished(reply.clone());
        Ok(reply)
    }

    #[cfg(test)]
    pub(crate) fn test_set_pause_dispatch_fault(
        &mut self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryPauseTicket,
        fault: PauseDispatchFault,
    ) {
        self.registered_pause(session, ticket).unwrap();
        self.workflow
            .as_mut()
            .unwrap()
            .pause_lease
            .as_mut()
            .unwrap()
            .registered
            .as_mut()
            .unwrap()
            .fault = Some(fault);
    }
}

fn pause_admission_reply(
    request: &RecordingAdmissionRequest,
    outcome: serde_json::Value,
) -> RecordingAdmissionReply {
    RecordingAdmissionReply::from_value(json!({
        "version":1, "kind":"recordingAdmissionReply", "request":request.as_value(), "outcome":outcome
    }))
    .expect("validated admission and reserved reply capacity")
}

pub(super) fn matches_pause_operation(
    admission: &RecordingAdmissionRequest,
    actual: &RecordingOperationRequest,
) -> bool {
    RecordingOperationRequest::from_value(admission.as_value()["action"]["operation"].clone())
        .is_ok_and(|expected| same_recording_operation_request(&expected, actual))
}
