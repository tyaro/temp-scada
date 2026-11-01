use crate::store::{
    evidence::{GapReceipt, PlanRef},
    query::CancellationToken,
    CommitReceipt, SessionSpec, SessionStatus, StoreError, TickObservation,
};

#[derive(Clone, Debug)]
pub struct RecorderConfig {
    pub session: SessionSpec,
    pub plan: PlanRef,
    pub period_ms: u64,
    pub slot_count: Option<u64>,
    pub max_clock_skew_ms: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClockReading {
    pub monotonic_ms: u64,
    pub wall_time_ms: i64,
    pub clock_epoch: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClockError {
    ReadingFailed,
    InvalidReading,
    EpochChanged,
    MonotonicRegressed,
    WallRegressed,
    SkewExceeded,
    Cancelled,
    DeadlineOutOfRange,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceError(pub &'static str);
pub trait RecorderClock {
    fn read(&mut self) -> Result<ClockReading, ClockError>;
    fn wait_until(
        &mut self,
        deadline_monotonic_ms: u64,
        cancel: &CancellationToken,
    ) -> Result<(), ClockError>;
}
/// A bounded synchronous copy of a latest snapshot, not a network poll.
pub trait SnapshotSource {
    fn capture(&mut self) -> Result<Vec<TickObservation>, SourceError>;
}
#[derive(Debug)]
pub enum RecorderStartError {
    InvalidConfig,
    Clock(ClockError),
    Store(StoreError),
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RecorderCounters {
    pub planned_slots: Option<u64>,
    pub captured_snapshots: u64,
    pub committed_ticks: u64,
    pub missed_slots: u64,
    pub committed_gaps: u64,
    pub resolved_slots: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecorderState {
    Running,
    Stopped,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservedSlot {
    pub slot: u64,
    pub scheduled_monotonic_ms: u64,
    pub observed: ClockReading,
    pub lateness_ms: u64,
}
#[derive(Debug)]
pub enum StopCause {
    Completed,
    Requested,
    Cancelled,
    Clock(ClockError),
    Source(SourceError),
    Store(StoreError),
    InvalidObservation(&'static str),
    ArithmeticOverflow,
}
#[derive(Debug)]
pub enum CleanupOutcome {
    Closed(SessionStatus),
    Interrupted(SessionStatus),
    Failed(StoreError),
}
#[derive(Debug)]
pub struct TerminalReport {
    pub cause: StopCause,
    pub cleanup: CleanupOutcome,
}
#[derive(Debug)]
pub struct RecorderReport {
    pub state: RecorderState,
    pub already_stopped: bool,
    pub counters: RecorderCounters,
    pub observation: Option<ObservedSlot>,
    pub tick_receipt: Option<CommitReceipt>,
    pub gap_receipt: Option<GapReceipt>,
    pub terminal: Option<TerminalReport>,
}
