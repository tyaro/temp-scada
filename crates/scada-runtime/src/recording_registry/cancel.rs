//! Original cancel calls over saved native handles (adapter design §5, §7 acceptance 3).
//! A cancel ID is registered and decided in one synchronous turn: the native handle is
//! notified at most once in total, and the immutable reply is saved before it is returned.
//! An ack never claims physical termination, commit rollback, or quiescence.
use super::{
    kernel::budget::measured, lease::same_scope, LeaseError, LeaseRole, RecordingRegistryRoot,
    RecordingRegistrySession,
};
use crate::recording_operations::{
    CancelDisposition, RecordingOperationHandle, RecordingReconciliationHandle,
};
use scada_model::recording_wire::{
    recording_wire_reply_capacity, same_recording_wire_request, RecordingWireCancelReply,
    RecordingWireCancelRequest, RecordingWireDocument,
};
use serde_json::{json, Value};
use std::sync::Arc;

const MAX_CANCEL_REQUESTS: usize = 4096;

/// The saved native handle a cancel ID was bound to at registration. Never rebound later.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(super) enum CancelTarget {
    Preflight(u64),
    Pause(u64),
    Apply(u64),
    Reconciliation(u64),
}

pub(super) struct CancelRecord {
    request: RecordingWireCancelRequest,
    principal: String,
    reply: RecordingWireCancelReply,
}

impl RecordingRegistryRoot {
    /// Registers one cancel ID and returns its immutable reply. The same ID and body replays
    /// the saved reply, even after close. A ref unknown at registration stays rejected for
    /// that ID; a later accepted handle is reached only by a new cancel ID. Pause/join is
    /// `notSupported` and never withdraws a stop. The target's operation or read completion,
    /// original admission reply, observation slots, and native recovery are unchanged.
    pub fn request_cancel(
        &mut self,
        session: &RecordingRegistrySession,
        request: RecordingWireCancelRequest,
    ) -> Result<RecordingWireCancelReply, LeaseError> {
        let value = request.as_value();
        let role = if value["target"]["kind"] == "operation" {
            LeaseRole::Mutation
        } else {
            LeaseRole::Reconciliation
        };
        self.check_grant(session)?;
        if !Arc::ptr_eq(&self.identity, &session.root_identity)
            || session.scope != self.scope
            || session.role != role
            || !same_scope(&self.scope, &value["scope"])
        {
            return Err(LeaseError::Forbidden);
        }
        let id = value["cancelId"].as_str().expect("validated ID");
        if let Some(record) = self.cancels.get(id) {
            if record.principal != session.principal {
                return Err(LeaseError::Forbidden);
            }
            if !same_recording_wire_request(record.request.as_document(), request.as_document()) {
                return Err(LeaseError::ProtocolViolation);
            }
            return Ok(record.reply.clone());
        }
        if self.closed {
            return Err(LeaseError::Closed);
        }
        let workflow = self.workflow.as_ref().ok_or(LeaseError::InvalidInput)?;
        if workflow.principal != session.principal {
            return Err(LeaseError::Forbidden);
        }
        if self.cancels.len() >= MAX_CANCEL_REQUESTS {
            return Err(LeaseError::Capacity);
        }
        // The request and the largest possible reply are charged once, before any notify.
        let cost = measured(value)
            .ok()
            .zip(
                recording_wire_reply_capacity(request.as_document())
                    .ok()
                    .map(|capacity| capacity.reply.bytes),
            )
            .and_then(|(request, reply)| request.bytes.checked_add(reply))
            .ok_or(LeaseError::Capacity)?;
        let next_bytes = self
            .read_bytes
            .checked_add(cost)
            .filter(|bytes| *bytes <= self.read_byte_limit)
            .ok_or(LeaseError::Capacity)?;
        let target = self.cancel_target(&value["target"]);
        let outcome = match target {
            None => json!({"kind":"rejected","error":"ownerUnavailable"}),
            Some(target) => match self.cancel_decision(target)? {
                CancelDecision::Fixed(disposition) => ack(disposition),
                CancelDecision::Notify => {
                    // The only native notify; recorded before any later fallible step.
                    let disposition = self.notify_native(target)?;
                    if disposition == CancelDisposition::Requested {
                        self.cancel_notified.insert(target);
                    }
                    ack(disposition)
                }
            },
        };
        let reply = RecordingWireCancelReply::from_value(json!({
            "version":1, "kind":"recordingWireCancelReply",
            "request":value, "outcome":outcome
        }))
        .map_err(|_| LeaseError::ProtocolViolation)?;
        self.read_bytes = next_bytes;
        self.cancels.insert(
            id.to_owned(),
            CancelRecord {
                request,
                principal: session.principal.clone(),
                reply: reply.clone(),
            },
        );
        Ok(reply)
    }

