//! First explicit discard for the current native Candidate or Paused workflow.
use super::{
    apply::{ApplyDispatchState, ApplyLease},
    kernel::{budget::LifetimeBudget, workflow as bounds},
    lease::{same_scope, LeaseRecord},
    pause::{PauseDispatchState, PauseLease},
    subscription::{AdmissionEntry, AdmissionStage},
    workflow::{
        accepted_preflight_reply, PreflightDispatchState, RecordingRegistryAdmissionTicket,
        RecordingRegistryWorkflowTicket,
    },
    LeaseError, LeaseRole, RecordingRegistryRoot, RecordingRegistrySession,
};
use crate::recording_operations::OperationsPhase;
use scada_model::recording_admission::{
    same_recording_admission_request, RecordingAdmissionReply, RecordingAdmissionRequest,
};
use scada_model::recording_operations::{
    same_recording_change_request, same_recording_operation_request,
    same_recording_operations_context, RecordingChangeRequest, RecordingOperationRequest,
    RecordingOperationsContext,
};
use scada_model::recording_wire::{RecordingWireLeaseReply, RecordingWireLeaseRequest};
use serde_json::json;
use std::{
    collections::BTreeMap,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::Arc,
    time::Instant,
};

pub(super) struct DiscardLease {
    preflight_sequence: u64,
    change_ref: String,
    admission_id: String,
    lease_id: String,
    /// Earlier `(leaseRequestId, admissionId)` pairs of this workflow's discard lease, each
    /// expired unregistered and replaced. A same-ID re-fetch still returns its saved reply.
    superseded: Vec<(String, String)>,
    registered: Option<RegisteredDiscard>,
}

impl DiscardLease {
    pub(super) fn is_completed(&self) -> bool {
        self.registered.as_ref().is_some_and(|registered| {
            matches!(&registered.state, DiscardDispatchState::Finished(reply)
                if reply.as_value()["outcome"]["kind"] == "completedDiscard")
        })
    }

    /// Registered but never dispatched: no native call yet, and no reply either.
    pub(super) fn is_undispatched(&self) -> bool {
        self.registered
            .as_ref()
            .is_some_and(|registered| matches!(registered.state, DiscardDispatchState::Registered))
    }

    pub(super) fn is_uncertain(&self) -> bool {
        self.registered
            .as_ref()
            .is_some_and(|registered| match &registered.state {
                DiscardDispatchState::Calling => true,
                DiscardDispatchState::Finished(reply) => {
                    reply.as_value()["outcome"]["kind"] == "unknown"
                }
                DiscardDispatchState::Registered => false,
            })
    }

    pub(super) fn blocks_other(
        &self,
        leases: &BTreeMap<String, LeaseRecord>,
        now: Instant,
    ) -> bool {
        match &self.registered {
            Some(registered) => !matches!(&registered.state,
                DiscardDispatchState::Finished(reply) if reply.as_value()["outcome"]["kind"] == "rejected"),
            None => leases
                .get(&self.lease_id)
                .is_some_and(|lease| now < lease.deadline),
        }
    }
}

#[derive(Clone)]
pub struct RecordingRegistryDiscardTicket {
    identity: Arc<()>,
    sequence: u64,
    admission_id: String,
}

impl RecordingRegistryDiscardTicket {
    pub fn sequence(&self) -> u64 {
        self.sequence
    }
    pub fn admission_id(&self) -> &str {
        &self.admission_id
    }
}

pub enum DiscardRegistration {
    Registered(RecordingRegistryDiscardTicket),
    Existing(RecordingRegistryDiscardTicket),
}

struct RegisteredDiscard {
    ticket: RecordingRegistryDiscardTicket,
    request: RecordingAdmissionRequest,
    budget: LifetimeBudget,
    state: DiscardDispatchState,
    #[cfg(test)]
    fault: Option<DiscardDispatchFault>,
}

