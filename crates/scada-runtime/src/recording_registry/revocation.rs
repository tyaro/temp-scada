//! Authorization revocation: a revoked session grant can start nothing new, while accepted
//! native operations keep being monitored by the root.
use super::{LeaseError, RecordingRegistryRoot, RecordingRegistrySession};
use std::sync::Arc;

impl RecordingRegistryRoot {
    /// Revokes the host grant behind `session` and all of its clones; it cannot be withdrawn.
    /// Every later call with that grant is `Unauthorized`: no new lease, workflow, admission,
    /// dispatch, or cancel, and no re-fetch of earlier replies, snapshots, or frames, because
    /// disclosure to a revoked caller is a host decision.
    ///
    /// Revocation never touches native state. Accepted native operations are neither cancelled
    /// nor joined; their set-once completions, original replies, recovery evidence, and
    /// subscriptions stay bound to the principal, and a session the host issues again for that
    /// principal keeps serving them. A registered admission never dispatched stays registered
    /// for such a session or for `begin_shutdown`. Allowed while draining and after close;
    /// idempotent.
    pub fn revoke_session(&mut self, session: &RecordingRegistrySession) -> Result<(), LeaseError> {
        if !Arc::ptr_eq(&self.identity, &session.root_identity) {
            return Err(LeaseError::Forbidden);
        }
        self.revoked_grants.retain(|grant| grant.strong_count() > 0);
        if !self.grant_revoked(&session.grant) {
            self.revoked_grants.push(Arc::downgrade(&session.grant));
        }
        Ok(())
    }
}
