use super::RecordingRegistryOwnerSeed;
use crate::recording_operations::{OwnerError, RecordingOperationsHandoff};
use scada_model::recording_operations::{
    same_recording_operations_context, RecordingOperationsContext,
};
use scada_model::recording_wire::{
    conservative_recording_json_bound, same_recording_wire_request, RecordingWireLeaseReply,
    RecordingWireLeaseRequest, WIRE_REQUEST_LIMIT,
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fmt,
    sync::Arc,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseRole {
    Mutation,
    Reconciliation,
}

impl LeaseRole {
    fn wire_name(self) -> &'static str {
        match self {
            Self::Mutation => "mutation",
            Self::Reconciliation => "reconciliation",
        }
    }

    fn byte_limit(self) -> usize {
        match self {
            Self::Mutation => 6 * 1024 * 1024,
            Self::Reconciliation => 2 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseError {
    InvalidInput,
    Forbidden,
    ProtocolViolation,
    Capacity,
    Expired,
    Closed,
}

impl fmt::Display for LeaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Recording registry lease: {self:?}")
    }
}
impl std::error::Error for LeaseError {}

/// An opaque host-granted capability. Production issuance waits for the host auth contract.
#[derive(Clone)]
pub struct RecordingRegistrySession {
    root_identity: Arc<()>,
    scope: Value,
    principal: String,
    role: LeaseRole,
}

struct LeaseRecord {
    request: RecordingWireLeaseRequest,
    reply: RecordingWireLeaseReply,
    principal: String,
    role: LeaseRole,
    deadline: Instant,
    consumed: bool,
}

/// Native owner and lease history survive UI view and transport disconnects.
pub struct RecordingRegistryRoot {
    seed: RecordingRegistryOwnerSeed,
    scope: Value,
    identity: Arc<()>,
    leases: BTreeMap<String, LeaseRecord>,
    sequence: u64,
    mutation_bytes: usize,
    read_bytes: usize,
    mutation_byte_limit: usize,
    read_byte_limit: usize,
    closed: bool,
}

pub struct RegistryRootInitFailure {
    pub error: LeaseError,
    pub seed: RecordingRegistryOwnerSeed,
}

impl fmt::Debug for RegistryRootInitFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RegistryRootInitFailure")
            .field("error", &self.error)
            .field("seed", &"RecordingRegistryOwnerSeed(..)")
            .finish()
    }
}

impl RecordingRegistryRoot {
    pub fn try_new(
        seed: RecordingRegistryOwnerSeed,
        scope: Value,
    ) -> Result<Self, RegistryRootInitFailure> {
        if seed.check_claim().is_err() {
            return Err(RegistryRootInitFailure {
                error: LeaseError::Forbidden,
                seed,
            });
        }
        let checked = conservative_recording_json_bound(&scope, WIRE_REQUEST_LIMIT)
            .ok()
            .and_then(|_| {
                RecordingWireLeaseRequest::from_value(json!({
                    "version": 1, "kind": "recordingWireLeaseRequest", "scope": scope,
                    "leaseRequestId": "validation", "admissionId": "validation",
                    "role": "mutation", "requestedBudgetMs": 1
                }))
                .ok()
            })
            .and_then(|request| {
                RecordingOperationsContext::from_value(
                    request.as_value()["scope"]["context"].clone(),
                )
                .ok()
            });
        if !checked
            .as_ref()
            .is_some_and(|context| same_recording_operations_context(context, seed.context()))
        {
            return Err(RegistryRootInitFailure {
                error: LeaseError::InvalidInput,
                seed,
            });
        }
        Ok(Self {
            seed,
            scope,
            identity: Arc::new(()),
            leases: BTreeMap::new(),
            sequence: 0,
            mutation_bytes: 0,
            read_bytes: 0,
            mutation_byte_limit: LeaseRole::Mutation.byte_limit(),
            read_byte_limit: LeaseRole::Reconciliation.byte_limit(),
            closed: false,
        })
    }

    #[cfg(test)]
    pub(crate) fn test_session(
        &self,
        principal: &str,
        role: LeaseRole,
    ) -> RecordingRegistrySession {
        assert!(!principal.is_empty());
        RecordingRegistrySession {
            root_identity: self.identity.clone(),
            scope: self.scope.clone(),
            principal: principal.to_owned(),
            role,
        }
    }

    #[cfg(test)]
    pub(crate) fn test_set_byte_limit(&mut self, role: LeaseRole, limit: usize) {
        assert!(limit <= role.byte_limit());
        match role {
            LeaseRole::Mutation => self.mutation_byte_limit = limit,
            LeaseRole::Reconciliation => self.read_byte_limit = limit,
        }
    }

    #[cfg(test)]
    pub(crate) fn test_used_bytes(&self, role: LeaseRole) -> usize {
        self.used_bytes(role)
    }

    pub fn issue_lease(
        &mut self,
        session: &RecordingRegistrySession,
        request: RecordingWireLeaseRequest,
    ) -> Result<RecordingWireLeaseReply, LeaseError> {
        self.issue_lease_at(session, request, Instant::now())
    }

