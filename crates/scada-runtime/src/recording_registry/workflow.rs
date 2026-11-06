//! Initial native workflow reservation, preflight registration and one-time dispatch.
use super::{
    kernel::{
        budget::{BudgetError, LifetimeBudget},
        workflow as bounds,
    },
    LeaseError, LeaseRole, RecordingRegistryRoot, RecordingRegistrySession,
};
use crate::recording_operations::{AcceptedRecordingChange, RegistryClaimReason};
use scada_historian::store::query::{CancellationToken, QueryControl, QueryLimits};
use scada_model::recording_admission::{
    same_recording_admission_request, RecordingAdmissionReply, RecordingAdmissionRequest,
};
use scada_model::recording_operations::{
    same_recording_change_request, same_recording_operations_context, RecordingChangeRequest,
    RecordingOperationResult, RecordingOperationsContext,
};
use scada_model::recording_wire::{RecordingWireLeaseReply, RecordingWireLeaseRequest};
use serde_json::json;
use std::{
    collections::BTreeMap,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::Arc,
    time::Instant,
};

#[derive(Clone)]
pub struct RecordingRegistryWorkflowTicket {
    identity: Arc<()>,
    sequence: u64,
    change_id: String,
}

impl RecordingRegistryWorkflowTicket {
    pub fn change_id(&self) -> &str {
        &self.change_id
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }
}

pub(super) struct WorkflowRecord {
    ticket: RecordingRegistryWorkflowTicket,
    change: RecordingChangeRequest,
    principal: String,
    attempts: BTreeMap<String, PreflightAttempt>,
    active_attempt: Option<String>,
    registered: Option<RegisteredPreflight>,
}

impl WorkflowRecord {
    pub(super) fn has_uncertain_dispatch(&self) -> bool {
        self.registered
            .as_ref()
            .is_some_and(|record| record.is_uncertain())
    }
}

struct PreflightAttempt {
    lease_id: String,
}

#[derive(Clone)]
pub struct RecordingRegistryAdmissionTicket {
    identity: Arc<()>,
    sequence: u64,
    admission_id: String,
}

impl RecordingRegistryAdmissionTicket {
    pub fn admission_id(&self) -> &str {
        &self.admission_id
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }
}

struct RegisteredPreflight {
    ticket: RecordingRegistryAdmissionTicket,
    request: RecordingAdmissionRequest,
    budget: LifetimeBudget,
    state: PreflightDispatchState,
    binding: Option<AcceptedRecordingChange>,
    #[cfg(test)]
    fault: Option<TestDispatchFault>,
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum TestDispatchFault {
    NativePanicAfterCall,
    ProjectionPanic,
}

impl RegisteredPreflight {
    fn is_uncertain(&self) -> bool {
        match &self.state {
            PreflightDispatchState::Calling => true,
            PreflightDispatchState::Finished(reply) => {
                reply.as_value()["outcome"]["kind"] == "unknown"
            }
            PreflightDispatchState::Registered => false,
        }
    }
}

enum PreflightDispatchState {
    Registered,
    Calling,
    Finished(RecordingAdmissionReply),
}

pub enum PreflightRegistration {
    Registered(RecordingRegistryAdmissionTicket),
    Existing(RecordingRegistryAdmissionTicket),
}

impl RecordingRegistryRoot {
    fn workflow_record(
        &self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryWorkflowTicket,
    ) -> Result<&WorkflowRecord, LeaseError> {
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
        if record.ticket.sequence != ticket.sequence || record.ticket.change_id != ticket.change_id
        {
            return Err(LeaseError::ProtocolViolation);
        }
        Ok(record)
    }

