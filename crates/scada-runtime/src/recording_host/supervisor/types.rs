use super::super::{RecordingHostError, RecordingHostStatus, RecordingRun};
use scada_historian::store::{
    recording_plan::{
        MappingPreflightOutcome, PlanPreflightOutcome, RecordingMappingPreflight,
        RecordingPlanPreflight,
    },
    SqliteStore, StoreError, StoreResult,
};
use std::{fmt, sync::Arc};

#[derive(Clone)]
pub struct PreflightRun(pub(super) Arc<()>);
impl PartialEq for PreflightRun {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
impl Eq for PreflightRun {}
impl fmt::Debug for PreflightRun {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PreflightRun(..)")
    }
}
#[derive(Clone, Debug)]
pub enum PreflightReport {
    Mapping(RecordingMappingPreflight),
    Plan(RecordingPlanPreflight),
}
impl PreflightReport {
    /// Outer None denotes replay; inner None denotes a candidate with no active session.
    pub(super) fn candidate(&self) -> Option<&Option<String>> {
        match self {
            Self::Mapping(r) => match &r.outcome {
                MappingPreflightOutcome::Candidate { active_session_id } => Some(active_session_id),
                _ => None,
            },
            Self::Plan(r) => match &r.outcome {
                PlanPreflightOutcome::Candidate { active_session_id } => Some(active_session_id),
                _ => None,
            },
        }
    }
}
#[derive(Debug)]
pub struct PreflightCompletion {
    pub run: PreflightRun,
    pub recording_run: RecordingRun,
    pub outcome: StoreResult<PreflightReport>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreflightPhase {
    Idle,
    InFlight,
    Completed,
    ReaderUnusable,
    Faulted,
    NoReader,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CandidatePhase {
    Candidate,
    PauseRequested,
    Paused,
    Submitted,
}
#[derive(Clone, Debug)]
pub struct SupervisorState {
    pub recording: Arc<RecordingHostStatus>,
    pub preflight_phase: PreflightPhase,
    pub preflight_run: Option<PreflightRun>,
    pub candidate_phase: Option<CandidatePhase>,
    pub resume_inspection_phase: super::ResumeInspectionPhase,
    pub resume_inspection_run: Option<super::ResumeInspectionRun>,
    pub resume_prepared: bool,
}
/// The original writer is returned intact if its bounded reader lease cannot be obtained.
pub struct SupervisorInitError {
    pub error: StoreError,
    pub store: SqliteStore,
}
impl fmt::Debug for SupervisorInitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SupervisorInitError")
            .field("error", &self.error.to_string())
            .field("store", &"SqliteStore(..)")
            .finish()
    }
}
#[derive(Debug)]
pub enum SupervisorError {
    Busy,
    NoRuntime,
    NoRecording,
    WrongPreflight,
    NoCandidate,
    PauseRequired,
    CandidateConsumed,
    ContextMismatch,
    ReaderUnusable,
    ReaderFailed,
    NoReader,
    Request(StoreError),
    Host(RecordingHostError),
    WrongInspection,
    WrongResume,
    ResumeConsumed,
    ResumeBlocked(&'static str),
    Resolution(scada_historian::recorder::SourceError),
}
impl From<RecordingHostError> for SupervisorError {
    fn from(error: RecordingHostError) -> Self {
        Self::Host(error)
    }
}
