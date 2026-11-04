//! Deterministic prep2 simulation, NOT a production registry/lease authority.
//! No native owner, clock, executor, callbacks, persistence or transport is used.
mod admission;
mod cancel;
mod domain;
pub use domain::*;
mod handle;
mod inspection;
mod lease;
mod observation;
mod projection;
mod reservation;
mod subscription;
mod workflow;
use projection::{ProjectionEvent, ProjectionState, SnapshotDescriptor, DESCRIPTOR_BYTES};
use reservation::{LifetimeBudget, READ_ID_BYTES};
use subscription::{AttachRecord, ControlRecord, SubscriptionRecord};
mod types;
use scada_model::recording_admission::*;
use scada_model::recording_operations::{
    same_recording_operations_context, RecordingOperationsContext,
};
use scada_model::recording_wire::*;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc};
pub use types::*;
#[derive(Debug)]
pub struct RegistryModel {
    session: ModelSession,
    limits: ModelLimits,
    now: ModelInstant,
    closed: bool,
    clock_fault: bool,
    identity: Arc<()>,
    sequence: u64,
    leases: BTreeMap<String, LeaseRecord>,
    admissions: BTreeMap<String, AdmissionRecord>,
    inspections: BTreeMap<
        String,
        (
            RecordingAdmissionInspectionRequest,
            RecordingAdmissionInspectionReply,
        ),
    >,
    call_inspections: BTreeMap<String, RecordingWireCallInspectionRequest>,
    mutation_bytes: usize,
    read_bytes: usize,
    handles: BTreeMap<HandleKey, HandleRecord>,
    observations: BTreeMap<String, ObservationRecord>,
    recovery_required: bool,
    cancels: BTreeMap<String, CancelRecord>,
    projection: ProjectionState,
    subscriptions: BTreeMap<String, SubscriptionRecord>,
    attaches: BTreeMap<String, AttachRecord>,
    controls: BTreeMap<String, ControlRecord>,
    subscription_sequence: u64,
    workflow: Option<workflow::WorkflowMode>,
    reconciliation_ids: BTreeMap<String, String>,
}
#[derive(Debug)]
struct LeaseRecord {
    request: RecordingWireLeaseRequest,
    reply: RecordingWireLeaseReply,
    deadline: u64,
    consumed: bool,
    role: Role,
}
#[derive(Debug)]
struct AdmissionRecord {
    request: RecordingAdmissionRequest,
    role: Role,
    sequence: u64,
    proof: Option<RecordingAdmissionReply>,
    terminal: Option<RecordingAdmissionReply>,
    projection_credits: u8,
    storage: LifetimeBudget,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Role {
    Mutation,
    Read,
}
type HandleKey = (Role, String);
#[derive(Debug)]
struct HandleRecord {
    admission_id: String,
    sequence: u64,
    original_operation: Option<HandleKey>,
    completion: Option<SimulatedCompletion>,
    cancel_notified: bool,
}
#[derive(Debug)]
struct ObservationRecord {
    request: RecordingWireObservationRequest,
    role: Role,
    target: Option<HandleKey>,
    pending: bool,
}
#[derive(Debug)]
struct CancelRecord {
    request: RecordingWireCancelRequest,
    sequence: u64,
    target: Option<HandleKey>,
    decision: Option<RecordingWireCancelReply>,
    terminal: bool,
}
impl RegistryModel {
    pub fn new(session: ModelSession, limits: ModelLimits) -> Result<Self, ModelError> {
        limits.validate()?;
        let mut model = Self {
            session,
            limits,
            now: ModelInstant(0),
            closed: false,
            clock_fault: false,
            identity: Arc::new(()),
            sequence: 0,
            leases: BTreeMap::new(),
            admissions: BTreeMap::new(),
            inspections: BTreeMap::new(),
            call_inspections: BTreeMap::new(),
            mutation_bytes: 0,
            read_bytes: 0,
            handles: BTreeMap::new(),
            observations: BTreeMap::new(),
            recovery_required: false,
            cancels: BTreeMap::new(),
            projection: ProjectionState::new(),
            subscriptions: BTreeMap::new(),
            attaches: BTreeMap::new(),
            controls: BTreeMap::new(),
            subscription_sequence: 0,
            workflow: None,
            reconciliation_ids: BTreeMap::new(),
        };
        require(
            projection::fits_bound(
                model.projection_bound(model.projection.budget)?,
                model.limits.projection_limit,
            ),
            ModelError::Capacity,
        )?;
        model.can_charge(Role::Read, DESCRIPTOR_BYTES)?;
        model.charge(Role::Read, DESCRIPTOR_BYTES);
        model.validate_snapshot(
            &model.snapshot_value(&model.projection.current, None)?,
            model.projection.budget,
        )?;
        Ok(model)
    }
    pub fn advance_to(&mut self, now: ModelInstant) -> Result<(), ModelError> {
        if now.0 < self.now.0 {
            self.clock_fault = true;
            return Err(ModelError::ClockFault);
        }
        self.now = now;
        Ok(())
    }
    pub fn now(&self) -> ModelInstant {
        self.now
    }
    pub fn close(&mut self) -> Result<(), ModelError> {
        if self.closed {
            return Ok(());
        }
        let publication =
            self.prepare_publication(&ProjectionEvent::Close, self.projection.budget)?;
        self.closed = true;
        self.commit_publication(publication, None);
        Ok(())
    }
    pub fn stats(&self) -> ModelStats {
        ModelStats {
            mutation_admissions: self
                .admissions
                .values()
                .filter(|v| v.role == Role::Mutation)
                .count(),
            read_admissions: self
                .admissions
                .values()
                .filter(|v| v.role == Role::Read)
                .count(),
            mutation_leases: self
                .leases
                .values()
                .filter(|v| v.role == Role::Mutation)
                .count(),
            read_leases: self
                .leases
                .values()
                .filter(|v| v.role == Role::Read)
                .count(),
            admission_inspections: self.inspections.len(),
            call_inspections: self.call_inspections.len(),
            mutation_bytes: self.mutation_bytes,
            read_bytes: self.read_bytes,
            pending_dispatcher: self.admissions.values().any(|v| v.terminal.is_none()),
            closed: self.closed,
            clock_fault: self.clock_fault,
            operation_handles: self
                .handles
                .keys()
                .filter(|(r, _)| *r == Role::Mutation)
                .count(),
            read_handles: self
                .handles
                .keys()
                .filter(|(r, _)| *r == Role::Read)
                .count(),
            completed_handles: self
                .handles
                .values()
                .filter(|h| h.completion.is_some())
                .count(),
            operation_observations: self
                .observations
                .values()
                .filter(|o| o.role == Role::Mutation)
                .count(),
            read_observations: self
                .observations
                .values()
                .filter(|o| o.role == Role::Read)
                .count(),
            pending_operation_observations: self
                .observations
                .values()
                .filter(|o| o.role == Role::Mutation && o.pending)
                .count(),
            pending_read_observations: self
                .observations
                .values()
                .filter(|o| o.role == Role::Read && o.pending)
                .count(),
            recovery_required: self.recovery_required,
            cancel_requests: self.cancels.len(),
            pending_cancel_calls: self.cancels.values().filter(|c| !c.terminal).count(),
            cancel_notified_handles: self.handles.values().filter(|h| h.cancel_notified).count(),
            reconciliation_ids: self.reconciliation_ids.len(),
            workflow_phase: self.workflow_phase(),
            workflow_changes: self.workflow.as_ref().map_or(0, |m| m.records.len()),
            current_workflow: self.workflow.as_ref().and_then(|m| m.current.clone()),
            ever_clean_joined: self.workflow.as_ref().is_some_and(|m| m.ever_clean_joined),
            used_mutation_admission_ids: self.workflow_used_ids(),
            reserved_mutation_admission_ids: self.workflow_reserved_ids(),
            reserved_mutation_lease_ids: self.workflow_reserved_ids(),
            caller_operation_ids: self.workflow_caller_ids(),
            reserved_caller_operation_ids: self.workflow_reserved_caller_ids(),
            simulated_native_identities: self.workflow_native_ids(),
            reserved_simulated_native_identities: self.workflow_reserved_native_ids(),
            published_revision: self.projection.current.revision,
            reserved_revisions: self.projection.reserved,
            live_subscriptions: self.subscriptions.values().filter(|s| s.active).count(),
            attach_requests: self.attaches.len(),
            control_requests: self.controls.len(),
            queued_state_frames: self
                .subscriptions
                .values()
                .filter(|s| s.state.is_some())
                .count(),
            queued_control_frames: self.subscriptions.values().filter(|s| s.control).count(),
        }
    }
    fn qualify(&self, s: &ModelSession) -> Result<(), ModelError> {
        require(
            self.session.principal == s.principal && self.scope_matches(&s.scope),
            ModelError::Forbidden,
        )
    }
    fn scope_matches(&self, s: &Value) -> bool {
        s["ownerRef"] == self.session.scope["ownerRef"]
            && s["ownerEpoch"] == self.session.scope["ownerEpoch"]
            && self.context_matches(&s["context"])
    }
    fn context_matches(&self, v: &Value) -> bool {
        RecordingOperationsContext::from_value(v.clone())
            .is_ok_and(|c| same_recording_operations_context(&c, &self.session.context))
    }
    fn admission_matches_scope(&self, v: &Value) -> bool {
        v["ownerRef"] == self.session.scope["ownerRef"] && self.context_matches(&v["context"])
    }
    fn new_effect(&self) -> Result<(), ModelError> {
        require(!self.closed, ModelError::Closed)?;
        require(!self.clock_fault, ModelError::ClockFault)
    }
    fn can_charge(&self, role: Role, bytes: usize) -> Result<(), ModelError> {
        let (used, cap) = match role {
            Role::Mutation => (
                self.mutation_bytes,
                self.limits.total_bytes - self.limits.read_bytes,
            ),
            Role::Read => (self.read_bytes, self.limits.read_bytes),
        };
        require(
            used.checked_add(bytes).is_some_and(|v| v <= cap),
            ModelError::Capacity,
        )
    }
    fn charge(&mut self, role: Role, bytes: usize) {
        match role {
            Role::Mutation => self.mutation_bytes += bytes,
            Role::Read => self.read_bytes += bytes,
        }
    }
    fn ticket(&self, id: &str, sequence: u64) -> SimulationTicket {
        SimulationTicket {
            identity: Arc::clone(&self.identity),
            admission_id: id.to_owned(),
            sequence,
        }
    }
    fn record(&self, ticket: &SimulationTicket) -> Result<&AdmissionRecord, ModelError> {
        require(
            Arc::ptr_eq(&ticket.identity, &self.identity),
            ModelError::Forbidden,
        )?;
        self.admissions
            .get(&ticket.admission_id)
            .filter(|r| r.sequence == ticket.sequence)
            .ok_or(ModelError::InvalidInput)
    }
}
fn require(ok: bool, error: ModelError) -> Result<(), ModelError> {
    if ok {
        Ok(())
    } else {
        Err(error)
    }
}
fn bytes(v: &Value) -> Result<usize, ModelError> {
    conservative_recording_json_bound(v, WIRE_INSPECTION_REPLY_LIMIT)
        .map(|b| b.bytes)
        .map_err(|_| ModelError::InvalidInput)
}
fn sum(a: usize, b: usize) -> Result<usize, ModelError> {
    a.checked_add(b).ok_or(ModelError::Capacity)
}
// Only bounded validated JSON proof/outcome payloads. Integers are all safe JSON numbers.
fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_value(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, a)| b.get(k).is_some_and(|b| same_value(a, b)))
        }
        _ => a == b,
    }
}
fn admission_role(v: &Value) -> Role {
    if v["action"]["kind"] == "reconcile" {
        Role::Read
    } else {
        Role::Mutation
    }
}
#[cfg(test)]
mod tests;