enum DiscardDispatchState {
    Registered,
    Calling,
    Finished(RecordingAdmissionReply),
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum DiscardDispatchFault {
    NativePanicAfterCall,
}

impl DiscardLease {
    pub(super) fn admission_entry(&self) -> Option<AdmissionEntry<'_>> {
        self.registered.as_ref().map(|record| AdmissionEntry {
            stage: AdmissionStage::Discard,
            sequence: record.ticket.sequence,
            request: &record.request,
            reply: match &record.state {
                DiscardDispatchState::Finished(reply) => Some(reply),
                _ => None,
            },
            knowledge: None,
        })
    }
}

fn competing_pause(
    pause: &PauseLease,
    leases: &BTreeMap<String, LeaseRecord>,
    now: Instant,
) -> bool {
    match &pause.registered {
        Some(registered) => !matches!(&registered.state,
            PauseDispatchState::Finished(reply) if reply.as_value()["outcome"]["kind"] == "rejected"),
        None => leases
            .get(&pause.lease_id)
            .is_some_and(|lease| now < lease.deadline),
    }
}

fn competing_apply(
    apply: &ApplyLease,
    leases: &BTreeMap<String, LeaseRecord>,
    now: Instant,
) -> bool {
    match &apply.registered {
        Some(registered) => !matches!(&registered.state,
            ApplyDispatchState::Finished(reply) if reply.as_value()["outcome"]["kind"] == "rejected"),
        None => leases
            .get(&apply.lease_id)
            .is_some_and(|lease| now < lease.deadline),
    }
}

impl RecordingRegistryRoot {
    fn release_unissued_discard_stages(&mut self) {
        let record = self.workflow.as_ref().expect("qualified workflow");
        if record.released_unused_stages {
            return;
        }
        let mut bytes = 0;
        let mut revisions = 0;
        for (issued, stage_name) in [
            (record.pause_lease.is_some(), "pauseJoin"),
            (record.apply_lease.is_some(), "apply"),
        ] {
            if !issued {
                let (stage, _) = bounds::stage(&record.change, &self.scope, stage_name)
                    .expect("workflow reserved this stage");
                bytes += stage.bytes().expect("workflow reserved these bytes");
                revisions += 3;
            }
        }
        self.mutation_bytes -= bytes;
        self.reserved_revisions -= revisions;
        self.workflow
            .as_mut()
            .expect("qualified workflow")
            .released_unused_stages = true;
    }

    /// The separately reserved discard slot is usable only for a real Candidate or Paused owner.
    ///
    /// The slot holds one discard lease. The same IDs re-fetch its saved reply without extending
    /// it. Other IDs are `ProtocolViolation`, except when the held lease expired (by the host's
    /// `Instant`) without a registration: then the lease is re-issued under the new IDs in the
    /// same reserved slot, after the same checks as the first issue, and the old lease stays
    /// expired in history. Without this, an expired unregistered discard lease would leave the
    /// Candidate undiscardable and the owner unable to hand off.
    pub fn issue_discard_lease(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        preflight: &RecordingRegistryAdmissionTicket,
        request: RecordingWireLeaseRequest,
    ) -> Result<RecordingWireLeaseReply, LeaseError> {
        self.issue_discard_lease_at(session, workflow, preflight, request, Instant::now())
    }