    /// Reserves four stage envelopes before any mutation lease or native call is issued.
    pub fn reserve_workflow(
        &mut self,
        session: &RecordingRegistrySession,
        change: RecordingChangeRequest,
    ) -> Result<RecordingRegistryWorkflowTicket, LeaseError> {
        if self.closed {
            return Err(LeaseError::Closed);
        }
        if !Arc::ptr_eq(&self.identity, &session.root_identity)
            || session.scope != self.scope
            || session.role != LeaseRole::Mutation
        {
            return Err(LeaseError::Forbidden);
        }
        let context = RecordingOperationsContext::from_value(change.as_value()["context"].clone())
            .map_err(|_| LeaseError::InvalidInput)?;
        if !same_recording_operations_context(&context, self.seed.context()) {
            return Err(LeaseError::Forbidden);
        }
        let id = change.as_value()["changeId"]
            .as_str()
            .expect("validated change ID");
        if let Some(record) = &self.workflow {
            if record.principal != session.principal {
                return Err(LeaseError::Forbidden);
            }
            if record.ticket.change_id != id {
                return Err(LeaseError::Busy);
            }
            if !Arc::ptr_eq(&record.ticket.identity, &self.identity)
                || !same_recording_change_request(&record.change, &change)
            {
                return Err(LeaseError::ProtocolViolation);
            }
            return Ok(record.ticket.clone());
        }
        if self.has_mutation_lease() {
            return Err(LeaseError::Busy);
        }
        match self.seed.initial_workflow_eligible() {
            Ok(true) => {}
            Ok(false) => return Err(LeaseError::Forbidden),
            Err(RegistryClaimReason::Busy) => return Err(LeaseError::Busy),
            Err(_) => return Err(LeaseError::Forbidden),
        }
        let budget = bounds::workflow(&change, &self.scope).map_err(|error| match error {
            super::kernel::budget::BudgetError::InvalidInput => LeaseError::InvalidInput,
            super::kernel::budget::BudgetError::Capacity => LeaseError::Capacity,
        })?;
        let bytes = self
            .mutation_bytes
            .checked_add(budget.total_bytes)
            .ok_or(LeaseError::Capacity)?;
        if bytes > self.mutation_byte_limit {
            return Err(LeaseError::Capacity);
        }
        let sequence = self.sequence.checked_add(1).ok_or(LeaseError::Capacity)?;
        let ticket = RecordingRegistryWorkflowTicket {
            identity: self.identity.clone(),
            sequence,
            change_id: id.to_owned(),
        };
        self.sequence = sequence;
        self.mutation_bytes = bytes;
        self.reserved_revisions = 11;
        self.workflow = Some(WorkflowRecord {
            ticket: ticket.clone(),
            change,
            principal: session.principal.clone(),
            attempts: BTreeMap::new(),
            active_attempt: None,
            registered: None,
        });
        Ok(ticket)
    }

    /// Issues a prepaid lease for the initial preflight or an explicit expired retry.
    pub fn issue_preflight_lease(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        request: RecordingWireLeaseRequest,
    ) -> Result<RecordingWireLeaseReply, LeaseError> {
        self.issue_preflight_lease_inner(session, workflow, request, Instant::now())
    }

    #[cfg(test)]
    pub(crate) fn issue_preflight_lease_at(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        request: RecordingWireLeaseRequest,
        now: Instant,
    ) -> Result<RecordingWireLeaseReply, LeaseError> {
        self.issue_preflight_lease_inner(session, workflow, request, now)
    }

