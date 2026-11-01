//! Explicit paused-store turns; never a scheduler or an automatic resume loop.
use std::{fmt, sync::Arc};

use scada_historian::{
    recorder::{CleanupOutcome, StopCause},
    store::{
        query::{CancellationToken, QueryControl},
        retention::{
            clock_guard::{ClockSample, GuardState, RetentionClockPolicy},
            coordinator::{
                CoordinatorInput, CoordinatorIntent, CoordinatorOutcome, CoordinatorReport,
            },
        },
        SqliteStore,
    },
};
use tokio::task::JoinHandle;

use super::{RecordingHost, RecordingHostError, RecordingPhase};

#[derive(Clone)]
pub struct RetentionTurnRun(Arc<()>);
impl PartialEq for RetentionTurnRun {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
impl Eq for RetentionTurnRun {}
impl fmt::Debug for RetentionTurnRun {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RetentionTurnRun(..)")
    }
}

/// The guard state belongs to the Host, rather than a caller's old proposal.
#[derive(Clone, Debug)]
pub struct RetentionTurnInput {
    pub policy: RetentionClockPolicy,
    pub sample: ClockSample,
    pub candidate_cutoff_ms: Option<i64>,
    pub intent: CoordinatorIntent,
}
#[derive(Debug)]
pub struct RetentionTurnCompletion {
    pub run: RetentionTurnRun,
    pub report: CoordinatorReport,
}
#[derive(Clone, Debug)]
pub struct RetentionGuardSnapshot {
    pub guard_state: GuardState,
    pub rearm_required: bool,
    /// A job exists, or a failed operation left its state unknown. Rearm alone
    /// does not clear this block; Observe must discover an idle store.
    pub job_pending: bool,
}

#[derive(Default)]
pub(super) struct RetentionOwner {
    pub running: Option<RetentionRunning>,
    pub guard_state: GuardState,
    pub rearm_required: bool,
    pub job_pending: bool,
    completion: Option<Arc<RetentionTurnCompletion>>,
}
pub(super) struct RetentionRunning {
    cancel: CancellationToken,
    task: JoinHandle<TurnResult>,
}
impl RetentionOwner {
    pub fn clear_completion(&mut self) {
        self.completion = None;
    }
}
struct TurnResult {
    store: SqliteStore,
    completion: RetentionTurnCompletion,
}

impl RecordingHost {
    pub(super) fn clean_pause(&self) -> bool {
        self.completion.as_ref().is_some_and(|completion| {
            completion.start_error.is_none()
                && completion.source_shutdown.is_ok()
                && completion
                    .report
                    .as_ref()
                    .and_then(|r| r.terminal.as_ref())
                    .is_some_and(|terminal| {
                        matches!(
                            terminal.cause,
                            StopCause::Completed | StopCause::Requested | StopCause::Cancelled
                        ) && matches!(terminal.cleanup, CleanupOutcome::Closed(_))
                    })
        })
    }

    fn require_paused_store(&self) -> Result<(), RecordingHostError> {
        if self.running.is_some() || self.retention.running.is_some() {
            return Err(RecordingHostError::Busy);
        }
        if self.state().phase == RecordingPhase::Faulted {
            return Err(RecordingHostError::WorkerFailed);
        }
        if self.store.is_none() {
            return Err(RecordingHostError::NoStore);
        }
        if !self.clean_pause() {
            return Err(RecordingHostError::UncleanPause);
        }
        Ok(())
    }

    pub fn retention_guard_state(&self) -> RetentionGuardSnapshot {
        RetentionGuardSnapshot {
            guard_state: self.retention.guard_state.clone(),
            rearm_required: self.retention.rearm_required,
            job_pending: self.retention.job_pending,
        }
    }

    /// Explicit reset of clock/error state, without clearing an active/unknown
    /// job, repairing storage, authorizing deletion or starting recording.
    pub fn rearm_retention(&mut self) -> Result<(), RecordingHostError> {
        self.require_paused_store()?;
        self.retention.guard_state = self.retention.guard_state.rearm();
        self.retention.rearm_required = false;
        Ok(())
    }