    fn issue_discard_lease_at(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        preflight: &RecordingRegistryAdmissionTicket,
        request: RecordingWireLeaseRequest,
        now: Instant,
    ) -> Result<RecordingWireLeaseReply, LeaseError> {
        let record = self.workflow_record(session, workflow)?;
        let original = self.registered_preflight(session, preflight)?;
        self.refuse_new_after_close(
            record
                .discard_lease
                .as_ref()
                .map(|lease| lease.lease_id.as_str()),
            &request.as_value()["leaseRequestId"],
        )?;
        if request.as_value()["role"] != "mutation"
            || !same_scope(&self.scope, &request.as_value()["scope"])
        {
            return Err(LeaseError::Forbidden);
        }
        let (stage, _) = bounds::stage(&record.change, &self.scope, "discard")
            .map_err(|_| LeaseError::Capacity)?;
        let admission_id = request.as_value()["admissionId"]
            .as_str()
            .expect("validated ID")
            .to_owned();
        let lease_id = request.as_value()["leaseRequestId"]
            .as_str()
            .expect("validated ID")
            .to_owned();
        let mut superseded = Vec::new();
        if let Some(existing) = &record.discard_lease {
            if existing.preflight_sequence != preflight.sequence() {
                return Err(LeaseError::ProtocolViolation);
            }
            let ids = (lease_id.clone(), admission_id.clone());
            if (existing.lease_id == ids.0 && existing.admission_id == ids.1)
                || existing.superseded.contains(&ids)
            {
                return self.issue_drain_lease_at(session, request, now, stage.lease_bytes);
            }
            // Only a lease that expired unregistered is replaced, in the same reserved slot,
            // under new IDs (product owner design §6.1). A live or registered one keeps its IDs.
            let expired = self
                .leases
                .get(&existing.lease_id)
                .is_some_and(|lease| now >= lease.deadline);
            if existing.registered.is_some() || !expired {
                return Err(LeaseError::ProtocolViolation);
            }
            superseded = existing.superseded.clone();
            superseded.push((existing.lease_id.clone(), existing.admission_id.clone()));
        }
        if self.leases.contains_key(&lease_id)
            || self
                .leases
                .values()
                .any(|lease| lease.request.as_value()["admissionId"] == admission_id)
        {
            return Err(LeaseError::ProtocolViolation);
        }
        let proof = match &original.state {
            PreflightDispatchState::Finished(reply)
                if reply.as_value()["outcome"]["kind"] == "accepted" =>
            {
                Some(reply)
            }
            _ => original
                .knowledge
                .as_ref()
                .filter(|reply| reply.as_value()["outcome"]["kind"] == "accepted"),
        }
        .ok_or(LeaseError::Busy)?;
        let binding = original.binding.as_ref().ok_or(LeaseError::Busy)?;
        let expected = accepted_preflight_reply(
            &original.request,
            original.ticket.sequence(),
            binding,
            original.budget,
        )
        .ok_or(LeaseError::Busy)?;
        if proof.as_value() != expected.as_value() {
            return Err(LeaseError::ProtocolViolation);
        }
        let change_ref = proof.as_value()["outcome"]["handle"]["changeRef"]
            .as_str()
            .expect("accepted ref")
            .to_owned();
        let completion = binding
            .operation
            .watch()
            .borrow()
            .clone()
            .ok_or(LeaseError::Busy)?;
        original
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
        let owner = self.seed.client().state();
        if owner.closed || owner.recovery_required {
            return Err(LeaseError::Busy);
        }
        match owner.phase {
            OperationsPhase::Candidate => {
                if record
                    .pause_lease
                    .as_ref()
                    .is_some_and(|pause| competing_pause(pause, &self.leases, now))
                {
                    return Err(LeaseError::Busy);
                }
            }
            OperationsPhase::Paused => {
                let pause = record.pause_lease.as_ref().ok_or(LeaseError::Busy)?;
                let registered = pause.registered.as_ref().ok_or(LeaseError::Busy)?;
                let reply = match &registered.state {
                    PauseDispatchState::Finished(reply)
                        if reply.as_value()["outcome"]["kind"] == "accepted" =>
                    {
                        reply
                    }
                    _ => return Err(LeaseError::Busy),
                };
                let paused = registered.binding.as_ref().ok_or(LeaseError::Busy)?;
                let echoed = RecordingOperationRequest::from_value(
                    reply.as_value()["outcome"]["handle"]["request"].clone(),
                )
                .map_err(|_| LeaseError::ProtocolViolation)?;
                let admitted = RecordingOperationRequest::from_value(
                    registered.request.as_value()["action"]["operation"].clone(),
                )
                .map_err(|_| LeaseError::ProtocolViolation)?;
                if reply.as_value()["outcome"]["handle"]["changeRef"] != change_ref
                    || reply.as_value()["outcome"]["handle"]["operationRef"] != pause.operation_id
                    || !same_recording_operation_request(&echoed, paused.request())
                    || !same_recording_operation_request(&admitted, paused.request())
                {
                    return Err(LeaseError::ProtocolViolation);
                }
                let completed = paused.watch().borrow().clone().ok_or(LeaseError::Busy)?;
                registered
                    .budget
                    .check_completion(completed.as_value())
                    .map_err(|_| LeaseError::Capacity)?;
                let completed_request =
                    RecordingOperationRequest::from_value(completed.as_value()["request"].clone())
                        .map_err(|_| LeaseError::ProtocolViolation)?;
                if !same_recording_operation_request(&completed_request, paused.request()) {
                    return Err(LeaseError::ProtocolViolation);
                }
                if completed.as_value()["outcome"]["kind"] != "paused"
                    || completed.as_value()["quiescence"] != "confirmed"
                    || completed.as_value()["recoveryRequired"] != false
                    || completed.as_value()["outcome"]["sessionId"]
                        != self.seed.context().as_value()["sessionId"]
                {
                    return Err(LeaseError::Busy);
                }
                if record
                    .apply_lease
                    .as_ref()
                    .is_some_and(|apply| competing_apply(apply, &self.leases, now))
                {
                    return Err(LeaseError::Busy);
                }
            }
            _ => return Err(LeaseError::Busy),
        }
        let reply = self.issue_drain_lease_at(session, request, now, stage.lease_bytes)?;
        self.workflow
            .as_mut()
            .expect("qualified workflow")
            .discard_lease = Some(DiscardLease {
            preflight_sequence: preflight.sequence(),
            change_ref,
            admission_id,
            lease_id,
            superseded,
            registered: None,
        });
        Ok(reply)
    }

