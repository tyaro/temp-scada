//! The recording management context and inspection of the desktop host
//! (management contract §4–§6, product-owner design §5 `recording_status`).
//! The DB part is one Supervisor resume inspection (one SQLite snapshot);
//! the Host part is the Supervisor's latest status, observed separately.
use scada_historian::store::query::QueryError;
use scada_historian::store::recording_plan::RecordingResumeState;
use scada_historian::store::{SessionState, StoreError};
use scada_runtime::recording_host::{
    RecordingCleanup, RecordingHostStatus, RecordingPhase, RecordingRun, RecordingStopReason,
    RecordingSupervisor,
};
use serde_json::{json, Value};

/// The display IDs of recording runs within one context (contract §6): the
/// latest run keeps its ID, a new run gets the next one, none is reused.
#[derive(Default)]
pub(super) struct RunRefs {
    next: u64,
    current: Option<(RecordingRun, String)>,
}

impl RunRefs {
    pub(super) fn get(&mut self, run: Option<&RecordingRun>) -> Option<String> {
        let run = run?;
        if let Some((known, id)) = &self.current {
            if known == run {
                return Some(id.clone());
            }
        }
        self.next += 1;
        let id = format!("run:{}", self.next);
        self.current = Some((run.clone(), id.clone()));
        Some(id)
    }
}

pub(super) fn store_error(error: &StoreError) -> &'static str {
    match error {
        StoreError::Busy => "busy",
        StoreError::CorruptData => "corruptData",
        StoreError::NeedsReopen => "needsReopen",
        StoreError::Control(error) => match error {
            QueryError::Cancelled => "cancelled",
            QueryError::Deadline => "deadlineExceeded",
            QueryError::WorkLimit | QueryError::ByteLimit => "budgetExceeded",
            QueryError::CorruptData => "corruptData",
            QueryError::ReaderUnusable => "readerUnusable",
            _ => "internal",
        },
        _ => "internal",
    }
}

/// The available DatabaseView of one resume inspection (contract §5).
pub(super) fn database(state: &RecordingResumeState) -> Value {
    let plan = &state.plan;
    let recovery = &state.recovery;
    let applied = plan.applied.as_ref().map(|applied| {
        json!({
            "appliedRevision": applied.receipt.applied_revision,
            "commitVersion": applied.receipt.commit_version,
            "desired": applied.request.desired,
            "mappingRevision": applied.receipt.mapping_revision,
            "retentionAppliedRevision": applied.receipt.retention_applied_revision,
        })
    });
    let activation = state.latest_activation.as_ref().map(|activation| {
        json!({
            "activationId": activation.receipt.activation_id,
            "appliedRevision": activation.receipt.applied_revision,
            "commitVersion": activation.receipt.commit_version,
            "sessionId": activation.receipt.spec.session_id,
            "state": match activation.session.state {
                SessionState::Active => "active",
                SessionState::Closed => "closed",
                SessionState::Interrupted => "interrupted",
            },
            "committedThrough": activation.session.committed_through,
            "endCommitVersion": activation.session.end_commit_version,
        })
    });
    json!({
        "state": "available",
        "snapshotCommit": state.snapshot_commit,
        "currentMappingRevision": plan.mapping.as_ref().map(|m| m.receipt.mapping_revision),
        "currentRetentionAppliedRevision": recovery
            .applied_retention_policy
            .as_ref()
            .map(|p| p.applied_revision),
        "applied": applied,
        "latestActivation": activation,
        "activeSessionId": recovery.active_session_id,
        "activeRetentionJobId": recovery.active_job.as_ref().map(|job| job.status.job_id.clone()),
        "retentionFence": {
            "cutoffMs": recovery.retention_fence.cutoff_ms,
            "commitVersion": recovery.retention_fence.revision_commit,
        },
    })
}

fn phase(phase: RecordingPhase) -> &'static str {
    match phase {
        RecordingPhase::Idle => "idle",
        RecordingPhase::Starting => "starting",
        RecordingPhase::Running => "running",
        RecordingPhase::Stopping => "stopping",
        RecordingPhase::FinishedUnjoined => "finishedUnjoined",
        RecordingPhase::Joined => "joined",
        RecordingPhase::Faulted => "faulted",
        RecordingPhase::NoStore => "noStore",
        RecordingPhase::Retaining => "retaining",
        RecordingPhase::ManagingPlan => "managingPlan",
    }
}

/// One issue, in the order typed recorder cause, start error, cleanup
/// failure, SDK shutdown failure (contract §6). No message is parsed.
fn issue(status: &RecordingHostStatus) -> &'static str {
    let progress = status.progress.as_ref();
    match progress.and_then(|p| p.stop_reason.as_ref()) {
        Some(RecordingStopReason::Clock(_)) => return "clock",
        Some(RecordingStopReason::Source(_)) => return "source",
        Some(RecordingStopReason::Store(_)) => return "store",
        Some(RecordingStopReason::InvalidObservation) => return "invalidObservation",
        Some(RecordingStopReason::ArithmeticOverflow) => return "arithmeticOverflow",
        _ => {}
    }
    if status.start_error.is_some() {
        return "unclassified";
    }
    if matches!(
        progress.and_then(|p| p.cleanup.as_ref()),
        Some(RecordingCleanup::Failed(_))
    ) {
        return "store";
    }
    if matches!(status.source_shutdown, Some(Err(_))) {
        return "source";
    }
    "none"
}

/// The observed HostView of `supervisor` (contract §6).
pub(super) fn host(supervisor: &RecordingSupervisor, runs: &mut RunRefs, now_ms: i64) -> Value {
    let status = supervisor.state().recording;
    let plan = supervisor.recording_plan_guard_state();
    let retention = supervisor.retention_guard_state();
    observed(
        &status,
        runs,
        now_ms,
        json!(plan.recovery_required),
        json!(retention.rearm_required),
        json!(retention.job_pending),
    )
}

/// The observed HostView of a Supervisor lent to an installed root's owner:
/// its recording status only. The plan and retention guards are inside the
/// owner and are not observed (`null`, contract §6).
pub(super) fn lent_host(status: &RecordingHostStatus, runs: &mut RunRefs, now_ms: i64) -> Value {
    observed(status, runs, now_ms, Value::Null, Value::Null, Value::Null)
}

fn observed(
    status: &RecordingHostStatus,
    runs: &mut RunRefs,
    now_ms: i64,
    plan_recovery_required: Value,
    retention_rearm_required: Value,
    retention_job_pending: Value,
) -> Value {
    json!({
        "state": "observed",
        "observedAtMs": now_ms,
        "runRef": runs.get(status.run.as_ref()),
        "sessionId": status.session_id,
        "phase": phase(status.phase),
        "stopRequested": status.stop_requested,
        "issue": issue(status),
        "cleanup": match status.progress.as_ref().and_then(|p| p.cleanup.as_ref()) {
            Some(RecordingCleanup::Closed) => "closed",
            Some(RecordingCleanup::Interrupted) => "interrupted",
            Some(RecordingCleanup::Failed(_)) => "failed",
            None => "unknown",
        },
        "sourceShutdown": match status.source_shutdown {
            Some(Ok(())) => "succeeded",
            Some(Err(_)) => "failed",
            None => "unknown",
        },
        "planRecoveryRequired": plan_recovery_required,
        "retentionRearmRequired": retention_rearm_required,
        "retentionJobPending": retention_job_pending,
    })
}