    /// One recovery read/assessment and at most one existing job API call.
    /// The supplied deadline/token/budgets are not refreshed when queued.
    pub fn start_retention_turn(
        &mut self,
        input: RetentionTurnInput,
        control: QueryControl,
    ) -> Result<RetentionTurnRun, RecordingHostError> {
        self.require_paused_store()?;
        if self.retention.rearm_required && matches!(input.intent, CoordinatorIntent::Begin(_)) {
            return Err(RecordingHostError::RetentionRearmRequired);
        }
        tokio::runtime::Handle::try_current().map_err(|_| RecordingHostError::NoRuntime)?;
        let run = RetentionTurnRun(Arc::new(()));
        let worker_run = run.clone();
        let input = CoordinatorInput {
            policy: input.policy,
            guard_state: self.retention.guard_state.clone(),
            sample: input.sample,
            candidate_cutoff_ms: input.candidate_cutoff_ms,
            intent: input.intent,
        };
        let mut store = self.store.take().expect("paused writer checked above");
        let cancel = control.cancellation.clone();
        self.retention.completion = None;
        let task = tokio::task::spawn_blocking(move || {
            let report = store.coordinate_retention_once(&input, &control);
            TurnResult {
                store,
                completion: RetentionTurnCompletion {
                    run: worker_run,
                    report,
                },
            }
        });
        self.retention.running = Some(RetentionRunning { cancel, task });
        self.status
            .send_modify(|state| Arc::make_mut(state).phase = RecordingPhase::Retaining);
        Ok(run)
    }

    pub fn cancel_retention_turn(&mut self) {
        if let Some(running) = &self.retention.running {
            running.cancel.cancel();
        }
    }

    /// Await by borrowed handle; cancellation leaves the worker, guard update
    /// and writer owned here. Ok means joined, not that the operation succeeded.
    pub async fn join_retention_turn(
        &mut self,
    ) -> Result<Arc<RetentionTurnCompletion>, RecordingHostError> {
        if self.running.is_some() {
            return Err(RecordingHostError::Busy);
        }
        let Some(running) = self.retention.running.as_mut() else {
            if self.state().phase == RecordingPhase::Faulted {
                return Err(RecordingHostError::WorkerFailed);
            }
            return self
                .retention
                .completion
                .clone()
                .ok_or(RecordingHostError::NotRunning);
        };
        let result = (&mut running.task).await;
        self.retention.running.take();
        match result {
            Ok(result) => {
                self.store = Some(result.store);
                let completion = Arc::new(result.completion);
                let report = &completion.report;
                self.retention.guard_state = report.next_state.clone();
                self.retention.rearm_required |= report.rearm_required
                    || report.outcome.is_err()
                    || matches!(report.next_state, GuardState::Suspended { .. });
                self.retention.job_pending = match &report.outcome {
                    Ok(CoordinatorOutcome::Begun(_)) => true,
                    Ok(CoordinatorOutcome::Stepped(receipt)) => !receipt.completed,
                    Ok(CoordinatorOutcome::Observed | CoordinatorOutcome::NoWrite { .. }) => report
                        .recovery
                        .as_ref()
                        .is_none_or(|r| r.active_job.is_some()),
                    Err(_) => true,
                };
                self.retention.completion = Some(completion.clone());
                self.status
                    .send_modify(|state| Arc::make_mut(state).phase = RecordingPhase::Joined);
                Ok(completion)
            }
            Err(_) => {
                self.retention.rearm_required = true;
                self.retention.job_pending = true;
                self.status
                    .send_modify(|state| Arc::make_mut(state).phase = RecordingPhase::Faulted);
                Err(RecordingHostError::WorkerFailed)
            }
        }
    }
}

#[cfg(test)]
mod tests;
