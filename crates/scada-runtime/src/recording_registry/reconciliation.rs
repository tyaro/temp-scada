//! Explicit receipt reads bound to the saved original apply handle. Each retry needs its own
//! read lease and admission, and starts only after every earlier read has settled.
use super::{
    apply::RecordingRegistryApplyTicket,
    kernel::{
        budget::{LifetimeBudget, READ_ID_BYTES},
        workflow::{check_snapshot, max_bound},
    },
    lease::same_scope,
    subscription::{AdmissionEntry, AdmissionStage},
    workflow::RecordingRegistryWorkflowTicket,
    LeaseError, LeaseRole, RecordingRegistryRoot, RecordingRegistrySession,
};
use crate::recording_operations::{OwnerError, RecordingReconciliationHandle};
use scada_historian::store::query::{CancellationToken, QueryControl, QueryLimits};
use scada_model::recording_admission::{
    same_recording_admission_request, RecordingAdmissionReply, RecordingAdmissionRequest,
    RecordingReconciliationDelivery,
};
use scada_model::recording_operations::{
    same_recording_operation_request, same_recording_operations_context,
    same_recording_reconciliation_request, RecordingOperationRequest, RecordingOperationsContext,
    RecordingReconciliationRequest,
};
use serde_json::json;
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::Arc,
    time::Instant,
};

#[derive(Clone)]
pub struct RecordingRegistryReconciliationTicket {
    identity: Arc<()>,
    sequence: u64,
    admission_id: String,
}

impl RecordingRegistryReconciliationTicket {
    pub fn admission_id(&self) -> &str {
        &self.admission_id
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }
}

pub enum ReconciliationRegistration {
    Registered(RecordingRegistryReconciliationTicket),
    Existing(RecordingRegistryReconciliationTicket),
}

pub(super) struct RegisteredReconciliation {
    ticket: RecordingRegistryReconciliationTicket,
    request: RecordingAdmissionRequest,
    budget: LifetimeBudget,
    lease_id: String,
    pub(super) read_ref: String,
    state: DispatchState,
    pub(super) binding: Option<RecordingReconciliationHandle>,
}

enum DispatchState {
    Registered,
    Calling,
    Finished(RecordingAdmissionReply),
}

impl RegisteredReconciliation {
    /// Settles a never-dispatched read at shutdown; native is never called.
    pub(super) fn cancel_undispatched(&mut self) {
        if matches!(self.state, DispatchState::Registered) {
            let reply = admission_reply(&self.request, super::workflow::shutdown_rejection());
            if self.budget.check_reply(reply.as_value()).is_ok() {
                self.state = DispatchState::Finished(reply);
            }
        }
    }

    pub(super) fn ticket_sequence(&self) -> u64 {
        self.ticket.sequence
    }

    /// Reads only the saved read handle; this never alters the original apply result.
    pub(super) fn delivery(
        &self,
        owner_ref: &serde_json::Value,
    ) -> Result<Option<RecordingReconciliationDelivery>, LeaseError> {
        let binding = match &self.binding {
            Some(binding) => binding,
            None => return Ok(None),
        };
        let expected = RecordingReconciliationRequest::from_value(
            self.request.as_value()["action"]["reconciliation"].clone(),
        )
        .map_err(|_| LeaseError::ProtocolViolation)?;
        if !same_recording_reconciliation_request(binding.request(), &expected) {
            return Err(LeaseError::ProtocolViolation);
        }
        let completion = match binding.watch().borrow().clone() {
            Some(completion) => completion,
            None => return Ok(None),
        };
        let outcome = match completion {
            Ok(result) => {
                self.budget
                    .check_completion(result.as_value())
                    .map_err(|_| LeaseError::Capacity)?;
                let result_request = RecordingReconciliationRequest::from_value(
                    result.as_value()["request"].clone(),
                )
                .map_err(|_| LeaseError::ProtocolViolation)?;
                if !same_recording_reconciliation_request(&result_request, binding.request()) {
                    return Err(LeaseError::ProtocolViolation);
                }
                json!({"kind":"result","result":result.as_value()})
            }
            Err(error) => json!({"kind":"readUncertain","error":
                if error == OwnerError::Unavailable { "workerFailure" } else { "internal" }}),
        };
        let delivery = RecordingReconciliationDelivery::from_value(json!({
            "version":1,"kind":"recordingReconciliationDelivery",
            "ownerRef":owner_ref, "readRef":self.read_ref,
            "request":binding.request().as_value(), "outcome":outcome,
        }))
        .map_err(|_| LeaseError::ProtocolViolation)?;
        self.budget
            .check_completion(delivery.as_value())
            .map_err(|_| LeaseError::Capacity)?;
        Ok(Some(delivery))
    }

