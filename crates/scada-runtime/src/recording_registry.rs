//! Exclusive owner handoff and pure budget kernel for the future recording registry.
//! No session issuer, lease, admission, or transport is exposed here.
pub(crate) mod kernel;
use crate::recording_operations::{
    OwnerError, RecordingOperationsHandoff, RecordingOperationsOwner, RegistryClaimReason,
};
use std::fmt;

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
}
