//! Initial native workflow reservation. No lease consumption or native dispatch yet.
use super::{
    kernel::workflow as bounds, LeaseError, LeaseRole, RecordingRegistryRoot,
    RecordingRegistrySession,
};
use crate::recording_operations::RegistryClaimReason;
use scada_model::recording_operations::{
    same_recording_change_request, same_recording_operations_context, RecordingChangeRequest,
    RecordingOperationsContext,
};
use std::sync::Arc;

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
}

impl RecordingRegistryRoot {
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
        self.workflow = Some(WorkflowRecord {
            ticket: ticket.clone(),
            change,
            principal: session.principal.clone(),
        });
        Ok(ticket)
    }
}