    fn is_settled(&self) -> bool {
        match &self.state {
            DispatchState::Finished(reply) => match reply.as_value()["outcome"]["kind"].as_str() {
                Some("accepted") => self
                    .binding
                    .as_ref()
                    .is_some_and(|binding| binding.watch().borrow().is_some()),
                Some("rejected") => true,
                _ => false,
            },
            _ => false,
        }
    }

    pub(super) fn admission_entry(&self) -> AdmissionEntry<'_> {
        AdmissionEntry {
            stage: AdmissionStage::Reconciliation,
            sequence: self.ticket.sequence,
            request: &self.request,
            reply: match &self.state {
                DispatchState::Finished(reply) => Some(reply),
                _ => None,
            },
            knowledge: None,
        }
    }

    pub(super) fn is_uncertain(&self) -> bool {
        matches!(self.state, DispatchState::Calling)
            || matches!(&self.state, DispatchState::Finished(reply)
                if reply.as_value()["outcome"]["kind"] == "unknown")
    }
}

impl RecordingRegistryRoot {
    /// Consumes a read lease only for the completed original apply and its saved native handle.
    pub fn register_reconciliation(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        apply_ticket: &RecordingRegistryApplyTicket,
        request: RecordingAdmissionRequest,
    ) -> Result<ReconciliationRegistration, LeaseError> {
        self.register_reconciliation_with_clock(
            session,
            workflow,
            apply_ticket,
            request,
            Instant::now,
        )
    }

    #[cfg(test)]
    pub(crate) fn register_reconciliation_at(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        apply_ticket: &RecordingRegistryApplyTicket,
        request: RecordingAdmissionRequest,
        now: Instant,
    ) -> Result<ReconciliationRegistration, LeaseError> {
        self.register_reconciliation_with_clock(session, workflow, apply_ticket, request, || now)
    }

