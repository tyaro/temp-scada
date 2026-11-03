//! A single physical management reader worker, independent of the recording writer.
use super::{types::*, RecordingPlanTurnIntent, RecordingRun};
use scada_historian::store::{
    query::{CancellationToken, HistoryReader, QueryControl, QueryError},
    StoreError, StoreResult,
};
use std::sync::Arc;
use tokio::task::JoinHandle;

#[derive(Clone)]
pub(super) struct BoundRequest {
    pub recording_run: RecordingRun,
    pub session_id: String,
    pub intent: RecordingPlanTurnIntent,
}
pub(super) struct PreflightOwner {
    pub reader: Option<HistoryReader>,
    pub running: Option<Running>,
    pub completion: Option<Arc<PreflightCompletion>>,
    pub bound: Option<BoundRequest>,
    pub candidate: Option<CandidatePhase>,
    pub unusable: bool,
    pub faulted: bool,
}
pub(super) struct Running {
    run: PreflightRun,
    cancel: CancellationToken,
    task: JoinHandle<WorkerResult>,
}
struct WorkerResult {
    reader: HistoryReader,
    completion: PreflightCompletion,
}
fn evaluate(
    intent: &RecordingPlanTurnIntent,
    reader: &mut HistoryReader,
    control: &QueryControl,
) -> StoreResult<PreflightReport> {
    match intent {
        RecordingPlanTurnIntent::RegisterMapping(r) => reader
            .preflight_recording_mapping(r, control)
            .map(PreflightReport::Mapping),
        RecordingPlanTurnIntent::Apply(r) => reader
            .preflight_recording_plan(r, control)
            .map(PreflightReport::Plan),
    }
}
impl PreflightOwner {
    pub fn new(reader: HistoryReader) -> Self {
        Self {
            reader: Some(reader),
            running: None,
            completion: None,
            bound: None,
            candidate: None,
            unusable: false,
            faulted: false,
        }
    }
    pub fn require_idle(&self) -> Result<(), SupervisorError> {
        if self.running.is_some() {
            return Err(SupervisorError::Busy);
        }
        if self.faulted {
            return Err(SupervisorError::ReaderFailed);
        }
        if self.unusable {
            return Err(SupervisorError::ReaderUnusable);
        }
        if self.reader.is_none() {
            return Err(SupervisorError::NoReader);
        }
        Ok(())
    }
    pub fn pending_candidate(&self) -> bool {
        self.candidate
            .is_some_and(|p| p != CandidatePhase::Submitted)
    }
    pub fn clear_result(&mut self) {
        self.completion = None;
        self.bound = None;
        self.candidate = None;
    }
    pub fn start(
        &mut self,
        bound: BoundRequest,
        control: QueryControl,
    ) -> Result<PreflightRun, SupervisorError> {
        self.start_with(bound, control, evaluate)
    }
    fn start_with(
        &mut self,
        bound: BoundRequest,
        control: QueryControl,
        evaluate: impl FnOnce(
                &RecordingPlanTurnIntent,
                &mut HistoryReader,
                &QueryControl,
            ) -> StoreResult<PreflightReport>
            + Send
            + 'static,
    ) -> Result<PreflightRun, SupervisorError> {
        self.require_idle()?;
        if self.pending_candidate() {
            return Err(SupervisorError::Busy);
        }
        tokio::runtime::Handle::try_current().map_err(|_| SupervisorError::NoRuntime)?;
        let run = PreflightRun(Arc::new(()));
        let worker_run = run.clone();
        let recording_run = bound.recording_run.clone();
        let intent = bound.intent.clone();
        let cancel = control.cancellation.clone();
        let mut reader = self.reader.take().expect("idle reader");
        self.clear_result();
        self.bound = Some(bound);
        let task = tokio::task::spawn_blocking(move || {
            let outcome = evaluate(&intent, &mut reader, &control);
            WorkerResult {
                reader,
                completion: PreflightCompletion {
                    run: worker_run,
                    recording_run,
                    outcome,
                },
            }
        });
        self.running = Some(Running {
            run: run.clone(),
            cancel,
            task,
        });
        Ok(run)
    }
    pub fn cancel(&self, expected: &PreflightRun) -> Result<(), SupervisorError> {
        if let Some(r) = &self.running {
            if &r.run != expected {
                return Err(SupervisorError::WrongPreflight);
            }
            r.cancel.cancel();
            return Ok(());
        }
        self.completed(expected).map(|_| ())
    }
    pub fn completed(
        &self,
        expected: &PreflightRun,
    ) -> Result<Arc<PreflightCompletion>, SupervisorError> {
        if self.faulted {
            return Err(SupervisorError::ReaderFailed);
        }
        self.completion
            .as_ref()
            .filter(|c| &c.run == expected)
            .cloned()
            .ok_or(SupervisorError::WrongPreflight)
    }
    pub async fn join(
        &mut self,
        expected: &PreflightRun,
    ) -> Result<Arc<PreflightCompletion>, SupervisorError> {
        let Some(r) = self.running.as_mut() else {
            return self.completed(expected);
        };
        if &r.run != expected {
            return Err(SupervisorError::WrongPreflight);
        }
        let result = (&mut r.task).await;
        self.running.take();
        match result {
            Ok(result) => {
                self.reader = Some(result.reader);
                let completion = Arc::new(result.completion);
                self.unusable |= matches!(
                    &completion.outcome,
                    Err(StoreError::Control(QueryError::ReaderUnusable))
                );
                self.candidate = completion
                    .outcome
                    .as_ref()
                    .ok()
                    .and_then(PreflightReport::candidate)
                    .map(|_| CandidatePhase::Candidate);
                self.completion = Some(completion.clone());
                Ok(completion)
            }
            Err(_) => {
                self.faulted = true;
                self.candidate = None;
                Err(SupervisorError::ReaderFailed)
            }
        }
    }
    pub fn phase(&self) -> PreflightPhase {
        if self.faulted {
            PreflightPhase::Faulted
        } else if self.running.is_some() {
            PreflightPhase::InFlight
        } else if self.unusable {
            PreflightPhase::ReaderUnusable
        } else if self.reader.is_none() {
            PreflightPhase::NoReader
        } else if self.completion.is_some() {
            PreflightPhase::Completed
        } else {
            PreflightPhase::Idle
        }
    }
    pub fn run(&self) -> Option<PreflightRun> {
        self.running
            .as_ref()
            .map(|r| r.run.clone())
            .or_else(|| self.completion.as_ref().map(|c| c.run.clone()))
    }
}
impl Drop for PreflightOwner {
    fn drop(&mut self) {
        if let Some(r) = &self.running {
            r.cancel.cancel();
        }
    }
}

#[cfg(test)]
mod tests;
