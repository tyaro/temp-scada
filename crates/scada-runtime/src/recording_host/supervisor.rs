//! Owns one recording Host and one same-store preflight lease. Every step is explicit.
mod preflight;
mod types;
use super::{
    RecordingCompletion, RecordingHost, RecordingHostError, RecordingHostStatus, RecordingOptions,
    RecordingPhase, RecordingPlanGuardSnapshot, RecordingPlanTurnCompletion,
    RecordingPlanTurnIntent, RecordingPlanTurnRun, RecordingRun, RetentionGuardSnapshot,
};
use crate::recorder_source::SdkRecorderPlan;
use banto_tagclient::RestClient;
use preflight::{BoundRequest, PreflightOwner};
use scada_historian::{
    recorder::ManagedRecorderStart,
    store::{query::QueryControl, SqliteStore},
};
use std::sync::Arc;
use tokio::sync::watch;
pub use types::*;

pub struct RecordingSupervisor {
    host: RecordingHost,
    preflight: PreflightOwner,
}
impl RecordingSupervisor {
    pub fn try_new(store: SqliteStore) -> Result<Self, Box<SupervisorInitError>> {
        match store.reader() {
            Ok(reader) => Ok(Self {
                host: RecordingHost::new(store),
                preflight: PreflightOwner::new(reader),
            }),
            Err(error) => Err(Box::new(SupervisorInitError { error, store })),
        }
    }
    pub fn state(&self) -> SupervisorState {
        SupervisorState {
            recording: self.host.state(),
            preflight_phase: self.preflight.phase(),
            preflight_run: self.preflight.run(),
            candidate_phase: self.preflight.candidate,
        }
    }
    pub fn recording_watch(&self) -> watch::Receiver<Arc<RecordingHostStatus>> {
        self.host.state_watch()
    }
    pub fn recording_plan_guard_state(&self) -> RecordingPlanGuardSnapshot {
        self.host.recording_plan_guard_state()
    }
    pub fn retention_guard_state(&self) -> RetentionGuardSnapshot {
        self.host.retention_guard_state()
    }
    fn require_start(&self) -> Result<(), SupervisorError> {
        self.preflight.require_idle()?;
        if self.preflight.pending_candidate() {
            return Err(SupervisorError::Busy);
        }
        Ok(())
    }
    pub fn start(
        &mut self,
        plan: SdkRecorderPlan,
        options: RecordingOptions,
        client: RestClient,
    ) -> Result<RecordingRun, SupervisorError> {
        self.require_start()?;
        let run = self.host.start(plan, options, client)?;
        self.preflight.clear_result();
        Ok(run)
    }
    pub fn start_managed(
        &mut self,
        plan: SdkRecorderPlan,
        options: RecordingOptions,
        binding: ManagedRecorderStart,
        control: QueryControl,
        client: RestClient,
    ) -> Result<RecordingRun, SupervisorError> {
        self.require_start()?;
        let run = self
            .host
            .start_managed(plan, options, binding, control, client)?;
        self.preflight.clear_result();
        Ok(run)
    }
    fn check_run(&self, run: &RecordingRun) -> Result<(), SupervisorError> {
        if self.host.state().run.as_ref() != Some(run) {
            return Err(SupervisorError::ContextMismatch);
        }
        Ok(())
    }
    /// Safety stop is available even after a preflight reader failure.
    pub fn request_stop_recording(&mut self, run: &RecordingRun) -> Result<(), SupervisorError> {
        self.check_run(run)?;
        self.host.request_stop();
        Ok(())
    }
    pub async fn join_recording(
        &mut self,
        run: &RecordingRun,
    ) -> Result<Arc<RecordingCompletion>, SupervisorError> {
        self.check_run(run)?;
        Ok(self.host.join().await?)
    }
    pub fn start_preflight(
        &mut self,
        intent: RecordingPlanTurnIntent,
        control: QueryControl,
    ) -> Result<PreflightRun, SupervisorError> {
        self.preflight.require_idle()?;
        if self.preflight.pending_candidate()
            || self.host.retention.running.is_some()
            || self.host.plan_turn.running.is_some()
        {
            return Err(SupervisorError::Busy);
        }
        let state = self.host.state();
        if !matches!(
            state.phase,
            RecordingPhase::Running | RecordingPhase::Joined
        ) {
            return Err(SupervisorError::NoRecording);
        }
        if state.phase == RecordingPhase::Joined {
            self.host.require_paused_store()?;
        }
        if self.host.plan_turn.recovery_required {
            return Err(RecordingHostError::PlanRecoveryRequired.into());
        }
        if self.host.retention.job_pending {
            return Err(RecordingHostError::RetentionPending.into());
        }
        if self.host.retention.rearm_required {
            return Err(RecordingHostError::RetentionRearmRequired.into());
        }
        let recording_run = state.run.clone().ok_or(SupervisorError::NoRecording)?;
        let session_id = state
            .session_id
            .clone()
            .ok_or(SupervisorError::NoRecording)?;
        intent.validate().map_err(SupervisorError::Request)?;
        self.preflight.start(
            BoundRequest {
                recording_run,
                session_id,
                intent,
            },
            control,
        )
    }
    pub fn cancel_preflight(&mut self, run: &PreflightRun) -> Result<(), SupervisorError> {
        self.preflight.cancel(run)
    }
    pub async fn join_preflight(
        &mut self,
        run: &PreflightRun,
    ) -> Result<Arc<PreflightCompletion>, SupervisorError> {
        self.preflight.join(run).await
    }
    fn candidate(&self, run: &PreflightRun) -> Result<&BoundRequest, SupervisorError> {
        if self.preflight.running.is_some() {
            return Err(SupervisorError::Busy);
        }
        let completion = self.preflight.completed(run)?;
        let active = completion
            .outcome
            .as_ref()
            .ok()
            .and_then(PreflightReport::candidate)
            .ok_or(SupervisorError::NoCandidate)?;
        let bound = self
            .preflight
            .bound
            .as_ref()
            .ok_or(SupervisorError::NoCandidate)?;
        self.check_run(&bound.recording_run)?;
        if self.host.state().session_id.as_deref() != Some(bound.session_id.as_str()) {
            return Err(SupervisorError::ContextMismatch);
        }
        if active.as_ref().is_some_and(|s| s != &bound.session_id) {
            return Err(SupervisorError::ContextMismatch);
        }
        Ok(bound)
    }
    pub fn request_pause(&mut self, run: &PreflightRun) -> Result<(), SupervisorError> {
        self.candidate(run)?;
        match self.preflight.candidate {
            Some(CandidatePhase::Candidate) => {
                self.host.request_stop();
                self.preflight.candidate = Some(CandidatePhase::PauseRequested);
                Ok(())
            }
            Some(CandidatePhase::PauseRequested | CandidatePhase::Paused) => Ok(()),
            Some(CandidatePhase::Submitted) => Err(SupervisorError::CandidateConsumed),
            None => Err(SupervisorError::NoCandidate),
        }
    }
    pub async fn join_pause(
        &mut self,
        run: &PreflightRun,
    ) -> Result<Arc<RecordingCompletion>, SupervisorError> {
        self.candidate(run)?;
        match self.preflight.candidate {
            Some(CandidatePhase::PauseRequested | CandidatePhase::Paused) => {}
            Some(CandidatePhase::Submitted) => return Err(SupervisorError::CandidateConsumed),
            _ => return Err(SupervisorError::PauseRequired),
        }
        let completion = self.host.join().await?;
        self.host.require_paused_store()?;
        self.preflight.candidate = Some(CandidatePhase::Paused);
        Ok(completion)
    }
    /// The caller supplies no replacement intent here; only the saved candidate can execute.
    pub fn execute_candidate(
        &mut self,
        run: &PreflightRun,
        control: QueryControl,
    ) -> Result<RecordingPlanTurnRun, SupervisorError> {
        let bound = self.candidate(run)?.clone();
        match self.preflight.candidate {
            Some(CandidatePhase::Paused) => {}
            Some(CandidatePhase::Submitted) => return Err(SupervisorError::CandidateConsumed),
            _ => return Err(SupervisorError::PauseRequired),
        }
        let turn =
            self.host
                .start_recording_plan_turn(&bound.recording_run, bound.intent, control)?;
        self.preflight.candidate = Some(CandidatePhase::Submitted);
        Ok(turn)
    }
    pub fn discard_candidate(&mut self, run: &PreflightRun) -> Result<(), SupervisorError> {
        self.candidate(run)?;
        if self.host.plan_turn.running.is_some()
            || (self.preflight.candidate == Some(CandidatePhase::PauseRequested)
                && self.host.running.is_some())
        {
            return Err(SupervisorError::Busy);
        }
        if self.preflight.candidate == Some(CandidatePhase::Submitted) {
            return Err(SupervisorError::CandidateConsumed);
        }
        self.preflight.clear_result();
        Ok(())
    }
    pub fn cancel_recording_plan_turn(
        &mut self,
        run: &RecordingPlanTurnRun,
    ) -> Result<(), SupervisorError> {
        Ok(self.host.cancel_recording_plan_turn(run)?)
    }
    pub async fn join_recording_plan_turn(
        &mut self,
        run: &RecordingPlanTurnRun,
    ) -> Result<Arc<RecordingPlanTurnCompletion>, SupervisorError> {
        Ok(self.host.join_recording_plan_turn(run).await?)
    }
    /// Explicit recovery transfer. Retire the dedicated lease only after writer recovery succeeds.
    pub fn take_store(&mut self) -> Result<SqliteStore, SupervisorError> {
        if self.preflight.running.is_some() {
            return Err(SupervisorError::Busy);
        }
        let store = self.host.take_store()?;
        self.preflight.reader.take();
        self.preflight.clear_result();
        Ok(store)
    }
}

#[cfg(test)]
pub(super) mod tests;
