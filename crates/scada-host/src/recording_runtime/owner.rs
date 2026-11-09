//! The recording owner of the desktop host (product-owner design §4, §5,
//! §6; C5-3): the registry root installed over a running recording, taken
//! back by its handoff, and the stop and exit of the recording.
//!
//! The Supervisor has one holder at a time. While a root is installed it is
//! inside the root's native owner, and the runtime keeps only its status
//! watch; [`RecordingRuntime::inspect`] then reads the DB with the History
//! host's reader. Every change of the slot runs under the transition lock
//! the caller holds.
use std::time::Duration;

use scada_model::recording_operations::RecordingOperationsContext;
use scada_model::Project;
use scada_runtime::recording_host::{RecordingPhase, RecordingRun, RecordingSupervisor};
use scada_runtime::recording_operations::{OwnerError, RecordingOperationsOwner};
use scada_runtime::recording_registry::{RecordingRegistryOwnerSeed, RegistryRootInitFailure};
use serde_json::json;

use super::{lock, RecordingRuntime};
use crate::auth_phase::PhaseGuard;
use crate::recording_epoch::{create_recording_root, RootCreateError};
use crate::recording_gate::{RecordingGate, NO_RECORDING_RUN, OWNER_UNAVAILABLE};

/// Why a stop did not run. `as_str` is the command's error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopFailure {
    Unavailable,
    /// No recording to stop (idle or already joined).
    NotAllowed,
    /// The installed root holds unsettled work (a Candidate or Paused
    /// change, an undelivered dispatch): nothing was changed.
    Busy,
    /// The stop was requested but the recording did not end within the wait.
    Failed,
}

impl StopFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::NotAllowed => "not_allowed",
            Self::Busy => "busy",
            Self::Failed => "failed",
        }
    }
}

/// How the exit sequence ended (design §6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitOutcome {
    /// Nothing was recording, or the recording was stopped and joined.
    Stopped,
    /// The root stayed unsettled past the wait. The process exits with the
    /// recording running; the next start finds its session interrupted.
    Interrupted,
}

/// How long a stop waits for the recording to end.
const STOP_WAIT: Duration = Duration::from_secs(10);
/// How often the exit asks an unsettled root again.
const EXIT_POLL: Duration = Duration::from_millis(50);

/// The Supervisor of a native owner that was never handed to a client.
fn recover(mut owner: RecordingOperationsOwner) -> Option<RecordingSupervisor> {
    owner.try_handoff().ok().map(|h| h.supervisor)
}

fn recover_seed(mut seed: RecordingRegistryOwnerSeed) -> Option<RecordingSupervisor> {
    seed.try_handoff().ok().map(|h| h.supervisor)
}

