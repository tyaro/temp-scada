//! Native recording registry ownership and real-clock lease boundary.
//! Product session issuance, admission, and transport remain unconnected.
pub(crate) mod kernel;
mod lease;
mod workflow;
use crate::recording_operations::{
    OwnerError, RecordingOperationsHandoff, RecordingOperationsOwner, RegistryClaimReason,
};
pub use lease::{
    LeaseError, LeaseRole, RecordingRegistryRoot, RecordingRegistrySession, RegistryRootInitFailure,
};
use std::fmt;
pub use workflow::{
    PreflightRegistration, RecordingRegistryAdmissionTicket, RecordingRegistryWorkflowTicket,
};

/// Consumes a pristine native owner before any external client has been issued.
/// The later registry root can add scope, lease, and admission without a bypassing client.
pub struct RecordingRegistryOwnerSeed {
    owner: RecordingOperationsOwner,
}

pub struct RecordingRegistryClaimFailure {
    pub reason: RegistryClaimReason,
    pub owner: RecordingOperationsOwner,
}

impl fmt::Debug for RecordingRegistryClaimFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RecordingRegistryClaimFailure")
            .field("reason", &self.reason)
            .field("owner", &"RecordingOperationsOwner(..)")
            .finish()
    }
}

impl RecordingRegistryOwnerSeed {
    pub fn try_from_owner(
        owner: RecordingOperationsOwner,
    ) -> Result<Self, RecordingRegistryClaimFailure> {
        if let Err(reason) = owner.check_registry_claim() {
            return Err(RecordingRegistryClaimFailure { reason, owner });
        }
        Ok(Self { owner })
    }

    /// Returns native ownership only through the existing quiescence and recovery gate.
    pub fn try_handoff(&mut self) -> Result<RecordingOperationsHandoff, OwnerError> {
        self.owner.try_handoff()
    }

    pub(crate) fn context(&self) -> &scada_model::recording_operations::RecordingOperationsContext {
        self.owner.registry_context()
    }

    pub(crate) fn check_claim(&self) -> Result<(), RegistryClaimReason> {
        self.owner.check_registry_claim()
    }

    pub(crate) fn initial_workflow_eligible(&self) -> Result<bool, RegistryClaimReason> {
        self.owner.registry_initial_workflow_eligible()
    }
}
