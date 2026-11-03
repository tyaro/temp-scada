//! H5b2: session-begin evidence, not worker/SDK activation.
mod read;
mod types;
mod write;
use super::read as plan_read;
use super::*;
use crate::store::{SessionState, SessionStatus};
pub use types::*;

fn validate(request: &ActivateRecordingPlanRequest) -> StoreResult<()> {
    if !id(&request.activation_id)
        || !id(&request.session_id)
        || ![
            request.expected_applied_revision,
            request.expected_mapping_revision,
            request.expected_retention_applied_revision,
        ]
        .into_iter()
        .all(|r| (1..=MAX_SAFE).contains(&r))
    {
        return invalid("invalid recording activation request");
    }
    evidence::TimedStart {
        clock_epoch: request.start.clock_epoch.clone(),
        at_ms: request.start.at_ms,
        plan: evidence::PlanRef {
            plan_id: "validation".into(),
            revision: 1,
        },
    }
    .validate()?;
    canonical::encode(request)?;
    Ok(())
}
pub(super) fn head(
    c: &Connection,
    b: &mut Budget,
    applied: Option<u64>,
    snapshot: u64,
    ledger: Option<&str>,
) -> StoreResult<Option<u64>> {
    b.work.statement()?;
    b.row()?;
    type Row = (Option<i64>, i64, Option<i64>, i64, Option<i64>, Option<i64>);
    let row:Option<Row>=c.query_row("SELECT last_sequence,activation_count,(SELECT max(sequence) FROM recording_activations),(SELECT count(*) FROM recording_activations),(SELECT max(applied_revision) FROM recording_activations),(SELECT max(commit_version) FROM recording_activations) FROM recording_activation_state WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?;
    let (last, count, max, actual, max_applied, max_commit) = row.ok_or(StoreError::CorruptData)?;
    if last != max
        || count != actual
        || count != last.unwrap_or(0)
        || !(0..=MAX_LEDGER_ENTRIES as i64).contains(&count)
        || (last.is_some()
            && (applied.is_none()
                || max_applied.is_none_or(|r| r <= 0 || Some(r as u64) > applied)
                || max_commit.is_none_or(|n| n <= 0 || n as u64 > snapshot)))
    {
        return Err(StoreError::CorruptData);
    }
    if let Some(ledger) = ledger {
        // Only relational metadata, never historical receipt bodies or samples.
        b.work.statement()?;
        b.row()?;
        let broken: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_evidence e WHERE e.plan_id=?1 AND NOT EXISTS(SELECT 1 FROM recording_activations a WHERE a.session_id=e.session_id AND a.applied_revision=e.plan_revision AND a.clock_epoch=e.clock_epoch)) OR EXISTS(SELECT 1 FROM recording_activations a LEFT JOIN session_evidence e ON e.session_id=a.session_id LEFT JOIN sessions s ON s.session_id=a.session_id WHERE e.session_id IS NULL OR s.session_id IS NULL OR e.plan_id!=?1 OR e.plan_revision!=a.applied_revision OR e.clock_epoch!=a.clock_epoch OR s.begin_commit!=a.commit_version) OR EXISTS(SELECT 1 FROM recording_plans p WHERE p.plan_id=?1 AND NOT EXISTS(SELECT 1 FROM recording_activations a WHERE a.applied_revision=p.revision)) OR EXISTS(SELECT 1 FROM recording_activations a JOIN session_members m ON m.session_id=a.session_id LEFT JOIN series s ON s.series_id=m.series_id LEFT JOIN segments d ON d.series_id=m.series_id AND d.segment_id=m.segment_id WHERE s.series_id IS NULL OR d.segment_id IS NULL)",
            [ledger], |r| r.get(0),
        )?;
        if broken {
            return Err(StoreError::CorruptData);
        }
    }
    Ok(last.map(|n| n as u64))
}
fn find(c: &Connection, b: &mut Budget, key: &str) -> StoreResult<Option<u64>> {
    b.work.statement()?;
    let seq: Option<i64> = c
        .query_row(
            "SELECT sequence FROM recording_activations WHERE activation_id=?1",
            [key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(n) = seq {
        b.row()?;
        if !(1..=MAX_LEDGER_ENTRIES as i64).contains(&n) {
            return Err(StoreError::CorruptData);
        }
    }
    Ok(seq.map(|n| n as u64))
}
impl SqliteStore {
    /// Commits a timed session bound to current applied configuration. Does not start a worker.
    pub fn activate_recording_plan(
        &mut self,
        request: &ActivateRecordingPlanRequest,
        control: &QueryControl,
    ) -> StoreResult<RecordingActivationReceipt> {
        self.activate_with_hook(request, control, &mut |_| Ok(()))
    }
    fn activate_with_hook(
        &mut self,
        request: &ActivateRecordingPlanRequest,
        control: &QueryControl,
        hook: &mut impl FnMut(Boundary) -> StoreResult<()>,
    ) -> StoreResult<RecordingActivationReceipt> {
        validate(request)?;
        let payload = canonical::encode(request)?;
        self.run_maintenance(&bounded(control), false, |c, b| {
            write::activate(c, b, request, &payload, hook)
        })
    }
    /// Stable begin receipt and the session's current active/closed/interrupted status.
    pub fn recording_activation(
        &mut self,
        key: &str,
        control: &QueryControl,
    ) -> StoreResult<Option<RecordingActivation>> {
        if !id(key) {
            return invalid("invalid recording activation ID");
        }
        self.run_maintenance(&bounded(control), true, |c, b| {
            sql(c, b, "BEGIN DEFERRED")?;
            let h = plan_read::heads(c, b)?;
            let result = find(c, b, key)?
                .map(|n| read::load(c, b, n, &h))
                .transpose()?
                .map(|r| r.1);
            b.result(&serde_json::to_value(&result)?)?;
            sql(c, b, "ROLLBACK")?;
            Ok(result)
        })
    }
    /// Discovers the latest committed activation after restart without reopening it.
    pub fn recording_activation_state(
        &mut self,
        control: &QueryControl,
    ) -> StoreResult<RecordingActivationState> {
        self.run_maintenance(&bounded(control), true, |c, b| {
            sql(c, b, "BEGIN DEFERRED")?;
            let h = plan_read::heads(c, b)?;
            let latest = h
                .activation
                .map(|n| read::load(c, b, n, &h))
                .transpose()?
                .map(|r| r.1);
            let result = RecordingActivationState {
                snapshot_commit: h.snapshot,
                latest,
            };
            b.result(&serde_json::to_value(&result)?)?;
            sql(c, b, "ROLLBACK")?;
            Ok(result)
        })
    }
}
#[cfg(test)]
mod tests;