    fn register_reconciliation_with_clock(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        apply_ticket: &RecordingRegistryApplyTicket,
        request: RecordingAdmissionRequest,
        clock: impl FnOnce() -> Instant,
    ) -> Result<ReconciliationRegistration, LeaseError> {
        if self.closed {
            return Err(LeaseError::Closed);
        }
        if !Arc::ptr_eq(&self.identity, &session.root_identity)
            || !Arc::ptr_eq(&self.identity, &workflow.identity)
            || !Arc::ptr_eq(&self.identity, &apply_ticket.identity)
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
        let apply = record
            .apply_lease
            .as_ref()
            .ok_or(LeaseError::InvalidInput)?;
        let original = apply.registered.as_ref().ok_or(LeaseError::InvalidInput)?;
        if original.ticket.sequence() != apply_ticket.sequence()
            || original.ticket.admission_id() != apply_ticket.admission_id()
        {
            return Err(LeaseError::ProtocolViolation);
        }
        let value = request.as_value();
        if value["ownerRef"] != self.scope["ownerRef"] || value["action"]["kind"] != "reconcile" {
            return Err(LeaseError::Forbidden);
        }
        let context = RecordingOperationsContext::from_value(value["context"].clone())
            .map_err(|_| LeaseError::InvalidInput)?;
        if !same_recording_operations_context(&context, self.seed.context()) {
            return Err(LeaseError::Forbidden);
        }
        let source = &original.request.as_value()["action"];
        let operation = RecordingOperationRequest::from_value(
            value["action"]["reconciliation"]["operation"].clone(),
        )
        .map_err(|_| LeaseError::InvalidInput)?;
        let expected = RecordingOperationRequest::from_value(source["operation"].clone())
            .map_err(|_| LeaseError::ProtocolViolation)?;
        if value["action"]["changeRef"] != apply.change_ref
            || value["action"]["operationRef"] != apply.operation_id
            || !same_recording_operation_request(&operation, &expected)
        {
            return Err(LeaseError::ProtocolViolation);
        }
        if let Some(existing) = self
            .reconciliations
            .iter()
            .find(|read| read.ticket.admission_id == value["admissionId"])
        {
            if !same_recording_admission_request(&existing.request, &request) {
                return Err(LeaseError::ProtocolViolation);
            }
            return Ok(ReconciliationRegistration::Existing(
                existing.ticket.clone(),
            ));
        }
        if self.shutdown {
            return Err(LeaseError::Closed);
        }
        // A retry starts only after every earlier read has a fixed, certain reply and, when
        // accepted, a native completion. An `unknown` reply is never retried past.
        if !self
            .reconciliations
            .iter()
            .all(RegisteredReconciliation::is_settled)
        {
            return Err(LeaseError::Busy);
        }
        let binding = original.binding.as_ref().ok_or(LeaseError::Busy)?;
        if !same_recording_operation_request(binding.request(), &expected) {
            return Err(LeaseError::ProtocolViolation);
        }
        let completion = binding.watch().borrow().clone().ok_or(LeaseError::Busy)?;
        original
            .budget
            .check_completion(completion.as_value())
            .map_err(|_| LeaseError::Capacity)?;
        let completed = completion.as_value();
        let completed_request = RecordingOperationRequest::from_value(completed["request"].clone())
            .map_err(|_| LeaseError::ProtocolViolation)?;
        if !same_recording_operation_request(&completed_request, binding.request()) {
            return Err(LeaseError::ProtocolViolation);
        }
        if !self.seed.client().registry_reconciliation_eligible(binding) {
            return Err(LeaseError::Busy);
        }
        let reconciliation =
            RecordingReconciliationRequest::from_value(value["action"]["reconciliation"].clone())
                .map_err(|_| LeaseError::InvalidInput)?;
        if !same_recording_operation_request(
            &RecordingOperationRequest::from_value(reconciliation.as_value()["operation"].clone())
                .map_err(|_| LeaseError::InvalidInput)?,
            binding.request(),
        ) {
            return Err(LeaseError::ProtocolViolation);
        }
        let lease = self
            .leases
            .values()
            .find(|lease| lease.request.as_value()["admissionId"] == value["admissionId"])
            .ok_or(LeaseError::InvalidInput)?;
        if lease.workflow_owned
            || lease.principal != session.principal
            || lease.role != LeaseRole::Reconciliation
            || !same_scope(&self.scope, &lease.request.as_value()["scope"])
        {
            return Err(LeaseError::Forbidden);
        }
        if lease.reply.as_value()["outcome"]["deadlineLeaseRef"] != value["deadlineLeaseRef"] {
            return Err(LeaseError::ProtocolViolation);
        }
        if lease.consumed {
            return Err(LeaseError::ProtocolViolation);
        }
        let budget = LifetimeBudget::for_request(&request).map_err(|_| LeaseError::Capacity)?;
        let bytes = budget
            .bytes()
            .map_err(|_| LeaseError::Capacity)?
            .checked_add(READ_ID_BYTES)
            .ok_or(LeaseError::Capacity)?;
        let next_bytes = self
            .read_bytes
            .checked_add(bytes)
            .ok_or(LeaseError::Capacity)?;
        if next_bytes > self.read_byte_limit {
            return Err(LeaseError::Capacity);
        }
        // Every read admission may become the snapshot head; reserve its slots before commit.
        let read_admission = max_bound(self.projection_read_admission, budget.reply);
        let read_completion = max_bound(self.projection_read, budget.completion);
        check_snapshot(
            &self.scope,
            max_bound(record.projection_admission, read_admission),
            record.projection_operation,
            read_completion,
        )
        .map_err(|_| LeaseError::Capacity)?;
        let sequence = self.sequence.checked_add(1).ok_or(LeaseError::Capacity)?;
        let unknown = admission_reply(&request, json!({"kind":"unknown","error":"workerFailure"}));
        budget
            .check_reply(unknown.as_value())
            .map_err(|_| LeaseError::Capacity)?;
        if clock() >= lease.deadline {
            return Err(LeaseError::Expired);
        }
        let lease_id = lease.request.as_value()["leaseRequestId"]
            .as_str()
            .expect("validated lease ID")
            .to_owned();
        let ticket = RecordingRegistryReconciliationTicket {
            identity: self.identity.clone(),
            sequence,
            admission_id: value["admissionId"]
                .as_str()
                .expect("validated ID")
                .to_owned(),
        };
        self.sequence = sequence;
        self.read_bytes = next_bytes;
        self.projection_read_admission = read_admission;
        self.projection_read = read_completion;
        self.leases
            .get_mut(&lease_id)
            .expect("qualified lease")
            .consumed = true;
        self.reconciliations.push(RegisteredReconciliation {
            ticket: ticket.clone(),
            request,
            budget,
            lease_id,
            read_ref: format!("native-read:{sequence}"),
            state: DispatchState::Registered,
            binding: None,
        });
        Ok(ReconciliationRegistration::Registered(ticket))
    }

