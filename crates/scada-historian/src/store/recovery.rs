//! Bounded, read-only discovery of persisted recording and retention state.
use super::{
    id,
    query::{control::Budget, QueryControl},
    retention::{
        self,
        jobs::{self, JobStatus, JobStepReceipt, JobStepRequest},
        TrimRequest,
    },
    SessionSpec, SqliteStore, StoreError, StoreResult, MAX_SAFE,
};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FenceSource {
    Initial,
    SingleTrim { request_id: String },
    CompletedJob { job_id: String },
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RetentionFence {
    pub cutoff_ms: Option<i64>,
    pub revision_commit: u64,
    pub source: FenceSource,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StepRecovery {
    pub request: JobStepRequest,
    pub receipt: JobStepReceipt,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveJobRecovery {
    pub status: JobStatus,
    pub last_step: Option<StepRecovery>,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoreRecoveryState {
    pub snapshot_commit: u64,
    pub retention_fence: RetentionFence,
    pub active_session_id: Option<String>,
    pub active_job: Option<ActiveJobRecovery>,
}

impl SqliteStore {
    /// Observes one snapshot. It does not reserve the next step or authorize a
    /// recording restart, and it never begins or advances a retention job.
    pub fn recovery_state(&mut self, control: &QueryControl) -> StoreResult<StoreRecoveryState> {
        self.recovery_with_hook(control, &mut || Ok(()))
    }

    fn recovery_with_hook(
        &mut self,
        control: &QueryControl,
        hook: &mut impl FnMut() -> StoreResult<()>,
    ) -> StoreResult<StoreRecoveryState> {
        self.run_maintenance(control, true, |connection, budget| {
            budget.work.statement()?;
            connection.execute_batch("BEGIN DEFERRED")?;
            budget.work.statement()?;
            let snapshot: i64 = connection
                .query_row(
                    "SELECT last_commit FROM store_meta WHERE singleton=1",
                    [],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or(StoreError::CorruptData)?;
            budget.row()?;
            if snapshot < 0 {
                return Err(StoreError::CorruptData);
            }
            hook()?;
            for _ in 0..3 {
                budget.work.statement()?;
                budget.row()?;
            }
            let (cutoff, revision) = retention::fence(connection)?;
            if revision > snapshot {
                return Err(StoreError::CorruptData);
            }
            let source = fence_source(connection, cutoff, revision, budget)?;
            let active_session_id = active_session(connection, snapshot, budget)?;
            let ids = active_job_ids(connection, budget)?;
            if active_session_id.is_some() && !ids.is_empty() {
                return Err(StoreError::CorruptData);
            }
            let active_job = ids
                .first()
                .map(|id| jobs::recover_active(connection, id, cutoff, revision, snapshot, budget))
                .transpose()?;
            let result = StoreRecoveryState {
                snapshot_commit: snapshot as u64,
                retention_fence: RetentionFence {
                    cutoff_ms: cutoff,
                    revision_commit: revision as u64,
                    source,
                },
                active_session_id,
                active_job,
            };
            budget.result(&serde_json::to_value(&result)?)?;
            budget.work.statement()?;
            connection.execute_batch("ROLLBACK")?;
            Ok(result)
        })
    }
}

fn active_job_ids(connection: &Connection, budget: &mut Budget) -> StoreResult<Vec<String>> {
    budget.work.statement()?;
    let mut statement = connection.prepare(
        "SELECT job_id FROM retention_jobs WHERE state='active' ORDER BY job_id LIMIT 2",
    )?;
    let mut rows = statement.query([])?;
    let mut ids = Vec::new();
    while let Some(row) = rows.next()? {
        budget.row()?;
        let value: String = row.get(0)?;
        budget.evidence_text(&value)?;
        if !id(&value) || !ids.is_empty() {
            return Err(StoreError::CorruptData);
        }
        ids.push(value);
    }
    Ok(ids)
}

fn fence_source(
    connection: &Connection,
    cutoff: Option<i64>,
    revision: i64,
    budget: &mut Budget,
) -> StoreResult<FenceSource> {
    budget.work.statement()?;
    let mut statement=connection.prepare("SELECT 'trim' AS kind,request_id AS id,cutoff_ms,commit_version FROM retention_operations UNION ALL SELECT 'job' AS kind,job_id AS id,cutoff_ms,completion_commit AS commit_version FROM retention_jobs WHERE state='complete' ORDER BY commit_version DESC LIMIT 2")?;
    let mut rows = statement.query([])?;
    let mut sources = Vec::new();
    while let Some(row) = rows.next()? {
        budget.row()?;
        sources.push((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
        ));
    }
    drop(rows);
    drop(statement);
    if revision == 0 {
        return if cutoff.is_none() && sources.is_empty() {
            Ok(FenceSource::Initial)
        } else {
            Err(StoreError::CorruptData)
        };
    }
    let Some((kind, key, time, commit)) = sources.first() else {
        return Err(StoreError::CorruptData);
    };
    budget.evidence_text(key)?;
    if !id(key)
        || *commit != revision
        || Some(*time) != cutoff
        || sources.get(1).is_some_and(|s| s.3 == revision)
    {
        return Err(StoreError::CorruptData);
    }
    match kind.as_str() {
        "trim" => {
            validate_trim(connection, key, *time, budget)?;
            Ok(FenceSource::SingleTrim {
                request_id: key.clone(),
            })
        }
        "job" => {
            jobs::validate_completed_source(connection, key, *time, revision, budget)?;
            Ok(FenceSource::CompletedJob {
                job_id: key.clone(),
            })
        }
        _ => Err(StoreError::CorruptData),
    }
}

fn validate_trim(
    connection: &Connection,
    key: &str,
    cutoff: i64,
    budget: &mut Budget,
) -> StoreResult<()> {
    budget.work.statement()?;
    let (payload,ticks,observations):(String,i64,i64)=connection.query_row("SELECT payload_json,deleted_ticks,deleted_observations FROM retention_operations WHERE request_id=?1",[key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    budget.row()?;
    budget.evidence_text(&payload)?;
    let request: TrimRequest =
        serde_json::from_str(&payload).map_err(|_| StoreError::CorruptData)?;
    if request.request_id != key
        || request.cutoff_ms != cutoff
        || request
            .expected_cutoff_ms
            .is_some_and(|t| t < -(MAX_SAFE as i64) || t >= cutoff)
        || !(0..=1024).contains(&ticks)
        || observations < ticks
        || observations > ticks * 8
    {
        return Err(StoreError::CorruptData);
    }
    Ok(())
}

type SessionRow = (String, String, i64, i64, Option<i64>);
fn active_session(
    connection: &Connection,
    snapshot: i64,
    budget: &mut Budget,
) -> StoreResult<Option<String>> {
    budget.work.statement()?;
    let mut statement=connection.prepare("SELECT session_id,spec_json,last_sequence,begin_commit,end_commit FROM sessions WHERE state='active' ORDER BY session_id LIMIT 2")?;
    let mut rows = statement.query([])?;
    let mut active: Option<SessionRow> = None;
    while let Some(row) = rows.next()? {
        budget.row()?;
        if active.is_some() {
            return Err(StoreError::CorruptData);
        }
        active = Some((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
        ));
    }
    drop(rows);
    drop(statement);
    let Some((session, text, sequence, begin, end)) = active else {
        return Ok(None);
    };
    budget.evidence_text(&text)?;
    let spec: SessionSpec = serde_json::from_str(&text).map_err(|_| StoreError::CorruptData)?;
    let spec = spec.validated().map_err(|_| StoreError::CorruptData)?;
    if !id(&session)
        || spec.session_id != session
        || !(0..=MAX_SAFE as i64).contains(&sequence)
        || begin <= 0
        || begin > snapshot
        || end.is_some()
    {
        return Err(StoreError::CorruptData);
    }
    budget.work.statement()?;
    let latest:Option<(i64,i64,String)>=connection.query_row("SELECT sequence,commit_version,payload_json FROM commits WHERE session_id=?1 ORDER BY sequence DESC LIMIT 1",[&session],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    match latest {
        None if sequence == 0 => {}
        Some((last, commit, payload)) => {
            budget.row()?;
            budget.evidence_text(&payload)?;
            let payload: serde_json::Value =
                serde_json::from_str(&payload).map_err(|_| StoreError::CorruptData)?;
            if last != sequence
                || sequence == 0
                || commit <= begin
                || commit > snapshot
                || payload["sessionId"].as_str() != Some(&session)
                || payload["sequence"].as_i64() != Some(sequence)
                || payload["observations"]
                    .as_array()
                    .is_none_or(|v| v.len() != spec.members.len())
            {
                return Err(StoreError::CorruptData);
            }
        }
        _ => return Err(StoreError::CorruptData),
    }
    Ok(Some(session))
}

#[cfg(test)]
mod tests;
