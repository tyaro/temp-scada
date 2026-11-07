//! Confirmed native pause/join qualifies the first apply lease and native dispatch.
use super::{
    kernel::{budget::LifetimeBudget, workflow as bounds},
    lease::same_scope,
    pause::{matches_pause_operation, PauseDispatchState, RecordingRegistryPauseTicket},
    workflow::{accepted_preflight_reply, PreflightDispatchState, RecordingRegistryWorkflowTicket},
    LeaseError, LeaseRole, RecordingRegistryRoot, RecordingRegistrySession,
};
use crate::recording_operations::{OperationsPhase, RecordingOperationHandle};
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

pub(super) struct ApplyLease {
    pub(super) pause_sequence: u64,
    pub(super) change_ref: String,
    pub(super) operation_id: String,
    pub(super) admission_id: String,
    pub(super) lease_id: String,
    pub(super) registered: Option<RegisteredApply>,
}

#[derive(Clone)]
pub struct RecordingRegistryApplyTicket {
    pub(super) identity: Arc<()>,
    pub(super) sequence: u64,
    pub(super) admission_id: String,
}

impl RecordingRegistryApplyTicket {
    pub fn admission_id(&self) -> &str {
        &self.admission_id
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }
}

pub enum ApplyRegistration {
    Registered(RecordingRegistryApplyTicket),
    Existing(RecordingRegistryApplyTicket),
}

pub(super) struct RegisteredApply {
    pub(super) ticket: RecordingRegistryApplyTicket,
    pub(super) request: RecordingAdmissionRequest,
    pub(super) budget: LifetimeBudget,
    pub(super) state: ApplyDispatchState,
    pub(super) binding: Option<RecordingOperationHandle>,
    #[cfg(test)]
    fault: Option<ApplyDispatchFault>,
}

impl RegisteredApply {
    /// Reads the saved native apply handle; it never starts a native wait task.
    pub(super) fn completion(&self) -> Result<Option<Arc<RecordingOperationResult>>, LeaseError> {
        let Some(binding) = &self.binding else {
            return Ok(None);
        };
        let result = binding.watch().borrow().clone();
        if let Some(value) = &result {
            self.budget
                .check_completion(value.as_value())
                .map_err(|_| LeaseError::Capacity)?;
            let completed_request =
                RecordingOperationRequest::from_value(value.as_value()["request"].clone())
                    .map_err(|_| LeaseError::ProtocolViolation)?;
            if !matches_apply_operation(&self.request, &completed_request)
                || !same_recording_operation_request(&completed_request, binding.request())
            {
                return Err(LeaseError::ProtocolViolation);
            }
        }
        Ok(result)
    }
}

pub(super) enum ApplyDispatchState {
    Registered,
    Calling,
    Finished(RecordingAdmissionReply),
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApplyDispatchFault {
    NativePanicAfterCall,
    ProjectionPanic,
}

impl ApplyLease {
    pub(super) fn is_uncertain(&self) -> bool {
        self.registered
            .as_ref()
            .is_some_and(|record| match &record.state {
                ApplyDispatchState::Calling => true,
                ApplyDispatchState::Finished(reply) => {
                    reply.as_value()["outcome"]["kind"] == "unknown"
                }
                ApplyDispatchState::Registered => false,
            })
    }
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
        if record
            .discard_lease
            .as_ref()
            .is_some_and(|discard| discard.blocks_other(&self.leases, Instant::now()))
        {
            return Err(LeaseError::Busy);
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
            registered: None,
        });
        Ok(reply)
    }
}

impl RecordingRegistryRoot {
    /// Stores the original apply admission and consumes its lease before native dispatch.
    pub fn register_apply(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        pause_ticket: &RecordingRegistryPauseTicket,
        request: RecordingAdmissionRequest,
    ) -> Result<ApplyRegistration, LeaseError> {
        self.register_apply_with_clock(session, workflow, pause_ticket, request, Instant::now)
    }

    #[cfg(test)]
    pub(crate) fn register_apply_at(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        pause_ticket: &RecordingRegistryPauseTicket,
        request: RecordingAdmissionRequest,
        now: Instant,
    ) -> Result<ApplyRegistration, LeaseError> {
        self.register_apply_with_clock(session, workflow, pause_ticket, request, || now)
    }