    pub fn register_discard(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        preflight: &RecordingRegistryAdmissionTicket,
        request: RecordingAdmissionRequest,
    ) -> Result<DiscardRegistration, LeaseError> {
        self.register_discard_with_clock(session, workflow, preflight, request, Instant::now)
    }

    #[cfg(test)]
    pub(crate) fn register_discard_at(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        preflight: &RecordingRegistryAdmissionTicket,
        request: RecordingAdmissionRequest,
        now: Instant,
    ) -> Result<DiscardRegistration, LeaseError> {
        self.register_discard_with_clock(session, workflow, preflight, request, || now)
    }

    fn register_discard_with_clock(
        &mut self,
        session: &RecordingRegistrySession,
        workflow: &RecordingRegistryWorkflowTicket,
        preflight: &RecordingRegistryAdmissionTicket,
        request: RecordingAdmissionRequest,
        clock: impl FnOnce() -> Instant,
    ) -> Result<DiscardRegistration, LeaseError> {
        let record = self.workflow_record(session, workflow)?;
        self.registered_preflight(session, preflight)?;
        self.refuse_new_after_close(
            record
                .discard_lease
                .as_ref()
                .and_then(|lease| lease.registered.as_ref())
                .map(|registered| registered.ticket.admission_id()),
            &request.as_value()["admissionId"],
        )?;
        let discard = record
            .discard_lease
            .as_ref()
            .ok_or(LeaseError::InvalidInput)?;
        let value = request.as_value();
        if value["ownerRef"] != self.scope["ownerRef"] || value["action"]["kind"] != "discard" {
            return Err(LeaseError::Forbidden);
        }
        let context = RecordingOperationsContext::from_value(value["context"].clone())
            .map_err(|_| LeaseError::InvalidInput)?;
        if !same_recording_operations_context(&context, self.seed.context()) {
            return Err(LeaseError::Forbidden);
        }
        if discard.preflight_sequence != preflight.sequence()
            || value["admissionId"] != discard.admission_id
            || value["action"]["changeRef"] != discard.change_ref
        {
            return Err(LeaseError::ProtocolViolation);
        }
        let change = RecordingChangeRequest::from_value(value["action"]["change"].clone())
            .map_err(|_| LeaseError::InvalidInput)?;
        if !same_recording_change_request(&change, &record.change) {
            return Err(LeaseError::ProtocolViolation);
        }
        if let Some(existing) = &discard.registered {
            if !same_recording_admission_request(&existing.request, &request) {
                return Err(LeaseError::ProtocolViolation);
            }
            return Ok(DiscardRegistration::Existing(existing.ticket.clone()));
        }
        let lease = self
            .leases
            .get(&discard.lease_id)
            .ok_or(LeaseError::InvalidInput)?;
        if !lease.workflow_owned
            || lease.principal != session.principal
            || lease.role != LeaseRole::Mutation
        {
            return Err(LeaseError::Forbidden);
        }
        if lease.request.as_value()["admissionId"] != value["admissionId"]
            || lease.reply.as_value()["outcome"]["deadlineLeaseRef"] != value["deadlineLeaseRef"]
            || lease.consumed
        {
            return Err(LeaseError::ProtocolViolation);
        }
        let (stage, _) = bounds::stage(&record.change, &self.scope, "discard")
            .map_err(|_| LeaseError::Capacity)?;
        let budget = LifetimeBudget::for_request(&request).map_err(|_| LeaseError::Capacity)?;
        if !stage.storage.covers(budget) {
            return Err(LeaseError::Capacity);
        }
        let sequence = self.sequence.checked_add(1).ok_or(LeaseError::Capacity)?;
        if clock() >= lease.deadline {
            return Err(LeaseError::Expired);
        }
        let ticket = RecordingRegistryDiscardTicket {
            identity: self.identity.clone(),
            sequence,
            admission_id: discard.admission_id.clone(),
        };
        let lease_id = discard.lease_id.clone();
        self.sequence = sequence;
        self.leases
            .get_mut(&lease_id)
            .expect("qualified lease")
            .consumed = true;
        self.workflow
            .as_mut()
            .expect("qualified workflow")
            .discard_lease
            .as_mut()
            .expect("qualified discard lease")
            .registered = Some(RegisteredDiscard {
            ticket: ticket.clone(),
            request,
            budget: stage.storage,
            state: DiscardDispatchState::Registered,
            #[cfg(test)]
            fault: None,
        });
        Ok(DiscardRegistration::Registered(ticket))
    }