    /// Resolves a kind-scoped ref to a saved native handle. Operation and read refs never
    /// cross namespaces, and a ref without a saved handle has no target.
    fn cancel_target(&self, target: &Value) -> Option<CancelTarget> {
        let workflow = self.workflow.as_ref()?;
        let reference = target["ref"].as_str().expect("validated ref");
        if target["kind"] != "operation" {
            return self
                .reconciliation_by_ref(reference)
                .filter(|read| read.binding.is_some())
                .map(|read| CancelTarget::Reconciliation(read.ticket_sequence()));
        }
        let same = |operation: &RecordingOperationHandle| {
            operation.request().as_value()["operationId"] == reference
        };
        if let Some(preflight) = &workflow.registered {
            if preflight
                .binding
                .as_ref()
                .is_some_and(|binding| same(&binding.operation))
            {
                return Some(CancelTarget::Preflight(preflight.ticket.sequence()));
            }
        }
        if let Some(pause) = workflow
            .pause_lease
            .as_ref()
            .and_then(|pause| pause.registered.as_ref())
        {
            if pause.binding.as_ref().is_some_and(same) {
                return Some(CancelTarget::Pause(pause.ticket.sequence()));
            }
        }
        if let Some(apply) = workflow
            .apply_lease
            .as_ref()
            .and_then(|apply| apply.registered.as_ref())
        {
            if apply.binding.as_ref().is_some_and(same) {
                return Some(CancelTarget::Apply(apply.ticket.sequence));
            }
        }
        None
    }

    /// Decides from native handle state without side effects. Pause/join is `notSupported`
    /// whatever its completion; a handle already notified is `requested` again.
    fn cancel_decision(&self, target: CancelTarget) -> Result<CancelDecision, LeaseError> {
        let completed = match target {
            CancelTarget::Pause(_) => {
                return Ok(CancelDecision::Fixed(CancelDisposition::NotSupported))
            }
            CancelTarget::Reconciliation(_) => self.saved_read(target)?.watch().borrow().is_some(),
            _ => self.saved_operation(target)?.watch().borrow().is_some(),
        };
        Ok(if completed {
            CancelDecision::Fixed(CancelDisposition::AlreadyCompleted)
        } else if self.cancel_notified.contains(&target) {
            CancelDecision::Fixed(CancelDisposition::Requested)
        } else {
            CancelDecision::Notify
        })
    }

    /// Native decides again under its own state; a completion that raced in is reported.
    fn notify_native(&self, target: CancelTarget) -> Result<CancelDisposition, LeaseError> {
        Ok(match target {
            CancelTarget::Reconciliation(_) => self.saved_read(target)?.request_cancel(),
            _ => self.saved_operation(target)?.request_cancel(),
        })
    }

    fn saved_operation(
        &self,
        target: CancelTarget,
    ) -> Result<&RecordingOperationHandle, LeaseError> {
        let workflow = self
            .workflow
            .as_ref()
            .ok_or(LeaseError::ProtocolViolation)?;
        match target {
            CancelTarget::Preflight(sequence) => workflow
                .registered
                .as_ref()
                .filter(|record| record.ticket.sequence() == sequence)
                .and_then(|record| record.binding.as_ref())
                .map(|binding| &binding.operation),
            CancelTarget::Pause(sequence) => workflow
                .pause_lease
                .as_ref()
                .and_then(|pause| pause.registered.as_ref())
                .filter(|record| record.ticket.sequence() == sequence)
                .and_then(|record| record.binding.as_ref()),
            CancelTarget::Apply(sequence) => workflow
                .apply_lease
                .as_ref()
                .and_then(|apply| apply.registered.as_ref())
                .filter(|record| record.ticket.sequence == sequence)
                .and_then(|record| record.binding.as_ref()),
            CancelTarget::Reconciliation(_) => None,
        }
        .ok_or(LeaseError::ProtocolViolation)
    }

    fn saved_read(
        &self,
        target: CancelTarget,
    ) -> Result<&RecordingReconciliationHandle, LeaseError> {
        let CancelTarget::Reconciliation(sequence) = target else {
            return Err(LeaseError::ProtocolViolation);
        };
        self.reconciliation_by_sequence(sequence)
            .and_then(|read| read.binding.as_ref())
            .ok_or(LeaseError::ProtocolViolation)
    }

    /// The saved reply of a registered cancel ID, for read-only call inspection.
    pub(super) fn saved_cancel(
        &self,
        id: &str,
        principal: &str,
        original: &RecordingWireDocument,
    ) -> Result<Option<RecordingWireCancelReply>, LeaseError> {
        let Some(record) = self.cancels.get(id) else {
            return Ok(None);
        };
        if record.principal != principal {
            return Err(LeaseError::Forbidden);
        }
        if !same_recording_wire_request(record.request.as_document(), original) {
            return Err(LeaseError::ProtocolViolation);
        }
        Ok(Some(record.reply.clone()))
    }

    #[cfg(test)]
    pub(crate) fn test_cancel_count(&self) -> usize {
        self.cancels.len()
    }

    #[cfg(test)]
    pub(crate) fn test_cancel_notified_handles(&self) -> usize {
        self.cancel_notified.len()
    }
}

enum CancelDecision {
    Fixed(CancelDisposition),
    Notify,
}

fn ack(disposition: CancelDisposition) -> Value {
    let disposition = match disposition {
        CancelDisposition::Requested => "requested",
        CancelDisposition::AlreadyCompleted => "alreadyCompleted",
        CancelDisposition::NotSupported => "notSupported",
    };
    json!({"kind":"ack","disposition":disposition})
}
