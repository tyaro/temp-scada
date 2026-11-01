use std::sync::Arc;

use scada_historian::{
    recorder::{Recorder, RecorderConfig, RecorderState, SystemRecorderClock},
    store::{query::CancellationToken, SqliteStore},
};
use tokio::{runtime::Handle, sync::watch};

use super::{
    RecordingCompletion, RecordingHostStatus, RecordingPhase, RecordingProgress, RecordingRun,
};
use crate::recorder_source::SdkRecorderSource;

pub(super) struct Worker {
    pub store: SqliteStore,
    pub config: RecorderConfig,
    pub clock: SystemRecorderClock,
    pub source: SdkRecorderSource,
    pub runtime: Handle,
    pub cancel: CancellationToken,
    pub status: watch::Sender<Arc<RecordingHostStatus>>,
    pub run: RecordingRun,
}
pub(super) struct WorkerResult {
    pub store: SqliteStore,
    pub completion: RecordingCompletion,
}
impl Worker {
    pub fn run(self) -> WorkerResult {
        let Self {
            mut store,
            config,
            mut clock,
            mut source,
            runtime,
            cancel,
            status,
            run,
        } = self;
        let mut last_report = None;
        let mut start_error = None;
        // A stop before this worker starts need not create a database session.
        if !cancel.is_cancelled() {
            match Recorder::start(&mut store, config, &mut clock) {
                Ok(mut recorder) => loop {
                    let report = recorder.step(&mut store, &mut source, &mut clock, &cancel);
                    let finished = report.state == RecorderState::Stopped;
                    publish_report(&status, &run, &report);
                    last_report = Some(report);
                    if finished {
                        break;
                    }
                },
                Err(error) => {
                    publish(&status, &run, |frame| {
                        frame.start_error = Some(match &error {
                            scada_historian::recorder::RecorderStartError::InvalidConfig => {
                                "invalid recorder configuration".into()
                            }
                            scada_historian::recorder::RecorderStartError::Clock(_) => {
                                "recorder clock failed".into()
                            }
                            scada_historian::recorder::RecorderStartError::Store(error) => {
                                error.to_string()
                            }
                        });
                        frame.phase = RecordingPhase::Stopping;
                    });
                    start_error = Some(error);
                }
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
                run,
                progress,
                report: last_report,
                start_error,
                source_shutdown: shutdown,
            },
        }
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