    fn registered_reconciliation(
        &self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryReconciliationTicket,
    ) -> Result<&RegisteredReconciliation, LeaseError> {
        if self.closed {
            return Err(LeaseError::Closed);
        }
        if !Arc::ptr_eq(&self.identity, &session.root_identity)
            || !Arc::ptr_eq(&self.identity, &ticket.identity)
            || session.scope != self.scope
            || session.role != LeaseRole::Reconciliation
        {
            return Err(LeaseError::Forbidden);
        }
        let workflow = self.workflow.as_ref().ok_or(LeaseError::InvalidInput)?;
        if workflow.principal != session.principal {
            return Err(LeaseError::Forbidden);
        }
        if self.reconciliations.is_empty() {
            return Err(LeaseError::InvalidInput);
        }
        self.reconciliations
            .iter()
            .find(|record| {
                record.ticket.sequence == ticket.sequence
                    && record.ticket.admission_id == ticket.admission_id
            })
            .ok_or(LeaseError::ProtocolViolation)
    }

    pub fn reconciliation_reply(
        &self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryReconciliationTicket,
    ) -> Result<Option<RecordingAdmissionReply>, LeaseError> {
        let record = self.registered_reconciliation(session, ticket)?;
        Ok(match &record.state {
            DispatchState::Finished(reply) => Some(reply.clone()),
            _ => None,
        })
    }

    /// Reads only the stored read handle; this never alters the original apply result.
    pub fn reconciliation_delivery(
        &self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryReconciliationTicket,
    ) -> Result<Option<RecordingReconciliationDelivery>, LeaseError> {
        let owner_ref = self.scope["ownerRef"].clone();
        self.registered_reconciliation(session, ticket)?
            .delivery(&owner_ref)
    }

