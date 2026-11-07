//! Management-side shutdown: stop new acceptance, keep monitoring, return ownership by handoff.
use super::lease::RecordingRegistryRoot;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegistryLifecycle {
    /// New leases, workflows, and admissions are accepted.
    Open,
    /// Shutdown was requested; native ownership is still held until `try_handoff` succeeds.
    Draining,
    /// Native ownership was handed off.
    Closed,
}

impl RecordingRegistryRoot {
    /// Stops new leases, workflow reservations, and admission registrations except discard,
    /// which only returns a Candidate or Paused owner toward quiescence. A registered
    /// preflight, pause/join, apply, or read never dispatched is settled as
    /// `rejected`/`cancelled` without a native call.
    /// Accepted native operations are neither cancelled nor joined: Observation, inspection,
    /// cancel, snapshots, and subscriptions keep serving them. Native ownership, the Supervisor,
    /// and recovery evidence return only through `try_handoff` and its existing gate.
    /// Idempotent; shutdown cannot be withdrawn.
    pub fn begin_shutdown(&mut self) {
        self.shutdown = true;
        if let Some(workflow) = self.workflow.as_mut() {
            if let Some(preflight) = workflow.registered.as_mut() {
                preflight.cancel_undispatched();
            }
            if let Some(pause) = workflow
                .pause_lease
                .as_mut()
                .and_then(|pause| pause.registered.as_mut())
            {
                pause.cancel_undispatched();
            }
            if let Some(apply) = workflow
                .apply_lease
                .as_mut()
                .and_then(|apply| apply.registered.as_mut())
            {
                apply.cancel_undispatched();
            }
        }
        for read in &mut self.reconciliations {
            read.cancel_undispatched();
        }
    }

    pub fn lifecycle(&self) -> RegistryLifecycle {
        if self.closed {
            RegistryLifecycle::Closed
        } else if self.shutdown {
            RegistryLifecycle::Draining
        } else {
            RegistryLifecycle::Open
        }
    }
}