    fn issue_preflight_lease_inner(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        request: RecordingWireLeaseRequest,
        now: Instant,
    ) -> Result<RecordingWireLeaseReply, LeaseError> {
        let record = self.workflow_record(session, workflow)?;
        let value = request.as_value();
        if value["role"] != "mutation" {
            return Err(LeaseError::Forbidden);
        }
        let admission_id = value["admissionId"]
            .as_str()
            .expect("validated ID")
            .to_owned();
        let lease_id = value["leaseRequestId"]
            .as_str()
            .expect("validated ID")
            .to_owned();
        let (stage, _) =
            bounds::stage(&record.change, &self.scope, "preflight").map_err(map_budget_error)?;
        if let Some(existing) = record.attempts.get(&admission_id) {
            if existing.lease_id != lease_id {
                return Err(LeaseError::ProtocolViolation);
            }
            return self.issue_prepaid_lease_at(session, request, now, stage.lease_bytes);
        }
        if record.registered.is_some() {
            return Err(LeaseError::Busy);
        }
        if let Some(active_id) = &record.active_attempt {
            let active = record.attempts.get(active_id).expect("active attempt");
            if self.leases[&active.lease_id].deadline > now {
                return Err(LeaseError::Busy);
            }
        }
        let retry = !record.attempts.is_empty();
        if self
            .leases
            .values()
            .filter(|lease| lease.role == LeaseRole::Mutation)
            .count()
            .checked_add(4)
            .is_none_or(|count| count > self.mutation_lease_limit)
            || record
                .attempts
                .len()
                .checked_add(4)
                .is_none_or(|count| count > 4096)
        {
            return Err(LeaseError::Capacity);
        }
        let extra_bytes = if retry {
            stage.bytes().map_err(map_budget_error)?
        } else {
            0
        };
        let next_bytes = self
            .mutation_bytes
            .checked_add(extra_bytes)
            .ok_or(LeaseError::Capacity)?;
        let next_revisions = self
            .reserved_revisions
            .checked_add(if retry { 3 } else { 0 })
            .ok_or(LeaseError::Capacity)?;
        if next_bytes > self.mutation_byte_limit || next_revisions > 9_007_199_254_740_991 {
            return Err(LeaseError::Capacity);
        }
        let reply = self.issue_prepaid_lease_at(session, request, now, stage.lease_bytes)?;
        self.mutation_bytes = next_bytes;
        self.reserved_revisions = next_revisions;
        let record = self.workflow.as_mut().expect("qualified workflow");
        record
            .attempts
            .insert(admission_id.clone(), PreflightAttempt { lease_id });
        record.active_attempt = Some(admission_id);
        Ok(reply)
    }

    /// Registers immutable original input and consumes its lease without native dispatch.
    pub fn register_preflight(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        request: RecordingAdmissionRequest,
    ) -> Result<PreflightRegistration, LeaseError> {
        self.register_preflight_with_clock(session, workflow, request, Instant::now)
    }

    #[cfg(test)]
    pub(crate) fn register_preflight_at(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        request: RecordingAdmissionRequest,
        now: Instant,
    ) -> Result<PreflightRegistration, LeaseError> {
        self.register_preflight_with_clock(session, workflow, request, || now)
    }

    #[cfg(test)]
    pub(crate) fn test_register_preflight_with_clock(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        request: RecordingAdmissionRequest,
        clock: impl FnOnce() -> Instant,
    ) -> Result<PreflightRegistration, LeaseError> {
        self.register_preflight_with_clock(session, workflow, request, clock)
    }

