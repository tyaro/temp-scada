use super::*;
use serde::Serialize;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModelInstant(pub u64);
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimulatedPrincipal(String);
impl SimulatedPrincipal {
    pub fn new(id: &str) -> Result<Self, ModelError> {
        require(
            !id.is_empty()
                && id.len() <= 64
                && id.as_bytes()[0].is_ascii_alphanumeric()
                && id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c)),
            ModelError::InvalidInput,
        )?;
        Ok(Self(id.to_owned()))
    }
}
#[derive(Clone, Debug)]
pub struct ModelSession {
    pub(super) scope: Value,
    pub(super) context: RecordingOperationsContext,
    pub(super) principal: SimulatedPrincipal,
}
impl ModelSession {
    pub fn new(scope: Value, principal: SimulatedPrincipal) -> Result<Self, ModelError> {
        // Bound raw input before json! serializes/copies it into the validation envelope.
        conservative_recording_json_bound(&scope, WIRE_REQUEST_LIMIT)
            .map_err(|_| ModelError::InvalidInput)?;
        // Validation-only envelope; this creates no lease or model effect.
        RecordingWireLeaseRequest::from_value(json!({"version":1,"kind":"recordingWireLeaseRequest","scope":scope,"leaseRequestId":"validation","admissionId":"validation","role":"mutation","requestedBudgetMs":1})).map_err(|_|ModelError::InvalidInput)?;
        let context = RecordingOperationsContext::from_value(scope["context"].clone())
            .map_err(|_| ModelError::InvalidInput)?;
        Ok(Self {
            scope,
            context,
            principal,
        })
    }
    pub fn scope(&self) -> &Value {
        &self.scope
    }
}
#[derive(Clone, Debug)]
pub struct SimulationTicket {
    pub(super) identity: Arc<()>,
    pub(super) admission_id: String,
    pub(super) sequence: u64,
}
#[derive(Clone, Debug)]
pub enum AdmissionStart {
    Registered { ticket: SimulationTicket },
    Pending { ticket: SimulationTicket },
    Replay { reply: RecordingAdmissionReply },
}
#[derive(Clone, Debug)]
pub enum SimulatedDecision {
    Accepted(RecordingAdmissionReply),
    Rejected(RecordingAdmissionReply),
    CompletedDiscard(RecordingAdmissionReply),
}
/// Simulation-only opaque capability. Not serializable or constructible from a JSON ref.
#[derive(Clone, Debug)]
pub struct SimulatedHandleTicket {
    pub(super) identity: Arc<()>,
    pub(super) admission_id: String,
    pub(super) sequence: u64,
    pub(super) key: HandleKey,
}
#[derive(Clone, Debug)]
pub enum SimulatedCompletion {
    Operation(scada_model::recording_operations::RecordingOperationResult),
    Reconciliation(RecordingReconciliationDelivery),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum ModelError {
    InvalidInput,
    Forbidden,
    ProtocolViolation,
    Capacity,
    Busy,
    Expired,
    ClockFault,
    Closed,
}
impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Registry model: {self:?}")
    }
}
impl std::error::Error for ModelError {}
#[derive(Clone, Copy, Debug)]
pub struct ModelLimits {
    pub mutation_admissions: usize,
    pub read_admissions: usize,
    pub mutation_leases: usize,
    pub read_leases: usize,
    pub unconsumed_leases: usize,
    pub admission_inspections: usize,
    pub call_inspections: usize,
    pub operation_observations: usize,
    pub read_observations: usize,
    pub pending_operation_observations: usize,
    pub pending_read_observations: usize,
    pub total_bytes: usize,
    pub read_bytes: usize,
}
impl Default for ModelLimits {
    fn default() -> Self {
        Self {
            mutation_admissions: 4096,
            read_admissions: 4096,
            mutation_leases: 4096,
            read_leases: 4096,
            unconsumed_leases: 4,
            admission_inspections: 4096,
            call_inspections: 4096,
            operation_observations: 4096,
            read_observations: 4096,
            pending_operation_observations: 2,
            pending_read_observations: 2,
            total_bytes: 8 * 1024 * 1024,
            read_bytes: 2 * 1024 * 1024,
        }
    }
}
impl ModelLimits {
    pub(super) fn validate(&self) -> Result<(), ModelError> {
        require(
            [
                self.mutation_admissions,
                self.read_admissions,
                self.mutation_leases,
                self.read_leases,
                self.admission_inspections,
                self.call_inspections,
                self.operation_observations,
                self.read_observations,
            ]
            .iter()
            .all(|n| *n <= 4096)
                && self.pending_operation_observations <= 2
                && self.pending_read_observations <= 2
                && self.unconsumed_leases <= 4
                && self.total_bytes <= 8 * 1024 * 1024
                && self.read_bytes <= 2 * 1024 * 1024
                && self.read_bytes <= self.total_bytes,
            ModelError::InvalidInput,
        )
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStats {
    pub mutation_admissions: usize,
    pub read_admissions: usize,
    pub mutation_leases: usize,
    pub read_leases: usize,
    pub admission_inspections: usize,
    pub call_inspections: usize,
    pub mutation_bytes: usize,
    pub read_bytes: usize,
    pub pending_dispatcher: bool,
    pub closed: bool,
    pub clock_fault: bool,
    pub operation_handles: usize,
    pub read_handles: usize,
    pub completed_handles: usize,
    pub operation_observations: usize,
    pub read_observations: usize,
    pub pending_operation_observations: usize,
    pub pending_read_observations: usize,
    pub recovery_required: bool,
}