    pub(crate) fn issue_lease_at(
        &mut self,
        session: &RecordingRegistrySession,
        request: RecordingWireLeaseRequest,
        now: Instant,
    ) -> Result<RecordingWireLeaseReply, LeaseError> {
        if self.closed {
            return Err(LeaseError::Closed);
        }
        if !Arc::ptr_eq(&self.identity, &session.root_identity)
            || session.scope != self.scope
            || !same_scope(&self.scope, &request.as_value()["scope"])
            || request.as_value()["role"] != session.role.wire_name()
        {
            return Err(LeaseError::Forbidden);
        }
        let value = request.as_value();
        let id = value["leaseRequestId"].as_str().expect("validated ID");
        if let Some(existing) = self.leases.get(id) {
            if existing.principal != session.principal || existing.role != session.role {
                return Err(LeaseError::Forbidden);
            }
            if !same_recording_wire_request(existing.request.as_document(), request.as_document()) {
                return Err(LeaseError::ProtocolViolation);
            }
            return Ok(existing.reply.clone());
        }
        if self
            .leases
            .values()
            .any(|lease| lease.request.as_value()["admissionId"] == value["admissionId"])
        {
            return Err(LeaseError::ProtocolViolation);
        }
        if self
            .leases
            .values()
            .filter(|lease| lease.role == session.role)
            .count()
            >= 4096
            || self
                .leases
                .values()
                .filter(|lease| {
                    lease.role == session.role && !lease.consumed && now < lease.deadline
                })
                .count()
                >= 4
        {
            return Err(LeaseError::Capacity);
        }
        let budget = value["requestedBudgetMs"]
            .as_u64()
            .or_else(|| {
                value["requestedBudgetMs"]
                    .as_f64()
                    .map(|number| number as u64)
            })
            .ok_or(LeaseError::InvalidInput)?;
        let deadline = now
            .checked_add(Duration::from_millis(budget))
            .ok_or(LeaseError::InvalidInput)?;
        let sequence = self.sequence.checked_add(1).ok_or(LeaseError::Capacity)?;
        let reply = RecordingWireLeaseReply::from_value(json!({
            "version": 1, "kind": "recordingWireLeaseReply", "request": value,
            "outcome": {"kind": "issued", "deadlineLeaseRef": format!("native-lease:{sequence}"),
                        "grantedBudgetMs": budget}
        }))
        .map_err(|_| LeaseError::InvalidInput)?;
        let request_bytes = conservative_recording_json_bound(value, WIRE_REQUEST_LIMIT)
            .map_err(|_| LeaseError::InvalidInput)?
            .bytes;
        let reply_bytes = conservative_recording_json_bound(
            reply.as_value(),
            scada_model::recording_wire::WIRE_REPLY_LIMIT,
        )
        .map_err(|_| LeaseError::InvalidInput)?
        .bytes;
        let new_bytes = self
            .used_bytes(session.role)
            .checked_add(request_bytes)
            .and_then(|bytes| bytes.checked_add(reply_bytes))
            .ok_or(LeaseError::Capacity)?;
        let limit = match session.role {
            LeaseRole::Mutation => self.mutation_byte_limit,
            LeaseRole::Reconciliation => self.read_byte_limit,
        };
        if new_bytes > limit {
            return Err(LeaseError::Capacity);
        }
        self.sequence = sequence;
        *self.used_bytes_mut(session.role) = new_bytes;
        self.leases.insert(
            id.to_owned(),
            LeaseRecord {
                request,
                reply: reply.clone(),
                principal: session.principal.clone(),
                role: session.role,
                deadline,
                consumed: false,
            },
        );
        Ok(reply)
    }

    fn used_bytes(&self, role: LeaseRole) -> usize {
        match role {
            LeaseRole::Mutation => self.mutation_bytes,
            LeaseRole::Reconciliation => self.read_bytes,
        }
    }

    fn used_bytes_mut(&mut self, role: LeaseRole) -> &mut usize {
        match role {
            LeaseRole::Mutation => &mut self.mutation_bytes,
            LeaseRole::Reconciliation => &mut self.read_bytes,
        }
    }

    /// The native owner handoff gate remains authoritative. Successful handoff closes this root.
    pub fn try_handoff(&mut self) -> Result<RecordingOperationsHandoff, OwnerError> {
        let handoff = self.seed.try_handoff()?;
        self.closed = true;
        Ok(handoff)
    }
}

fn same_scope(expected: &Value, actual: &Value) -> bool {
    if expected["ownerRef"] != actual["ownerRef"] || expected["ownerEpoch"] != actual["ownerEpoch"]
    {
        return false;
    }
    let Ok(left) = RecordingOperationsContext::from_value(expected["context"].clone()) else {
        return false;
    };
    let Ok(right) = RecordingOperationsContext::from_value(actual["context"].clone()) else {
        return false;
    };
    same_recording_operations_context(&left, &right)
}