impl RecordingRuntime {
    /// Install a registry root over the running recording (design §4, §5).
    /// Only a `Running` recording is taken; the Supervisor goes into a new
    /// native owner, its seed into a root with a new owner epoch, and the
    /// root into `gate`'s slot. Any failure gives the Supervisor back, leaves
    /// the recording running and the slot empty with `owner_unavailable`.
    /// Returns the root's generation.
    pub async fn install_owner(
        &self,
        gate: &RecordingGate,
        phase: &PhaseGuard<'_>,
        project: &Project,
    ) -> Result<u64, &'static str> {
        let ready = self.state.as_ref().map_err(|reason| *reason)?;
        let mut slot = ready.supervisor.lock().await;
        let Some(supervisor) = slot.take() else {
            return Err(OWNER_UNAVAILABLE);
        };
        let status = supervisor.state().recording;
        let (Some(run), Some(session), RecordingPhase::Running) =
            (status.run.clone(), status.session_id.clone(), status.phase)
        else {
            *slot = Some(supervisor);
            gate.set_empty_reason(phase, OWNER_UNAVAILABLE);
            return Err(OWNER_UNAVAILABLE);
        };
        let watch = supervisor.recording_watch();
        match self.build_root(ready, supervisor, project, run, &session) {
            Ok((root, issuer, scope)) => match gate.install(phase, root, issuer, scope) {
                Ok(installed) => {
                    *lock(&ready.lent) = Some(watch);
                    Ok(installed.generation)
                }
                Err(refused) => {
                    let (mut root, _) = *refused;
                    *slot = root.try_handoff().ok().map(|h| h.supervisor);
                    Err(OWNER_UNAVAILABLE)
                }
            },
            Err(supervisor) => {
                *slot = supervisor.map(|supervisor| *supervisor);
                gate.set_empty_reason(phase, OWNER_UNAVAILABLE);
                Err(OWNER_UNAVAILABLE)
            }
        }
    }

    /// The owner and root over `supervisor`, or the Supervisor back.
    fn build_root(
        &self,
        ready: &super::Ready,
        supervisor: RecordingSupervisor,
        project: &Project,
        run: RecordingRun,
        session: &str,
    ) -> Result<
        (
            scada_runtime::recording_registry::RecordingRegistryRoot,
            scada_runtime::recording_registry::RecordingSessionIssuer,
            serde_json::Value,
        ),
        Option<Box<RecordingSupervisor>>,
    > {
        let target = self
            .management_context(project)
            .expect("ready runtime has a context");
        let context = RecordingOperationsContext::from_value(json!({
            "version": 1,
            "kind": "recordingOperationsContext",
            "target": target,
            "capabilityId": format!("capability:{}", uuid::Uuid::new_v4()),
            "recordingRunRef": lock(&ready.runs).get(Some(&run)),
            "sessionId": session,
        }));
        let Ok(context) = context else {
            return Err(Some(Box::new(supervisor)));
        };
        let owner = match RecordingOperationsOwner::try_new(supervisor, context.clone(), run) {
            Ok(owner) => owner,
            Err(failure) => return Err(Some(Box::new(failure.supervisor))),
        };
        let seed = match RecordingRegistryOwnerSeed::try_from_owner(owner) {
            Ok(seed) => seed,
            Err(failure) => return Err(recover(failure.owner).map(Box::new)),
        };
        match create_recording_root(&ready.data_dir, seed, context.as_value().clone()) {
            Ok((root, issuer, generation)) => {
                Ok((root, issuer, generation.scope(context.as_value().clone())))
            }
            Err(RootCreateError::Generation { seed, .. })
            | Err(RootCreateError::Root(RegistryRootInitFailure { seed, .. })) => {
                Err(recover_seed(seed).map(Box::new))
            }
        }
    }

    /// Take the Supervisor back from `gate`'s root by its handoff (design
    /// §4), leaving the slot empty with `no_recording_run`. `Ok(false)` when
    /// no root was installed; `Err` (nothing changed) while the root is
    /// unsettled.
    pub async fn take_owner(
        &self,
        gate: &RecordingGate,
        phase: &PhaseGuard<'_>,
    ) -> Result<bool, OwnerError> {
        let Ok(ready) = self.state.as_ref() else {
            return Ok(false);
        };
        let mut slot = ready.supervisor.lock().await;
        let Some(handoff) = gate.try_take(phase, NO_RECORDING_RUN)? else {
            return Ok(false);
        };
        *slot = Some(handoff.supervisor);
        *lock(&ready.lent) = None;
        Ok(true)
    }

    /// `recording_stop` (design §5): take the Supervisor back from an
    /// installed root, then stop the recording and join it, without
    /// changing the plan. Returns the recording phase reached.
    pub async fn stop(
        &self,
        gate: &RecordingGate,
        phase: &PhaseGuard<'_>,
    ) -> Result<&'static str, StopFailure> {
        let ready = self.state.as_ref().map_err(|_| StopFailure::Unavailable)?;
        self.take_owner(gate, phase)
            .await
            .map_err(|_| StopFailure::Busy)?;
        let mut slot = ready.supervisor.lock().await;
        let supervisor = slot.as_mut().ok_or(StopFailure::Unavailable)?;
        stop_and_join(supervisor).await
    }

    /// The exit sequence (design §6): stop new registry work, take the
    /// Supervisor back by the handoff, then stop and join the recording,
    /// all within `limit`. A root that stays unsettled (a Candidate, a
    /// Paused change, an accepted operation still running) is left as it
    /// is: the recording is not stopped and the next start finds its
    /// session interrupted, or (Paused) already ended.
    pub async fn exit(
        &self,
        gate: Option<&RecordingGate>,
        phase: &PhaseGuard<'_>,
        limit: Duration,
    ) -> ExitOutcome {
        let Ok(ready) = self.state.as_ref() else {
            return ExitOutcome::Stopped;
        };
        let sequence = async {
            if let Some(gate) = gate {
                gate.begin_shutdown();
                loop {
                    match self.take_owner(gate, phase).await {
                        Ok(_) => break,
                        Err(OwnerError::Busy) => tokio::time::sleep(EXIT_POLL).await,
                        Err(_) => return ExitOutcome::Interrupted,
                    }
                }
            }
            let mut slot = ready.supervisor.lock().await;
            match slot.as_mut() {
                Some(supervisor) => match stop_and_join(supervisor).await {
                    Ok(_) | Err(StopFailure::NotAllowed) => ExitOutcome::Stopped,
                    Err(_) => ExitOutcome::Interrupted,
                },
                None => ExitOutcome::Interrupted,
            }
        };
        tokio::time::timeout(limit, sequence)
            .await
            .unwrap_or(ExitOutcome::Interrupted)
    }
}

/// Stop the Supervisor's recording and join it. A recording that already
/// ended by itself is joined only.
async fn stop_and_join(supervisor: &mut RecordingSupervisor) -> Result<&'static str, StopFailure> {
    let status = supervisor.state().recording;
    let run = status.run.clone().ok_or(StopFailure::NotAllowed)?;
    match status.phase {
        RecordingPhase::Starting | RecordingPhase::Running => {
            supervisor
                .request_stop_recording(&run)
                .map_err(|_| StopFailure::Failed)?;
        }
        RecordingPhase::Stopping | RecordingPhase::FinishedUnjoined | RecordingPhase::Faulted => {}
        _ => return Err(StopFailure::NotAllowed),
    }
    match tokio::time::timeout(STOP_WAIT, supervisor.join_recording(&run)).await {
        Ok(Ok(_)) => Ok("joined"),
        _ => Err(StopFailure::Failed),
    }
}