    fn register_apply_with_clock(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        pause_ticket: &RecordingRegistryPauseTicket,
        request: RecordingAdmissionRequest,
        clock: impl FnOnce() -> Instant,
    ) -> Result<ApplyRegistration, LeaseError> {
        let record = self.workflow_record(session, workflow)?;
        self.registered_pause(session, pause_ticket)?;
        let apply = record
            .apply_lease
            .as_ref()
            .ok_or(LeaseError::InvalidInput)?;
        let value = request.as_value();
        if value["ownerRef"] != self.scope["ownerRef"] || value["action"]["kind"] != "apply" {
            return Err(LeaseError::Forbidden);
        }
        let context = RecordingOperationsContext::from_value(value["context"].clone())
            .map_err(|_| LeaseError::InvalidInput)?;
        if !same_recording_operations_context(&context, self.seed.context()) {
            return Err(LeaseError::Forbidden);
        }
        if apply.pause_sequence != pause_ticket.sequence()
            || value["admissionId"] != apply.admission_id
            || value["action"]["changeRef"] != apply.change_ref
        {
            return Err(LeaseError::ProtocolViolation);
        }
        let operation = RecordingOperationRequest::from_value(value["action"]["operation"].clone())
            .map_err(|_| LeaseError::InvalidInput)?;
        let expected = RecordingOperationRequest::from_value(json!({
            "version":1, "kind":"recordingOperationRequest",
            "operationId":apply.operation_id, "stage":"apply", "change":record.change.as_value()
        }))
        .map_err(|_| LeaseError::InvalidInput)?;
        if !same_recording_operation_request(&operation, &expected) {
            return Err(LeaseError::ProtocolViolation);
        }
        if let Some(existing) = &apply.registered {
            if !same_recording_admission_request(&existing.request, &request) {
                return Err(LeaseError::ProtocolViolation);
            }
            return Ok(ApplyRegistration::Existing(existing.ticket.clone()));
        }
        let lease = self
            .leases
            .get(&apply.lease_id)
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
        let (stage, _) = bounds::stage(&record.change, &self.scope, "apply")
            .map_err(|_| LeaseError::Capacity)?;
        let budget = LifetimeBudget::for_request(&request).map_err(|_| LeaseError::Capacity)?;
        if !stage.storage.covers(budget) {
            return Err(LeaseError::Capacity);
        }
        let sequence = self.sequence.checked_add(1).ok_or(LeaseError::Capacity)?;
        let ticket = RecordingRegistryApplyTicket {
            identity: self.identity.clone(),
            sequence,
            admission_id: apply.admission_id.clone(),
        };
        if clock() >= lease.deadline {
            return Err(LeaseError::Expired);
        }
        let lease_id = apply.lease_id.clone();
        self.sequence = sequence;
        self.leases
            .get_mut(&lease_id)
            .expect("qualified lease")
            .consumed = true;
        self.workflow
            .as_mut()
            .expect("qualified workflow")
            .apply_lease
            .as_mut()
            .expect("qualified apply lease")
            .registered = Some(RegisteredApply {
            ticket: ticket.clone(),
            request,
            budget: stage.storage,
            state: ApplyDispatchState::Registered,
            binding: None,
            #[cfg(test)]
            fault: None,
        });
        Ok(ApplyRegistration::Registered(ticket))
    }

    fn registered_apply(
        &self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryApplyTicket,
    ) -> Result<&RegisteredApply, LeaseError> {
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
        let apply = record
            .apply_lease
            .as_ref()
            .ok_or(LeaseError::InvalidInput)?;
        let registered = apply.registered.as_ref().ok_or(LeaseError::InvalidInput)?;
        if registered.ticket.sequence != ticket.sequence
            || registered.ticket.admission_id != ticket.admission_id
        {
            return Err(LeaseError::ProtocolViolation);
        }
        Ok(registered)
    }

    pub fn apply_reply(
        &self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryApplyTicket,
    ) -> Result<Option<RecordingAdmissionReply>, LeaseError> {
        let registered = self.registered_apply(session, ticket)?;
        Ok(match &registered.state {
            ApplyDispatchState::Finished(reply) => Some(reply.clone()),
            _ => None,
        })
    }

    pub fn apply_completion(
        &self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryApplyTicket,
    ) -> Result<Option<Arc<RecordingOperationResult>>, LeaseError> {
        self.registered_apply(session, ticket)?.completion()
    }

