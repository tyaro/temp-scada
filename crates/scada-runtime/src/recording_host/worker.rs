use std::sync::Arc;

use scada_historian::{
    recorder::{
        ManagedRecorderStart, Recorder, RecorderConfig, RecorderState, SystemRecorderClock,
    },
    store::{
        query::{CancellationToken, QueryControl},
        SqliteStore,
    },
};
#[cfg(test)]
use std::sync::{mpsc, Mutex};
#[cfg(test)]
use tokio::sync::Notify;
use tokio::{runtime::Handle, sync::watch};

use super::{
    RecordingCompletion, RecordingHostStatus, RecordingPhase, RecordingProgress, RecordingRun,
};
use crate::recorder_source::SdkRecorderSource;

pub(super) enum Start {
    Manual,
    Managed {
        binding: ManagedRecorderStart,
        control: QueryControl,
    },
}
pub(super) struct Worker {
    pub start: Start,
    pub store: SqliteStore,
    pub config: RecorderConfig,
    pub clock: SystemRecorderClock,
    pub source: SdkRecorderSource,
    pub runtime: Handle,
    pub cancel: CancellationToken,
    pub status: watch::Sender<Arc<RecordingHostStatus>>,
    pub run: RecordingRun,
    #[cfg(test)]
    pub shutdown_gate: Option<Arc<TestShutdownGate>>,
}
#[cfg(test)]
pub(super) struct TestShutdownGate {
    pub entered: Notify,
    release: Mutex<mpsc::Receiver<()>>,
}
#[cfg(test)]
impl TestShutdownGate {
    pub fn new() -> (Arc<Self>, mpsc::Sender<()>) {
        let (sender, receiver) = mpsc::channel();
        (
            Arc::new(Self {
                entered: Notify::new(),
                release: Mutex::new(receiver),
            }),
            sender,
        )
    }
    fn wait(&self) {
        self.entered.notify_one();
        let _ = self.release.lock().expect("test gate").recv();
    }
}
pub(super) struct WorkerResult {
    pub store: SqliteStore,
    pub completion: RecordingCompletion,
}
impl Worker {
    pub fn run(self) -> WorkerResult {
        let Self {
            start,
            mut store,
            config,
            mut clock,
            mut source,
            runtime,
            cancel,
            status,
            run,
            #[cfg(test)]
            shutdown_gate,
        } = self;
        let mut last_report = None;
        let mut start_error = None;
        let mut activation_receipt = None;
        // A stop before this worker starts need not create a database session.
        if !cancel.is_cancelled() {
            let started = match start {
                Start::Manual => Recorder::start(&mut store, config, &mut clock).map(|r| (r, None)),
                Start::Managed { binding, control } => {
                    Recorder::start_managed(&mut store, config, binding, &mut clock, &control)
                        .map(|(r, a)| (r, Some(a)))
                }
            };
            match started {
                Ok((mut recorder, receipt)) => {
                    activation_receipt = receipt;
                    loop {
                        let report = recorder.step(&mut store, &mut source, &mut clock, &cancel);
                        let finished = report.state == RecorderState::Stopped;
                        publish_report(&status, &run, &report);
                        last_report = Some(report);
                        if finished {
                            break;
                        }
                    }
                }
                Err(error) => {
                    publish(&status, &run, |frame| {
                        frame.start_error = Some(start_diagnostic(&error));
                        frame.phase = RecordingPhase::Stopping;
                    });
                    start_error = Some(error);
                }
            }
        }
        #[cfg(test)]
        if cancel.is_cancelled() {
            if let Some(gate) = shutdown_gate {
                gate.wait();
            }
        }
        let shutdown = runtime.block_on(source.shutdown());
        publish(&status, &run, |frame| {
            frame.source_shutdown = Some(shutdown);
            frame.phase = RecordingPhase::FinishedUnjoined;
        });
        let progress = status.borrow().progress.clone();
        WorkerResult {
            store,
            completion: RecordingCompletion {
                activation_receipt,
                run,
                progress,
                report: last_report,
                start_error,
                source_shutdown: shutdown,
            },
        }
    }
}

fn start_diagnostic(error: &scada_historian::recorder::RecorderStartError) -> String {
    use scada_historian::recorder::RecorderStartError;
    match error {
        RecorderStartError::InvalidConfig => "invalid recorder configuration".into(),
        RecorderStartError::AlreadyActivated => "recording activation already exists".into(),
        RecorderStartError::ManagedBindingMismatch => {
            "managed recording configuration mismatch".into()
        }
        RecorderStartError::ActivationUnconfirmed(_) => {
            "recording activation unconfirmed; recovery required".into()
        }
        RecorderStartError::Clock(_) => "recorder clock failed".into(),
        RecorderStartError::Store(error) => error.to_string(),
    }
}

/// A stop request can update phase concurrently with a completed step. Keep
/// that phase, while still publishing the step's actual receipts/counters.
pub(super) fn publish_report(
    status: &watch::Sender<Arc<RecordingHostStatus>>,
    run: &RecordingRun,
    report: &scada_historian::recorder::RecorderReport,
) {
    publish(status, run, |frame| {
        let mut next = RecordingProgress::from(report);
        if let Some(previous) = &frame.progress {
            next.tick_receipt = next.tick_receipt.or_else(|| previous.tick_receipt.clone());
            next.gap_receipt = next.gap_receipt.or_else(|| previous.gap_receipt.clone());
            next.observation = next.observation.or_else(|| previous.observation.clone());
        }
        frame.progress = Some(next);
        if report.state == RecorderState::Stopped {
            frame.phase = RecordingPhase::Stopping;
        } else if frame.phase != RecordingPhase::Stopping {
            frame.phase = RecordingPhase::Running;
        }
    });
}

fn publish(
    status: &watch::Sender<Arc<RecordingHostStatus>>,
    run: &RecordingRun,
    update: impl FnOnce(&mut RecordingHostStatus),
) {
    status.send_modify(|current| {
        if current.run.as_ref() == Some(run) {
            update(Arc::make_mut(current));
        }
    });
}
