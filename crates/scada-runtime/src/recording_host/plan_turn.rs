//! One explicit configuration commit on a joined, cleanly paused recording owner.
use std::{fmt, sync::Arc};

use super::{RecordingHost, RecordingHostError, RecordingPhase, RecordingRun};
use scada_historian::store::{
    query::{CancellationToken, QueryControl},
    recording_plan::{
        ApplyRecordingPlanRequest, MappingReceipt, RecordingPlanReceipt, RegisterMappingRequest,
    },
    SqliteStore, StoreResult,
};
use tokio::task::JoinHandle;

/// Process-local identity of one accepted turn. Never persist or reconstruct it.
#[derive(Clone)]
pub struct RecordingPlanTurnRun(Arc<()>);
impl PartialEq for RecordingPlanTurnRun {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
impl Eq for RecordingPlanTurnRun {}
impl fmt::Debug for RecordingPlanTurnRun {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecordingPlanTurnRun(..)")
    }
}
#[derive(Clone, Debug)]
pub enum RecordingPlanTurnIntent {
    RegisterMapping(RegisterMappingRequest),
    Apply(ApplyRecordingPlanRequest),
}
impl RecordingPlanTurnIntent {
    pub(super) fn validate(&self) -> StoreResult<()> {
        match self {
            Self::RegisterMapping(r) => r.validate(),
            Self::Apply(r) => r.validate(),
        }
    }
    fn execute(
        &self,
        store: &mut SqliteStore,
        control: &QueryControl,
    ) -> StoreResult<RecordingPlanTurnReceipt> {
        match self {
            Self::RegisterMapping(r) => store
                .register_recording_mapping(r, control)
                .map(RecordingPlanTurnReceipt::Mapping),
            Self::Apply(r) => store
                .apply_recording_plan(r, control)
                .map(RecordingPlanTurnReceipt::Applied),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordingPlanTurnReceipt {
    Mapping(MappingReceipt),
    Applied(RecordingPlanReceipt),
}
/// Ok on join means the worker joined; inspect outcome for commit success.
#[derive(Debug)]
pub struct RecordingPlanTurnCompletion {
    pub run: RecordingPlanTurnRun,
    pub recording_run: RecordingRun,
    pub outcome: StoreResult<RecordingPlanTurnReceipt>,
}
/// Last successful turn of one kind, including its original process-local owners.
#[derive(Clone, Debug)]
pub struct RecordingPlanTurnSuccess<R> {
    pub run: RecordingPlanTurnRun,
    pub recording_run: RecordingRun,
    pub receipt: R,
}
#[derive(Clone, Debug)]
pub struct RecordingPlanGuardSnapshot {
    /// Sticky after any native operation error. False does not prove SDK liveness.
    pub recovery_required: bool,
    pub last_mapping: Option<RecordingPlanTurnSuccess<MappingReceipt>>,
    pub last_applied: Option<RecordingPlanTurnSuccess<RecordingPlanReceipt>>,
}
#[derive(Default)]
pub(super) struct PlanOwner {
    pub running: Option<PlanRunning>,
    pub recovery_required: bool,
    completion: Option<Arc<RecordingPlanTurnCompletion>>,
    last_mapping: Option<RecordingPlanTurnSuccess<MappingReceipt>>,
    last_applied: Option<RecordingPlanTurnSuccess<RecordingPlanReceipt>>,
}
pub(super) struct PlanRunning {
    run: RecordingPlanTurnRun,
    cancel: CancellationToken,
    task: JoinHandle<TurnResult>,
}
struct TurnResult {
    store: SqliteStore,
    completion: RecordingPlanTurnCompletion,
}
impl PlanOwner {
    pub fn clear_completion(&mut self) {
        self.completion = None;
    }
}

impl RecordingHost {
    pub fn recording_plan_guard_state(&self) -> RecordingPlanGuardSnapshot {
        RecordingPlanGuardSnapshot {
            recovery_required: self.plan_turn.recovery_required,
            last_mapping: self.plan_turn.last_mapping.clone(),
            last_applied: self.plan_turn.last_applied.clone(),
        }
    }
    /// Accept exactly one register OR apply, bound to the latest joined recording.
    /// No stop, queue, preflight, automatic retry or recording resume is implied.
    pub fn start_recording_plan_turn(
        &mut self,
        recording_run: &RecordingRun,
        intent: RecordingPlanTurnIntent,
        control: QueryControl,
    ) -> Result<RecordingPlanTurnRun, RecordingHostError> {
        self.start_plan_turn_with(
            recording_run,
            intent,
            control,
            RecordingPlanTurnIntent::execute,
        )
    }

    pub(super) fn start_plan_turn_with(
        &mut self,
        recording_run: &RecordingRun,
        intent: RecordingPlanTurnIntent,
        control: QueryControl,
        execute: impl FnOnce(
                &RecordingPlanTurnIntent,
                &mut SqliteStore,
                &QueryControl,
            ) -> StoreResult<RecordingPlanTurnReceipt>
            + Send
            + 'static,
    ) -> Result<RecordingPlanTurnRun, RecordingHostError> {
        self.require_paused_store()?;
        if self
            .completion
            .as_ref()
            .is_none_or(|c| &c.run != recording_run)
        {
            return Err(RecordingHostError::RecordingRunMismatch);
        }
        if self.retention.job_pending {
            return Err(RecordingHostError::RetentionPending);
        }
        if self.retention.rearm_required {
            return Err(RecordingHostError::RetentionRearmRequired);
        }
        intent.validate().map_err(RecordingHostError::PlanRequest)?;
        tokio::runtime::Handle::try_current().map_err(|_| RecordingHostError::NoRuntime)?;
        let run = RecordingPlanTurnRun(Arc::new(()));
        let worker_run = run.clone();
        let recording_run = recording_run.clone();
        let cancel = control.cancellation.clone();
        let mut store = self.store.take().expect("paused writer checked above");
        self.plan_turn.completion = None;
        let task = tokio::task::spawn_blocking(move || {
            let outcome = execute(&intent, &mut store, &control);
            TurnResult {
                store,
                completion: RecordingPlanTurnCompletion {
                    run: worker_run,
                    recording_run,
                    outcome,
                },
            }
        });
        self.plan_turn.running = Some(PlanRunning {
            run: run.clone(),
            cancel,
            task,
        });
        self.status
            .send_modify(|s| Arc::make_mut(s).phase = RecordingPhase::ManagingPlan);
        Ok(run)
    }
    /// Cancellation is cooperative, and never releases the request/writer slot.
    pub fn cancel_recording_plan_turn(
        &mut self,
        run: &RecordingPlanTurnRun,
    ) -> Result<(), RecordingHostError> {
        match &self.plan_turn.running {
            Some(r) if &r.run == run => {
                r.cancel.cancel();
                Ok(())
            }
            Some(_) => Err(RecordingHostError::PlanTurnMismatch),
            None if self
                .plan_turn
                .completion
                .as_ref()
                .is_some_and(|c| &c.run == run) =>
            {
                Ok(())
            }
            None => Err(RecordingHostError::PlanTurnMismatch),
        }
    }
    pub(super) fn cancel_plan_turn_on_drop(&self) {
        if let Some(r) = &self.plan_turn.running {
            r.cancel.cancel();
        }
    }
    /// Borrowed await: dropping this future retains the handle and writer here.
    /// Every native error latches recovery; it is not proof the commit happened.
    pub async fn join_recording_plan_turn(
        &mut self,
        run: &RecordingPlanTurnRun,
    ) -> Result<Arc<RecordingPlanTurnCompletion>, RecordingHostError> {
        if self.running.is_some() || self.retention.running.is_some() {
            return Err(RecordingHostError::Busy);
        }
        if self.state().phase == RecordingPhase::Faulted {
            return Err(RecordingHostError::WorkerFailed);
        }
        let Some(running) = self.plan_turn.running.as_mut() else {
            return self
                .plan_turn
                .completion
                .as_ref()
                .filter(|c| &c.run == run)
                .cloned()
                .ok_or(RecordingHostError::PlanTurnMismatch);
        };
        if &running.run != run {
            return Err(RecordingHostError::PlanTurnMismatch);
        }
        let result = (&mut running.task).await;
        self.plan_turn.running.take();
        match result {
            Ok(result) => {
                self.store = Some(result.store);
                let completion = Arc::new(result.completion);
                match &completion.outcome {
                    Ok(RecordingPlanTurnReceipt::Mapping(r)) => {
                        self.plan_turn.last_mapping = Some(RecordingPlanTurnSuccess {
                            run: completion.run.clone(),
                            recording_run: completion.recording_run.clone(),
                            receipt: r.clone(),
                        })
                    }
                    Ok(RecordingPlanTurnReceipt::Applied(r)) => {
                        self.plan_turn.last_applied = Some(RecordingPlanTurnSuccess {
                            run: completion.run.clone(),
                            recording_run: completion.recording_run.clone(),
                            receipt: r.clone(),
                        })
                    }
                    Err(_) => self.plan_turn.recovery_required = true,
                }
                self.plan_turn.completion = Some(completion.clone());
                self.status
                    .send_modify(|s| Arc::make_mut(s).phase = RecordingPhase::Joined);
                Ok(completion)
            }
            Err(_) => {
                self.plan_turn.recovery_required = true;
                self.status
                    .send_modify(|s| Arc::make_mut(s).phase = RecordingPhase::Faulted);
                Err(RecordingHostError::WorkerFailed)
            }
        }
    }
}

#[cfg(test)]
mod tests;
