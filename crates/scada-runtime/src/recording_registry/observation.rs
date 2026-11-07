//! Read-only result observation over saved native handles.
//! Each query borrows the handle's set-once completion; no native task or wait is added.
use super::{
    kernel::budget::measured, lease::same_scope, LeaseError, LeaseRole, RecordingRegistryRoot,
    RecordingRegistrySession,
};
use scada_model::recording_operations::{
    same_recording_operation_request, same_recording_reconciliation_request,
    RecordingOperationRequest, RecordingReconciliationRequest,
};
use scada_model::recording_wire::{
    same_recording_wire_request, RecordingWireObservationReply, RecordingWireObservationRequest,
};
use serde_json::{json, Value};
use std::sync::Arc;

const MAX_OBSERVATIONS_PER_KIND: usize = 4096;
const MAX_PENDING_OBSERVATIONS_PER_KIND: usize = 2;

/// The saved native handle an observation ID is bound to. `None` stays unavailable forever.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ObservedHandle {
    Preflight(u64),
    Pause(u64),
    Apply(u64),
    Reconciliation(u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ObservationKind {
    Operation,
    Reconciliation,
}

pub(super) struct ObservationRecord {
    request: RecordingWireObservationRequest,
    principal: String,
    kind: ObservationKind,
    handle: Option<ObservedHandle>,
    /// Registered while non-terminal; released only when this ID returns a terminal reply.
    pending: bool,
}

impl RecordingRegistryRoot {
    /// Observes the completion of a saved native operation or read handle.
    /// Observing never rewrites an original admission reply, qualifies a next stage, or
    /// clears native recovery. An unknown ref binds the ID to a permanent `unavailable`.
    pub fn observe_result(
        &mut self,
        session: &RecordingRegistrySession,
        request: RecordingWireObservationRequest,
    ) -> Result<RecordingWireObservationReply, LeaseError> {
        if self.closed {
            return Err(LeaseError::Closed);
        }
        let value = request.as_value();
        if !Arc::ptr_eq(&self.identity, &session.root_identity)
            || session.scope != self.scope
            || session.role != LeaseRole::Reconciliation
            || !same_scope(&self.scope, &value["scope"])
        {
            return Err(LeaseError::Forbidden);
        }
        let workflow = self.workflow.as_ref().ok_or(LeaseError::InvalidInput)?;
        if workflow.principal != session.principal {
            return Err(LeaseError::Forbidden);
        }
        let id = value["observationId"].as_str().expect("validated ID");
        let target = &value["target"];
        let kind = if target["kind"] == "operation" {
            ObservationKind::Operation
        } else {
            ObservationKind::Reconciliation
        };
        let existing = self.observations.get(id);
        if let Some(record) = existing {
            if record.principal != session.principal {
                return Err(LeaseError::Forbidden);
            }
            if !same_recording_wire_request(record.request.as_document(), request.as_document()) {
                return Err(LeaseError::ProtocolViolation);
            }
        }
        let handle = match existing {
            Some(record) => record.handle,
            None => self.resolve_observed_handle(target)?,
        };
        let outcome = match handle {
            None => json!({"kind":"unavailable","error":"ownerUnavailable"}),
            Some(handle) => self.observed_outcome(handle)?,
        };
        let pending = outcome["kind"] == "pending";
        let reply = RecordingWireObservationReply::from_value(json!({
            "version":1, "kind":"recordingWireObservationReply",
            "request":value, "outcome":outcome
        }))
        .map_err(|_| LeaseError::ProtocolViolation)?;
        if existing.is_some() {
            if !pending {
                self.observations
                    .get_mut(id)
                    .expect("existing observation")
                    .pending = false;
            }
            return Ok(reply);
        }
        let same_kind = self.observations.values().filter(|o| o.kind == kind);
        let (count, pending_count) = same_kind.fold((0usize, 0usize), |(all, open), o| {
            (all + 1, open + usize::from(o.pending))
        });
        if count >= MAX_OBSERVATIONS_PER_KIND
            || (pending && pending_count >= MAX_PENDING_OBSERVATIONS_PER_KIND)
        {
            return Err(LeaseError::Capacity);
        }
        // Retained cost is the original request only; terminal payloads stay on the handle.
        let bytes = measured(value).map_err(|_| LeaseError::Capacity)?.bytes;
        let next_bytes = self
            .read_bytes
            .checked_add(bytes)
            .ok_or(LeaseError::Capacity)?;
        if next_bytes > self.read_byte_limit {
            return Err(LeaseError::Capacity);
        }
        self.read_bytes = next_bytes;
        self.observations.insert(
            id.to_owned(),
            ObservationRecord {
                request,
                principal: session.principal.clone(),
                kind,
                handle,
                pending,
            },
        );
        Ok(reply)
    }

    /// Finds a saved native handle by kind and ref, then requires the full original request.
    fn resolve_observed_handle(
        &self,
        target: &Value,
    ) -> Result<Option<ObservedHandle>, LeaseError> {
        let workflow = self.workflow.as_ref().expect("qualified workflow");
        if target["kind"] == "operation" {
            let wanted = RecordingOperationRequest::from_value(target["request"].clone())
                .map_err(|_| LeaseError::InvalidInput)?;
            let reference = &target["operationRef"];
            let mut saved: Vec<(&RecordingOperationRequest, ObservedHandle)> = Vec::new();
            if let Some(preflight) = &workflow.registered {
                if let Some(binding) = &preflight.binding {
                    saved.push((
                        binding.operation.request(),
                        ObservedHandle::Preflight(preflight.ticket.sequence()),
                    ));
                }
            }
            if let Some(pause) = workflow
                .pause_lease
                .as_ref()
                .and_then(|p| p.registered.as_ref())
            {
                if let Some(binding) = &pause.binding {
                    saved.push((
                        binding.request(),
                        ObservedHandle::Pause(pause.ticket.sequence()),
                    ));
                }
            }
            if let Some(apply) = workflow
                .apply_lease
                .as_ref()
                .and_then(|a| a.registered.as_ref())
            {
                if let Some(binding) = &apply.binding {
                    saved.push((
                        binding.request(),
                        ObservedHandle::Apply(apply.ticket.sequence),
                    ));
                }
            }
            let Some((request, handle)) = saved
                .into_iter()
                .find(|(request, _)| &request.as_value()["operationId"] == reference)
            else {
                return Ok(None);
            };
            if !same_recording_operation_request(request, &wanted) {
                return Err(LeaseError::ProtocolViolation);
            }
            Ok(Some(handle))
        } else {
            let wanted = RecordingReconciliationRequest::from_value(target["request"].clone())
                .map_err(|_| LeaseError::InvalidInput)?;
            let Some((read, binding)) = target["readRef"]
                .as_str()
                .and_then(|reference| self.reconciliation_by_ref(reference))
                .and_then(|read| read.binding.as_ref().map(|binding| (read, binding)))
            else {
                return Ok(None);
            };
            if !same_recording_reconciliation_request(binding.request(), &wanted) {
                return Err(LeaseError::ProtocolViolation);
            }
            Ok(Some(ObservedHandle::Reconciliation(read.ticket_sequence())))
        }
    }

    fn observed_outcome(&self, handle: ObservedHandle) -> Result<Value, LeaseError> {
        Ok(match (handle, self.handle_completion(handle)?) {
            (_, None) => json!({"kind":"pending"}),
            (ObservedHandle::Reconciliation(_), Some(delivery)) => {
                json!({"kind":"reconciliation","delivery":delivery})
            }
            (_, Some(result)) => json!({"kind":"operation","result":result}),
        })
    }

    /// The set-once operation result or read delivery of a saved handle, if completed.
    pub(super) fn handle_completion(
        &self,
        handle: ObservedHandle,
    ) -> Result<Option<Value>, LeaseError> {
        let workflow = self
            .workflow
            .as_ref()
            .ok_or(LeaseError::ProtocolViolation)?;
        let operation = match handle {
            ObservedHandle::Preflight(sequence) => workflow
                .registered
                .as_ref()
                .filter(|record| record.ticket.sequence() == sequence)
                .ok_or(LeaseError::ProtocolViolation)?
                .completion()?,
            ObservedHandle::Pause(sequence) => workflow
                .pause_lease
                .as_ref()
                .and_then(|pause| pause.registered.as_ref())
                .filter(|record| record.ticket.sequence() == sequence)
                .ok_or(LeaseError::ProtocolViolation)?
                .completion()?,
            ObservedHandle::Apply(sequence) => workflow
                .apply_lease
                .as_ref()
                .and_then(|apply| apply.registered.as_ref())
                .filter(|record| record.ticket.sequence == sequence)
                .ok_or(LeaseError::ProtocolViolation)?
                .completion()?,
            ObservedHandle::Reconciliation(sequence) => {
                let read = self
                    .reconciliation_by_sequence(sequence)
                    .ok_or(LeaseError::ProtocolViolation)?;
                return Ok(read
                    .delivery(&self.scope["ownerRef"])?
                    .map(|delivery| delivery.as_value().clone()));
            }
        };
        Ok(operation.map(|result| result.as_value().clone()))
    }

    #[cfg(test)]
    pub(crate) fn test_observation_count(&self) -> usize {
        self.observations.len()
    }
}