    /// Saves the native read handle before projecting the accepted reply. Repeats return the first reply.
    pub fn dispatch_reconciliation(
        &mut self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryReconciliationTicket,
    ) -> Result<RecordingAdmissionReply, LeaseError> {
        let record = self.registered_reconciliation(session, ticket)?;
        match &record.state {
            DispatchState::Finished(reply) => return Ok(reply.clone()),
            DispatchState::Calling => return Err(LeaseError::Busy),
            DispatchState::Registered if self.shutdown => return Err(LeaseError::Closed),
            DispatchState::Registered => {}
        }
        let request = record.request.clone();
        let budget = record.budget;
        let lease_id = record.lease_id.clone();
        let deadline = self.leases[&lease_id].deadline;
        let workflow = self.workflow.as_ref().expect("qualified workflow");
        let change = workflow
            .registered
            .as_ref()
            .and_then(|registered| registered.binding.as_ref())
            .ok_or(LeaseError::Busy)?
            .change
            .clone();
        let original = workflow
            .apply_lease
            .as_ref()
            .and_then(|apply| apply.registered.as_ref())
            .and_then(|registered| registered.binding.as_ref())
            .ok_or(LeaseError::Busy)?
            .clone();
        let unknown = admission_reply(&request, json!({"kind":"unknown","error":"workerFailure"}));
        budget
            .check_reply(unknown.as_value())
            .map_err(|_| LeaseError::Capacity)?;
        if Instant::now() >= deadline {
            let reply = admission_reply(
                &request,
                json!({"kind":"rejected","error":"deadlineExceeded"}),
            );
            budget
                .check_reply(reply.as_value())
                .map_err(|_| LeaseError::Capacity)?;
            self.reconciliation_mut(ticket.sequence).state = DispatchState::Finished(reply.clone());
            return Ok(reply);
        }
        self.reconciliation_mut(ticket.sequence).state = DispatchState::Calling;
        let control = QueryControl {
            cancellation: CancellationToken::default(),
            deadline,
            limits: QueryLimits::default(),
        };
        let id = request.as_value()["action"]["reconciliation"]["reconciliationId"]
            .as_str()
            .expect("validated ID");
        let result = catch_unwind(AssertUnwindSafe(|| {
            self.seed
                .client()
                .reconcile(&change, &original, id, control)
        }));
        let record = self.reconciliation_mut(ticket.sequence);
        let reply = match result {
            Ok(Ok(binding)) => {
                record.binding = Some(binding);
                catch_unwind(AssertUnwindSafe(|| {
                    let binding = record.binding.as_ref().expect("saved read handle");
                    let expected = RecordingReconciliationRequest::from_value(
                        request.as_value()["action"]["reconciliation"].clone(),
                    )
                    .ok()?;
                    if !same_recording_reconciliation_request(binding.request(), &expected) {
                        return None;
                    }
                    let reply = admission_reply(
                        &request,
                        json!({"kind":"accepted","handle":{
                            "kind":"reconciliation", "readRef":record.read_ref,
                            "request":binding.request().as_value(),
                        }}),
                    );
                    budget.check_reply(reply.as_value()).ok()?;
                    Some(reply)
                }))
                .ok()
                .flatten()
                .unwrap_or_else(|| unknown.clone())
            }
            Ok(Err(rejection)) => admission_reply(
                &request,
                json!({"kind":"rejected","error":rejection.code.as_str()}),
            ),
            Err(_) => unknown.clone(),
        };
        record.state = DispatchState::Finished(if budget.check_reply(reply.as_value()).is_ok() {
            reply.clone()
        } else {
            unknown.clone()
        });
        Ok(match &record.state {
            DispatchState::Finished(reply) => reply.clone(),
            _ => unreachable!(),
        })
    }
}

impl RecordingRegistryRoot {
    fn reconciliation_mut(&mut self, sequence: u64) -> &mut RegisteredReconciliation {
        self.reconciliations
            .iter_mut()
            .find(|record| record.ticket.sequence == sequence)
            .expect("registered read")
    }

    /// Resolves a read ref to its registration; refs are unique per root.
    pub(super) fn reconciliation_by_ref(
        &self,
        read_ref: &str,
    ) -> Option<&RegisteredReconciliation> {
        self.reconciliations
            .iter()
            .find(|record| record.read_ref == read_ref)
    }

    pub(super) fn reconciliation_by_sequence(
        &self,
        sequence: u64,
    ) -> Option<&RegisteredReconciliation> {
        self.reconciliations
            .iter()
            .find(|record| record.ticket.sequence == sequence)
    }
}

fn admission_reply(
    request: &RecordingAdmissionRequest,
    outcome: serde_json::Value,
) -> RecordingAdmissionReply {
    RecordingAdmissionReply::from_value(json!({
        "version":1,"kind":"recordingAdmissionReply","request":request.as_value(),"outcome":outcome
    }))
    .expect("validated request and bounded reply")
}