    fn register_preflight_with_clock(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        request: RecordingAdmissionRequest,
        clock: impl FnOnce() -> Instant,
    ) -> Result<PreflightRegistration, LeaseError> {
        let record = self.workflow_record(session, workflow)?;
        let value = request.as_value();
        let admission_id = value["admissionId"].as_str().expect("validated ID");
        if let Some(existing) = &record.registered {
            if existing.ticket.admission_id != admission_id {
                return Err(LeaseError::Busy);
            }
            if !same_recording_admission_request(&existing.request, &request) {
                return Err(LeaseError::ProtocolViolation);
            }
            if !Arc::ptr_eq(&existing.ticket.identity, &self.identity) {
                return Err(LeaseError::Forbidden);
            }
            return Ok(PreflightRegistration::Existing(existing.ticket.clone()));
        }
        if value["ownerRef"] != self.scope["ownerRef"] || value["action"]["kind"] != "preflight" {
            return Err(LeaseError::Forbidden);
        }
        let context = RecordingOperationsContext::from_value(value["context"].clone())
            .map_err(|_| LeaseError::InvalidInput)?;
        if !same_recording_operations_context(&context, self.seed.context()) {
            return Err(LeaseError::Forbidden);
        }
        let actual_change = RecordingChangeRequest::from_value(value["action"]["change"].clone())
            .map_err(|_| LeaseError::InvalidInput)?;
        if !same_recording_change_request(&record.change, &actual_change) {
            return Err(LeaseError::ProtocolViolation);
        }
        let attempt = record
            .attempts
            .get(admission_id)
            .ok_or(LeaseError::InvalidInput)?;
        let lease = &self.leases[&attempt.lease_id];
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
        let (stage, _) =
            bounds::stage(&record.change, &self.scope, "preflight").map_err(map_budget_error)?;
        let actual_budget = LifetimeBudget::for_request(&request).map_err(map_budget_error)?;
        if !stage.storage.covers(actual_budget) {
            return Err(LeaseError::Capacity);
        }
        if record.active_attempt.as_deref() != Some(admission_id) {
            return Err(LeaseError::Busy);
        }
        let lease_id = attempt.lease_id.clone();
        let sequence = self.sequence.checked_add(1).ok_or(LeaseError::Capacity)?;
        let ticket = RecordingRegistryAdmissionTicket {
            identity: self.identity.clone(),
            sequence,
            admission_id: admission_id.to_owned(),
        };
        // Read the real clock after every fallible preparation, immediately before the commit.
        if clock() >= lease.deadline {
            return Err(LeaseError::Expired);
        }
        self.sequence = sequence;
        self.leases
            .get_mut(&lease_id)
            .expect("qualified lease")
            .consumed = true;
        self.workflow
            .as_mut()
            .expect("qualified workflow")
            .registered = Some(RegisteredPreflight {
            ticket: ticket.clone(),
            request,
            budget: stage.storage,
            state: PreflightDispatchState::Registered,
            binding: None,
            #[cfg(test)]
            fault: None,
        });
        Ok(PreflightRegistration::Registered(ticket))
    }

    fn registered_preflight(
        &self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryAdmissionTicket,
    ) -> Result<&RegisteredPreflight, LeaseError> {
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
        let registered = record.registered.as_ref().ok_or(LeaseError::InvalidInput)?;
        if registered.ticket.sequence != ticket.sequence
            || registered.ticket.admission_id != ticket.admission_id
        {
            return Err(LeaseError::ProtocolViolation);
        }
        Ok(registered)
    }

    /// Reads the immutable original dispatcher reply, including after caller delivery loss.
    pub fn preflight_reply(
        &self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryAdmissionTicket,
    ) -> Result<Option<RecordingAdmissionReply>, LeaseError> {
        let registered = self.registered_preflight(session, ticket)?;
        Ok(match &registered.state {
            PreflightDispatchState::Finished(reply) => Some(reply.clone()),
            _ => None,
        })
    }

    /// Reads native completion only from the handle returned by this admission.
    pub fn preflight_completion(
        &self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryAdmissionTicket,
    ) -> Result<Option<Arc<RecordingOperationResult>>, LeaseError> {
        let registered = self.registered_preflight(session, ticket)?;
        let Some(binding) = &registered.binding else {
            return Ok(None);
        };
        let receiver = binding.operation.watch();
        let result = receiver.borrow().clone();
        if let Some(value) = &result {
            registered
                .budget
                .check_completion(value.as_value())
                .map_err(map_budget_error)?;
        }
        Ok(result)
    }

    #[cfg(test)]
    pub(crate) fn test_set_dispatch_fault(
        &mut self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryAdmissionTicket,
        fault: TestDispatchFault,
    ) {
        self.registered_preflight(session, ticket).unwrap();
        self.workflow
            .as_mut()
            .unwrap()
            .registered
            .as_mut()
            .unwrap()
            .fault = Some(fault);
    }

