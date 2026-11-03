use super::*;
use crate::recording_host::{RecordingHostError, SupervisorError};
use scada_historian::store::{query::QueryError, StoreError};
use serde_json::{json, Value};
pub(super) const MAX_SAFE: u64 = 9_007_199_254_740_991;
fn revision(value: &Value) -> Result<Option<u64>, OperationErrorCode> {
    if value.is_null() {
        return Ok(None);
    }
    let n = value
        .as_f64()
        .filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= 1.0 && *v <= MAX_SAFE as f64)
        .ok_or(OperationErrorCode::InvalidRequest)?;
    Ok(Some(n as u64))
}
pub(super) fn apply(
    request: &RecordingChangeRequest,
) -> Result<ApplyRecordingPlanRequest, OperationErrorCode> {
    let a = &request.as_value()["apply"];
    let native = ApplyRecordingPlanRequest {
        request_id: a["requestId"]
            .as_str()
            .ok_or(OperationErrorCode::InvalidRequest)?
            .into(),
        desired: a["desired"].clone(),
        expected_applied_revision: revision(&a["expectedAppliedRevision"])?,
        expected_mapping_revision: revision(&a["expectedMappingRevision"])?,
        expected_retention_applied_revision: revision(&a["expectedRetentionAppliedRevision"])?,
    };
    native
        .validate()
        .map_err(|_| OperationErrorCode::InvalidRequest)?;
    Ok(native)
}
pub(super) fn request(
    change: &RecordingChangeRequest,
    id: &str,
    stage: Stage,
) -> Result<RecordingOperationRequest, OperationErrorCode> {
    RecordingOperationRequest::from_value(json!({"version":1,"kind":"recordingOperationRequest","operationId":id,"stage":stage.as_str(),"change":change.as_value()})).map_err(|_|OperationErrorCode::InvalidRequest)
}
pub(super) fn result(
    request: &RecordingOperationRequest,
    outcome: Value,
    confirmed: bool,
    recovery: bool,
) -> Result<Arc<RecordingOperationResult>, OperationErrorCode> {
    RecordingOperationResult::from_value(json!({"version":1,"kind":"recordingOperationResult","request":request.as_value(),"outcome":outcome,"quiescence":if confirmed{"confirmed"}else{"unknown"},"recoveryRequired":recovery})).map(Arc::new).map_err(|_|OperationErrorCode::ProjectionFailed)
}
pub(super) fn failed(
    request: &RecordingOperationRequest,
    code: OperationErrorCode,
    effect: &str,
    confirmed: bool,
    recovery: bool,
) -> Arc<RecordingOperationResult> {
    result(
        request,
        json!({"kind":"failed","error":code.as_str(),"effect":effect}),
        confirmed,
        recovery,
    )
    .expect("validated original request and fixed finite failure")
}
pub(super) fn control(c: &QueryControl) -> Result<(), OperationErrorCode> {
    c.validate()
        .map_err(|_| OperationErrorCode::InvalidRequest)?;
    if c.cancellation.is_cancelled() {
        return Err(OperationErrorCode::Cancelled);
    }
    if std::time::Instant::now() >= c.deadline {
        return Err(OperationErrorCode::DeadlineExceeded);
    }
    Ok(())
}
pub(super) fn query_error(e: QueryError) -> OperationErrorCode {
    use QueryError::*;
    match e {
        Cancelled => OperationErrorCode::Cancelled,
        Deadline => OperationErrorCode::DeadlineExceeded,
        ReaderUnusable => OperationErrorCode::ReaderUnusable,
        CorruptData => OperationErrorCode::CorruptData,
        InvalidRequest(_) | InvalidLimits | UnsupportedMode => OperationErrorCode::InvalidRequest,
        Database => OperationErrorCode::Internal,
        _ => OperationErrorCode::BudgetExceeded,
    }
}
pub(super) fn store_error(e: &StoreError) -> OperationErrorCode {
    use StoreError::*;
    match e {
        Busy => OperationErrorCode::Busy,
        Conflict => OperationErrorCode::Conflict,
        CorruptData => OperationErrorCode::CorruptData,
        NeedsReopen => OperationErrorCode::NeedsReopen,
        Control(e) => query_error(*e),
        RecordingPlanCapacity | RetentionLimit | MaintenanceLimit => {
            OperationErrorCode::BudgetExceeded
        }
        Invalid(_) | Contract(_) => OperationErrorCode::InvalidRequest,
        _ => OperationErrorCode::Internal,
    }
}
pub(super) fn supervisor_error(e: &SupervisorError) -> OperationErrorCode {
    use SupervisorError::*;
    match e {
        Busy => OperationErrorCode::Busy,
        NoRecording | ContextMismatch => OperationErrorCode::StaleRun,
        WrongPreflight | WrongInspection | WrongResume => OperationErrorCode::WrongOwner,
        NoCandidate => OperationErrorCode::NoCandidate,
        PauseRequired => OperationErrorCode::PauseRequired,
        CandidateConsumed | ResumeConsumed => OperationErrorCode::Consumed,
        ReaderUnusable | NoReader => OperationErrorCode::ReaderUnusable,
        ReaderFailed => OperationErrorCode::WorkerFailure,
        Request(e) => store_error(e),
        Host(e) => match e {
            RecordingHostError::PlanRecoveryRequired => OperationErrorCode::PlanRecoveryRequired,
            RecordingHostError::UncleanPause => OperationErrorCode::UncleanPause,
            RecordingHostError::RetentionPending | RecordingHostError::RetentionRearmRequired => {
                OperationErrorCode::RetentionBlocked
            }
            RecordingHostError::PlanRequest(e) => store_error(e),
            RecordingHostError::Source(_) => OperationErrorCode::SourceFailure,
            RecordingHostError::WorkerFailed => OperationErrorCode::WorkerFailure,
            _ => OperationErrorCode::Internal,
        },
        _ => OperationErrorCode::Internal,
    }
}
pub(super) fn recoverable(code: OperationErrorCode) -> bool {
    matches!(
        code,
        OperationErrorCode::Cancelled
            | OperationErrorCode::DeadlineExceeded
            | OperationErrorCode::BudgetExceeded
            | OperationErrorCode::Conflict
            | OperationErrorCode::InvalidRequest
            | OperationErrorCode::Busy
    )
}