    /// Dispatches the registered apply once and keeps its native handle before reply projection.
    pub fn dispatch_apply(
        &mut self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryApplyTicket,
    ) -> Result<RecordingAdmissionReply, LeaseError> {
        let registered = self.registered_apply(session, ticket)?;
        match &registered.state {
            ApplyDispatchState::Finished(reply) => return Ok(reply.clone()),
            ApplyDispatchState::Calling => return Err(LeaseError::Busy),
            ApplyDispatchState::Registered => {}
        }
        let request = registered.request.clone();
        let budget = registered.budget;
        #[cfg(test)]
        let fault = registered.fault;
        let record = self.workflow.as_ref().expect("qualified workflow");
        let apply = record.apply_lease.as_ref().expect("qualified apply lease");
        let lease_id = apply.lease_id.clone();
        let operation_id = apply.operation_id.clone();
        let change_ref = apply.change_ref.clone();
        let change = record
            .registered
            .as_ref()
            .and_then(|preflight| preflight.binding.as_ref())
            .ok_or(LeaseError::Busy)?
            .change
            .clone();
        let deadline = self.leases[&lease_id].deadline;
        let unknown =
            apply_admission_reply(&request, json!({"kind":"unknown","error":"workerFailure"}));
        budget
            .check_reply(unknown.as_value())
            .map_err(|_| LeaseError::Capacity)?;
        let expired = Instant::now() >= deadline;
        let registered = self
            .workflow
            .as_mut()
            .expect("qualified workflow")
            .apply_lease
            .as_mut()
            .expect("qualified apply lease")
            .registered
            .as_mut()
            .expect("qualified admission");
        if expired {
            let reply = apply_admission_reply(
                &request,
                json!({"kind":"rejected","error":"deadlineExceeded"}),
            );
            budget
                .check_reply(reply.as_value())
                .map_err(|_| LeaseError::Capacity)?;
            registered.state = ApplyDispatchState::Finished(reply.clone());
            return Ok(reply);
        }
        registered.state = ApplyDispatchState::Calling;
        let control = QueryControl {
            cancellation: CancellationToken::default(),
            deadline,
            limits: QueryLimits::default(),
        };
        let result = catch_unwind(AssertUnwindSafe(|| {
            let result = self.seed.client().apply(&change, &operation_id, control);
            #[cfg(test)]
            if fault == Some(ApplyDispatchFault::NativePanicAfterCall) {
                panic!("test apply panic after native call");
            }
            result
        }));
        let registered = self
            .workflow
            .as_mut()
            .expect("qualified workflow")
            .apply_lease
            .as_mut()
            .expect("qualified apply lease")
            .registered
            .as_mut()
            .expect("qualified admission");
        let reply = match result {
            Ok(Ok(binding)) => {
                registered.binding = Some(binding);
                catch_unwind(AssertUnwindSafe(|| {
                    #[cfg(test)]
                    if fault == Some(ApplyDispatchFault::ProjectionPanic) {
                        panic!("test apply projection panic after handle save");
                    }
                    let binding = registered.binding.as_ref().expect("saved apply handle");
                    if !matches_apply_operation(&request, binding.request()) {
                        return None;
                    }
                    let reply = apply_admission_reply(
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
            Ok(Err(rejection)) => apply_admission_reply(
                &request,
                json!({"kind":"rejected","error":rejection.code.as_str()}),
            ),
            Err(_) => unknown.clone(),
        };
        if budget.check_reply(reply.as_value()).is_err() {
            registered.state = ApplyDispatchState::Finished(unknown.clone());
            return Ok(unknown);
        }
        registered.state = ApplyDispatchState::Finished(reply.clone());
        Ok(reply)
    }

    #[cfg(test)]
    pub(crate) fn test_set_apply_dispatch_fault(
        &mut self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryApplyTicket,
        fault: ApplyDispatchFault,
    ) {
        self.registered_apply(session, ticket).unwrap();
        self.workflow
            .as_mut()
            .unwrap()
            .apply_lease
            .as_mut()
            .unwrap()
            .registered
            .as_mut()
            .unwrap()
            .fault = Some(fault);
    }
}

fn apply_admission_reply(
    request: &RecordingAdmissionRequest,
    outcome: serde_json::Value,
) -> RecordingAdmissionReply {
    RecordingAdmissionReply::from_value(json!({
        "version":1, "kind":"recordingAdmissionReply", "request":request.as_value(), "outcome":outcome
    }))
    .expect("validated admission and reserved reply capacity")
}

fn matches_apply_operation(
    admission: &RecordingAdmissionRequest,
    actual: &RecordingOperationRequest,
) -> bool {
    RecordingOperationRequest::from_value(admission.as_value()["action"]["operation"].clone())
        .is_ok_and(|expected| same_recording_operation_request(&expected, actual))
}
