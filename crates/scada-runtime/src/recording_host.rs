//! Explicit in-process lifecycle for one fixed recording group and one writer.
//! SDK work stays on Tokio; synchronous recorder/SQLite work stays off it.
mod types;
mod worker;
pub use types::*;

use std::sync::Arc;

use banto_tagclient::RestClient;
use scada_historian::{
    recorder::{RecorderConfig, SystemRecorderClock},
    store::{query::CancellationToken, SqliteStore},
};
use tokio::{runtime::Handle, sync::watch, task::JoinHandle};

use crate::recorder_source::{SdkRecorderPlan, SdkRecorderSource};

/// Owns the writer while idle and exactly one blocking worker while active.
/// Keep the SDK runtime alive through join. Drop requests cancellation without
/// aborting blocking I/O; a detached worker retains the writer until cleanup.
pub struct RecordingHost {
    store: Option<SqliteStore>,
    running: Option<Running>,
    status: watch::Sender<Arc<RecordingHostStatus>>,
    completion: Option<Arc<RecordingCompletion>>,
}
struct Running {
    cancel: CancellationToken,
    task: JoinHandle<worker::WorkerResult>,
}

impl RecordingHost {
    pub fn new(store: SqliteStore) -> Self {
        let (status, _) = watch::channel(Arc::new(RecordingHostStatus {
            run: None,
            session_id: None,
            plan: None,
            phase: RecordingPhase::Idle,
            progress: None,
            start_error: None,
            stop_requested: false,
            source_shutdown: None,
        }));
        Self {
            store: Some(store),
            running: None,
            status,
            completion: None,
        }
    }

    pub fn state(&self) -> Arc<RecordingHostStatus> {
        self.status.borrow().clone()
    }
    pub fn state_watch(&self) -> watch::Receiver<Arc<RecordingHostStatus>> {
        self.status.subscribe()
    }

    /// Acceptance only: database/clock startup is reported by the worker.
    /// Replacement is explicitly request_stop -> join -> start with a new session.
    /// A finished but unjoined worker remains Busy.
    pub fn start(
        &mut self,
        plan: SdkRecorderPlan,
        options: RecordingOptions,
        client: RestClient,
    ) -> Result<RecordingRun, RecordingHostError> {
        if self.running.is_some() {
            return Err(RecordingHostError::Busy);
        }
        if self.state().phase == RecordingPhase::Faulted {
            return Err(RecordingHostError::WorkerFailed);
        }
        if self.store.is_none() {
            return Err(RecordingHostError::NoStore);
        }
        let runtime = Handle::try_current().map_err(|_| RecordingHostError::NoRuntime)?;
        let config = RecorderConfig {
            session: plan.session().clone(),
            plan: options.plan,
            period_ms: plan.session().members[0].period_ms,
            slot_count: options.slot_count,
            max_clock_skew_ms: options.max_clock_skew_ms,
        };
        config.validate().map_err(RecordingHostError::Config)?;
        let clock =
            SystemRecorderClock::new(options.clock_epoch).map_err(RecordingHostError::Clock)?;
        let source = SdkRecorderSource::start(plan, client).map_err(RecordingHostError::Source)?;
        let run = RecordingRun(Arc::new(()));
        self.status.send_replace(Arc::new(RecordingHostStatus {
            run: Some(run.clone()),
            session_id: Some(config.session.session_id.clone()),
            plan: Some(config.plan.clone()),
            phase: RecordingPhase::Starting,
            progress: None,
            start_error: None,
            stop_requested: false,
            source_shutdown: None,
        }));
        let cancel = CancellationToken::default();
        self.completion = None;
        let store = self.store.take().expect("idle writer checked above");
        let status = self.status.clone();
        let worker_run = run.clone();
        let worker_cancel = cancel.clone();
        let worker = worker::Worker {
            store,
            config,
            clock,
            source,
            runtime,
            cancel: worker_cancel,
            status,
            run: worker_run,
        };
        let task = tokio::task::spawn_blocking(move || worker.run());
        self.running = Some(Running { cancel, task });
        Ok(run)
    }

    /// Requests cooperative cancellation. It does not confirm the final write,
    /// SQLite cleanup, SDK shutdown, worker completion, or writer release.
    pub fn request_stop(&mut self) {
        if let Some(running) = &self.running {
            running.cancel.cancel();
            self.status.send_modify(|status| {
                Arc::make_mut(status).stop_requested = true;
                if matches!(
                    status.phase,
                    RecordingPhase::Starting | RecordingPhase::Running
                ) {
                    Arc::make_mut(status).phase = RecordingPhase::Stopping;
                }
            });
        }
    }

    /// Cancellation-safe await: the handle stays owned here while awaiting.
    /// A timeout/cancelled caller may retry join; start stays Busy until then.
    /// Ok confirms worker joining; inspect start_error/report/source_shutdown
    /// separately for startup, storage cleanup and SDK failure.
    pub async fn join(&mut self) -> Result<Arc<RecordingCompletion>, RecordingHostError> {
        let Some(running) = self.running.as_mut() else {
            return match self.state().phase {
                RecordingPhase::Joined => Ok(self.completion.clone().expect("joined completion")),
                RecordingPhase::Faulted => Err(RecordingHostError::WorkerFailed),
                _ => Err(RecordingHostError::NotRunning),
            };
        };
        let result = (&mut running.task).await;
        self.running.take();
        match result {
            Ok(result) => {
                self.store = Some(result.store);
                self.completion = Some(Arc::new(result.completion));
                self.status
                    .send_modify(|status| Arc::make_mut(status).phase = RecordingPhase::Joined);
                Ok(self.completion.clone().expect("joined completion"))
            }
            Err(_) => {
                self.status
                    .send_modify(|status| Arc::make_mut(status).phase = RecordingPhase::Faulted);
                Err(RecordingHostError::WorkerFailed)
            }
        }
    }

    /// Caller may now run retention or transfer/drop the writer. No implicit
    /// stop, join, reopen, policy application, or retry takes place here.
    pub fn take_store(&mut self) -> Result<SqliteStore, RecordingHostError> {
        if self.running.is_some() {
            return Err(RecordingHostError::Busy);
        }
        if self.state().phase == RecordingPhase::Faulted {
            return Err(RecordingHostError::WorkerFailed);
        }
        let store = self.store.take().ok_or(RecordingHostError::NoStore)?;
        self.status
            .send_modify(|status| Arc::make_mut(status).phase = RecordingPhase::NoStore);
        Ok(store)
    }
}
impl Drop for RecordingHost {
    fn drop(&mut self) {
        self.request_stop();
    }
}

#[cfg(test)]
mod tests;
