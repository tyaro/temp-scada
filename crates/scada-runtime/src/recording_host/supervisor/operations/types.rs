use super::*;
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperationsPhase {
    Idle,
    Preflighting,
    Candidate,
    Pausing,
    Paused,
    Applying,
    Completed,
    Blocked,
    Uncertain,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelDisposition {
    Requested,
    AlreadyCompleted,
    NotSupported,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnerError {
    Busy,
    Closed,
    Unavailable,
    NoRuntime,
    InvalidContext,
    RecoveryRequired,
    Internal,
}
impl fmt::Display for OwnerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Recording operations owner: {self:?}")
    }
}
impl std::error::Error for OwnerError {}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperationErrorCode {
    InvalidRequest,
    Busy,
    WrongOwner,
    StaleRun,
    Conflict,
    NoCandidate,
    PauseRequired,
    Consumed,
    UncleanPause,
    RetentionBlocked,
    PlanRecoveryRequired,
    Cancelled,
    DeadlineExceeded,
    BudgetExceeded,
    CorruptData,
    NeedsReopen,
    ReaderUnusable,
    SourceFailure,
    WorkerFailure,
    ProjectionFailed,
    Internal,
}
impl OperationErrorCode {
    pub(crate) fn as_str(self) -> &'static str {
        use OperationErrorCode::*;
        match self {
            InvalidRequest => "invalidRequest",
            Busy => "busy",
            WrongOwner => "wrongOwner",
            StaleRun => "staleRun",
            Conflict => "conflict",
            NoCandidate => "noCandidate",
            PauseRequired => "pauseRequired",
            Consumed => "consumed",
            UncleanPause => "uncleanPause",
            RetentionBlocked => "retentionBlocked",
            PlanRecoveryRequired => "planRecoveryRequired",
            Cancelled => "cancelled",
            DeadlineExceeded => "deadlineExceeded",
            BudgetExceeded => "budgetExceeded",
            CorruptData => "corruptData",
            NeedsReopen => "needsReopen",
            ReaderUnusable => "readerUnusable",
            SourceFailure => "sourceFailure",
            WorkerFailure => "workerFailure",
            ProjectionFailed => "projectionFailed",
            Internal => "internal",
        }
    }
}
/// A synchronous rejection guarantees that this call dispatched nothing.
#[derive(Debug)]
pub struct OperationRejection {
    pub code: OperationErrorCode,
}
impl fmt::Display for OperationRejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Recording operation rejected: {}", self.code.as_str())
    }
}
impl std::error::Error for OperationRejection {}
#[derive(Clone)]
pub struct RecordingChangeHandle {
    pub(super) owner: Arc<()>,
    pub(super) token: Arc<()>,
}
impl fmt::Debug for RecordingChangeHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecordingChangeHandle(..)")
    }
}
#[derive(Clone)]
pub struct RecordingOperationHandle(pub(super) Arc<Operation>);
impl fmt::Debug for RecordingOperationHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecordingOperationHandle(..)")
    }
}
impl RecordingOperationHandle {
    pub fn request(&self) -> &RecordingOperationRequest {
        &self.0.request
    }
    pub fn watch(&self) -> watch::Receiver<Option<Arc<RecordingOperationResult>>> {
        self.0.completion.subscribe()
    }
    pub async fn wait(&self) -> Result<Arc<RecordingOperationResult>, OwnerError> {
        let mut rx = self.watch();
        loop {
            if let Some(value) = rx.borrow_and_update().clone() {
                return Ok(value);
            }
            rx.changed().await.map_err(|_| OwnerError::Unavailable)?;
        }
    }
    pub fn request_cancel(&self) -> CancelDisposition {
        if self.0.completion.borrow().is_some() {
            CancelDisposition::AlreadyCompleted
        } else if self.0.stage == Stage::Pause {
            CancelDisposition::NotSupported
        } else {
            self.0.cancel.cancel();
            CancelDisposition::Requested
        }
    }
}
#[derive(Clone, Debug)]
pub struct AcceptedRecordingChange {
    pub change: RecordingChangeHandle,
    pub operation: RecordingOperationHandle,
}
#[derive(Clone, Debug)]
pub struct AppliedSuccess {
    pub request: RecordingOperationRequest,
    pub receipt: RecordingPlanReceipt,
}
#[derive(Clone, Debug)]
pub struct NativeReceiptEvidence {
    pub request: RecordingOperationRequest,
    pub receipt: RecordingPlanReceipt,
}
#[derive(Clone, Debug)]
pub struct RecordingOperationsState {
    pub context: RecordingOperationsContext,
    pub phase: OperationsPhase,
    pub change: Option<RecordingChangeHandle>,
    pub request: Option<RecordingChangeRequest>,
    pub active: Option<RecordingOperationHandle>,
    pub latest: Option<Arc<RecordingOperationResult>>,
    pub last_applied: Option<AppliedSuccess>,
    pub recovery_required: bool,
    pub closed: bool,
}
#[derive(Clone, Debug)]
pub struct RecordingOperationsRecoveryEvidence {
    pub context: RecordingOperationsContext,
    pub request: Option<RecordingOperationRequest>,
    pub latest: Option<Arc<RecordingOperationResult>>,
    pub last_applied: Option<AppliedSuccess>,
    pub native_receipt: Option<NativeReceiptEvidence>,
    pub owner_recovery_required: bool,
}
/// A transfer of administrative ownership, never an implicit recovery or restart.
pub struct RecordingOperationsHandoff {
    pub supervisor: RecordingSupervisor,
    pub evidence: RecordingOperationsRecoveryEvidence,
}
pub struct RecordingOperationsInitError {
    pub error: OwnerError,
    pub supervisor: RecordingSupervisor,
}
impl fmt::Debug for RecordingOperationsInitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RecordingOperationsInitError")
            .field("error", &self.error)
            .field("supervisor", &"RecordingSupervisor(..)")
            .finish()
    }
}