    fn registered_discard(
        &self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryDiscardTicket,
    ) -> Result<&RegisteredDiscard, LeaseError> {
        self.check_grant(session)?;
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
        let registered = record
            .discard_lease
            .as_ref()
            .and_then(|lease| lease.registered.as_ref())
            .ok_or(LeaseError::InvalidInput)?;
        if registered.ticket.sequence != ticket.sequence
            || registered.ticket.admission_id != ticket.admission_id
        {
            return Err(LeaseError::ProtocolViolation);
        }
        Ok(registered)
    }

    pub fn discard_reply(
        &self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryDiscardTicket,
    ) -> Result<Option<RecordingAdmissionReply>, LeaseError> {
        let registered = self.registered_discard(session, ticket)?;
        Ok(match &registered.state {
            DiscardDispatchState::Finished(reply) => Some(reply.clone()),
            _ => None,
        })
    }

    pub fn dispatch_discard(
        &mut self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryDiscardTicket,
    ) -> Result<RecordingAdmissionReply, LeaseError> {
        let registered = self.registered_discard(session, ticket)?;
        match &registered.state {
            DiscardDispatchState::Finished(reply) => return Ok(reply.clone()),
            DiscardDispatchState::Calling => return Err(LeaseError::Busy),
            DiscardDispatchState::Registered if self.closed => return Err(LeaseError::Closed),
            DiscardDispatchState::Registered => {}
        }
        let request = registered.request.clone();
        let budget = registered.budget;
        #[cfg(test)]
        let fault = registered.fault;
        let record = self.workflow.as_ref().expect("qualified workflow");
        let lease_id = record
            .discard_lease
            .as_ref()
            .expect("qualified discard lease")
            .lease_id
            .clone();
        let change = record
            .registered
            .as_ref()
            .and_then(|preflight| preflight.binding.as_ref())
            .ok_or(LeaseError::Busy)?
            .change
            .clone();
        let deadline = self.leases[&lease_id].deadline;
        let unknown = admission_reply(&request, json!({"kind":"unknown","error":"workerFailure"}));
        budget
            .check_reply(unknown.as_value())
            .map_err(|_| LeaseError::Capacity)?;
        let registered = self
            .workflow
            .as_mut()
            .expect("qualified workflow")
            .discard_lease
            .as_mut()
            .expect("qualified discard lease")
            .registered
            .as_mut()
            .expect("qualified admission");
        if Instant::now() >= deadline {
            let reply = admission_reply(
                &request,
                json!({"kind":"rejected","error":"deadlineExceeded"}),
            );
            budget
                .check_reply(reply.as_value())
                .map_err(|_| LeaseError::Capacity)?;
            registered.state = DiscardDispatchState::Finished(reply.clone());
            return Ok(reply);
        }
        registered.state = DiscardDispatchState::Calling;
        let result = catch_unwind(AssertUnwindSafe(|| {
            let result = self.seed.client().discard(&change);
            #[cfg(test)]
            if fault == Some(DiscardDispatchFault::NativePanicAfterCall) {
                panic!("test discard response loss after native call");
            }
            result
        }));
        let reply = match result {
            Ok(Ok(())) => admission_reply(&request, json!({"kind":"completedDiscard"})),
            Ok(Err(rejection)) => admission_reply(
                &request,
                json!({"kind":"rejected","error":rejection.code.as_str()}),
            ),
            Err(_) => unknown.clone(),
        };
        let registered = self
            .workflow
            .as_mut()
            .expect("qualified workflow")
            .discard_lease
            .as_mut()
            .expect("qualified discard lease")
            .registered
            .as_mut()
            .expect("qualified admission");
        let stored_reply = if budget.check_reply(reply.as_value()).is_ok() {
            reply.clone()
        } else {
            unknown.clone()
        };
        registered.state = DiscardDispatchState::Finished(stored_reply);
        if self
            .workflow
            .as_ref()
            .expect("qualified workflow")
            .discard_lease
            .as_ref()
            .expect("qualified discard lease")
            .is_completed()
        {
            self.release_unissued_discard_stages();
        }
        let registered = self
            .workflow
            .as_ref()
            .expect("qualified workflow")
            .discard_lease
            .as_ref()
            .expect("qualified discard lease")
            .registered
            .as_ref()
            .expect("qualified admission");
        Ok(match &registered.state {
            DiscardDispatchState::Finished(reply) => reply.clone(),
            _ => unreachable!(),
        })
    }

    #[cfg(test)]
    pub(crate) fn test_set_discard_dispatch_fault(
        &mut self,
        session: &RecordingRegistrySession,
        ticket: &RecordingRegistryDiscardTicket,
        fault: DiscardDispatchFault,
    ) {
        self.registered_discard(session, ticket).unwrap();
        self.workflow
            .as_mut()
            .unwrap()
            .discard_lease
            .as_mut()
            .unwrap()
            .registered
            .as_mut()
            .unwrap()
            .fault = Some(fault);
    }
}

fn admission_reply(
    request: &RecordingAdmissionRequest,
    outcome: serde_json::Value,
) -> RecordingAdmissionReply {
    RecordingAdmissionReply::from_value(json!({
        "version":1,"kind":"recordingAdmissionReply","request":request.as_value(),"outcome":outcome
    }))
    .expect("validated admission and reserved reply capacity")
}