    /// Calls the registered native preflight at most once, preserving the real handle and reply.
    pub fn dispatch_preflight(
        &mut self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryAdmissionTicket,
    ) -> Result<RecordingAdmissionReply, LeaseError> {
        let registered = self.registered_preflight(session, ticket)?;
        match &registered.state {
            PreflightDispatchState::Finished(reply) => return Ok(reply.clone()),
            PreflightDispatchState::Calling => return Err(LeaseError::Busy),
            PreflightDispatchState::Registered => {}
        }
        let request = registered.request.clone();
        let budget = registered.budget;
        #[cfg(test)]
        let fault = registered.fault;
        let change = self
            .workflow
            .as_ref()
            .expect("qualified workflow")
            .change
            .clone();
        let lease_id = self.workflow.as_ref().expect("qualified workflow").attempts
            [&ticket.admission_id]
            .lease_id
            .clone();
        let deadline = self.leases[&lease_id].deadline;
        let unknown = admission_reply(&request, json!({"kind":"unknown","error":"workerFailure"}));
        budget
            .check_reply(unknown.as_value())
            .map_err(map_budget_error)?;
        let expired = Instant::now() >= deadline;
        let registered = self
            .workflow
            .as_mut()
            .expect("qualified workflow")
            .registered
            .as_mut()
            .expect("qualified admission");
        if expired {
            let reply = admission_reply(
                &request,
                json!({"kind":"rejected","error":"deadlineExceeded"}),
            );
            budget
                .check_reply(reply.as_value())
                .map_err(map_budget_error)?;
            registered.state = PreflightDispatchState::Finished(reply.clone());
            return Ok(reply);
        }
        registered.state = PreflightDispatchState::Calling;
        let control = QueryControl {
            cancellation: CancellationToken::default(),
            deadline,
            limits: QueryLimits::default(),
        };
        let result = catch_unwind(AssertUnwindSafe(|| {
            let result = self.seed.client().preflight(change, control);
            #[cfg(test)]
            if fault == Some(TestDispatchFault::NativePanicAfterCall) {
                panic!("test native panic after call");
            }
            result
        }));
        let registered = self
            .workflow
            .as_mut()
            .expect("qualified workflow")
            .registered
            .as_mut()
            .expect("qualified admission");
        let reply = match result {
            Ok(Ok(binding)) => {
                registered.binding = Some(binding);
                catch_unwind(AssertUnwindSafe(|| {
                    #[cfg(test)]
                    if fault == Some(TestDispatchFault::ProjectionPanic) {
                        panic!("test projection panic after handle save");
                    }
                    let operation = registered.binding.as_ref().expect("saved binding")
                        .operation.request().as_value();
                    let outcome = json!({"kind":"accepted", "handle":{
                        "kind":"operation", "changeRef":format!("native-change:{}", ticket.sequence),
                        "operationRef":operation["operationId"], "request":operation
                    }});
                    let reply = RecordingAdmissionReply::from_value(json!({
                        "version":1, "kind":"recordingAdmissionReply",
                        "request":request.as_value(), "outcome":outcome
                    })).ok()?;
                    registered.budget.check_reply(reply.as_value()).ok()?;
                    Some(reply)
                })).ok().flatten().unwrap_or_else(|| unknown.clone())
            }
            Ok(Err(rejection)) => admission_reply(
                &request,
                json!({"kind":"rejected","error":rejection.code.as_str()}),
            ),
            Err(_) => unknown.clone(),
        };
        if registered.budget.check_reply(reply.as_value()).is_err() {
            registered.state = PreflightDispatchState::Finished(unknown.clone());
            return Ok(unknown);
        }
        registered.state = PreflightDispatchState::Finished(reply.clone());
        Ok(reply)
    }
}

fn admission_reply(
    request: &RecordingAdmissionRequest,
    outcome: serde_json::Value,
) -> RecordingAdmissionReply {
    RecordingAdmissionReply::from_value(json!({
        "version":1, "kind":"recordingAdmissionReply",
        "request":request.as_value(), "outcome":outcome
    }))
    .expect("validated admission and reserved reply capacity")
}

fn map_budget_error(error: BudgetError) -> LeaseError {
    match error {
        BudgetError::InvalidInput => LeaseError::InvalidInput,
        BudgetError::Capacity => LeaseError::Capacity,
    }
}
