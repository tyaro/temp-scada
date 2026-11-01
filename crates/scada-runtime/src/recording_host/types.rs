use std::{fmt, sync::Arc};

use banto_tagclient::ErrorKind;
use scada_historian::{
    recorder::{
        CleanupOutcome, ClockError, ObservedSlot, RecorderCounters, RecorderReport,
        RecorderStartError, StopCause,
    },
    store::{
        evidence::{GapReceipt, PlanRef},
        CommitReceipt,
    },
};

/// Opaque process-local owner identity; never serialize or persist this token.
#[derive(Clone)]
pub struct RecordingRun(pub(super) Arc<()>);
impl PartialEq for RecordingRun {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
impl Eq for RecordingRun {}
impl fmt::Debug for RecordingRun {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecordingRun(..)")
    }
}

#[derive(Clone, Debug)]
pub struct RecordingOptions {
    pub plan: PlanRef,
    pub slot_count: Option<u64>,
    pub max_clock_skew_ms: u64,
    pub clock_epoch: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordingPhase {
    Idle,
    Starting,
    Running,
    Stopping,
    FinishedUnjoined,
    Joined,
    Faulted,
    NoStore,
    Retaining,
}

#[derive(Clone, Debug)]
pub struct RecordingProgress {
    pub counters: RecorderCounters,
    pub observation: Option<ObservedSlot>,
    pub tick_receipt: Option<CommitReceipt>,
    pub gap_receipt: Option<GapReceipt>,
    pub stop_reason: Option<RecordingStopReason>,
    pub cleanup: Option<RecordingCleanup>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordingStopReason {
    Completed,
    Requested,
    Cancelled,
    Clock(ClockError),
    Source(&'static str),
    Store(String),
    InvalidObservation,
    ArithmeticOverflow,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordingCleanup {
    Closed,
    Interrupted,
    Failed(String),
}

impl From<&RecorderReport> for RecordingProgress {
    fn from(report: &RecorderReport) -> Self {
        Self {
            counters: report.counters,
            observation: report.observation.clone(),
            tick_receipt: report.tick_receipt.clone(),
            gap_receipt: report.gap_receipt.clone(),
            stop_reason: report
                .terminal
                .as_ref()
                .map(|terminal| match &terminal.cause {
                    StopCause::Completed => RecordingStopReason::Completed,
                    StopCause::Requested => RecordingStopReason::Requested,
                    StopCause::Cancelled => RecordingStopReason::Cancelled,
                    StopCause::Clock(error) => RecordingStopReason::Clock(*error),
                    StopCause::Source(error) => RecordingStopReason::Source(error.0),
                    StopCause::Store(error) => RecordingStopReason::Store(error.to_string()),
                    StopCause::InvalidObservation(_) => RecordingStopReason::InvalidObservation,
                    StopCause::ArithmeticOverflow => RecordingStopReason::ArithmeticOverflow,
                }),
            cleanup: report
                .terminal
                .as_ref()
                .map(|terminal| match &terminal.cleanup {
                    CleanupOutcome::Closed(_) => RecordingCleanup::Closed,
                    CleanupOutcome::Interrupted(_) => RecordingCleanup::Interrupted,
                    CleanupOutcome::Failed(error) => RecordingCleanup::Failed(error.to_string()),
                }),
        }
    }
}

/// In-process join result. Detailed errors stay here rather than in the latest
/// status. No raw observations, endpoint or credentials are included.
#[derive(Debug)]
pub struct RecordingCompletion {
    pub run: RecordingRun,
    pub progress: Option<RecordingProgress>,
    pub report: Option<RecorderReport>,
    pub start_error: Option<RecorderStartError>,
    pub source_shutdown: Result<(), ErrorKind>,
}

/// One bounded latest diagnostic frame; not a tick delivery queue or wire DTO.
/// A terminal recorder report does not confirm SDK shutdown or worker joining.
#[derive(Clone, Debug)]
pub struct RecordingHostStatus {
    pub run: Option<RecordingRun>,
    pub session_id: Option<String>,
    pub plan: Option<PlanRef>,
    pub phase: RecordingPhase,
    pub progress: Option<RecordingProgress>,
    pub start_error: Option<String>,
    pub stop_requested: bool,
    pub source_shutdown: Option<Result<(), ErrorKind>>,
}

#[derive(Debug)]
pub enum RecordingHostError {
    Busy,
    NoStore,
    NoRuntime,
    NotRunning,
    Config(RecorderStartError),
    Clock(ClockError),
    Source(ErrorKind),
    WorkerFailed,
    UncleanPause,
    RetentionPending,
    RetentionRearmRequired,
    ClockEpochReuse,
    SessionReuse,
}
