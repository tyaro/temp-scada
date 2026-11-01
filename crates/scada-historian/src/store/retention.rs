//! Explicit, quiescent maintenance of query observations, not physical erasure.
pub mod application;
pub mod clock_guard;
pub mod coordinator;
pub mod jobs;
pub mod policy;
pub mod preview;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};

use super::{
    id, invalid,
    maintenance::Operation as Maintenance,
    next_commit,
    query::{control::Budget, QueryControl},
    Boundary, SessionSpec, SqliteStore, StoreError, StoreResult, MAX_SAFE,
};

pub const MAX_TRIM_TICKS: usize = 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrimRequest {
    pub request_id: String,
    /// Explicit exclusive UTC cutoff, never calculated from the machine clock.
    pub cutoff_ms: i64,
    pub expected_cutoff_ms: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrimReceipt {
    pub request_id: String,
    pub cutoff_ms: i64,
    pub commit_version: u64,
    pub deleted_ticks: usize,
    pub deleted_observations: usize,
}

impl From<super::query::QueryError> for StoreError {
    fn from(error: super::query::QueryError) -> Self {
        Self::Control(error)
    }
}

fn safe(time: i64) -> bool {
    (-(MAX_SAFE as i64)..=MAX_SAFE as i64).contains(&time)
}

impl SqliteStore {
    /// Removes complete ticks before an explicit cutoff while no session is active.
    /// Existing readers retain their WAL snapshot. Receipts and their payloads remain.
    pub fn trim(
        &mut self,
        request: TrimRequest,
        control: &QueryControl,
    ) -> StoreResult<TrimReceipt> {
        self.check_writable()?;
        let result = self.trim_with_hook(request, control, &mut |_| Ok(()));
        self.after_write(result)
    }

    fn trim_with_hook(
        &mut self,
        request: TrimRequest,
        control: &QueryControl,
        hook: &mut impl FnMut(Boundary) -> StoreResult<()>,
    ) -> StoreResult<TrimReceipt> {
        control.validate()?;
        if !id(&request.request_id)
            || !safe(request.cutoff_ms)
            || request.expected_cutoff_ms.is_some_and(|t| !safe(t))
        {
            return invalid("invalid retention request");
        }
        let mut budget = Budget::new(control);
        budget.work.check()?;

        let result = {
            let guard = Maintenance {
                connection: &mut self.connection,
                needs_reopen: &mut self.needs_reopen,
            };
            let progress = Arc::clone(&budget.work);
            guard
                .connection
                .progress_handler(1000, Some(move || progress.progress()))?;
            let result = (|| {
                budget.work.statement()?;
                guard.connection.execute_batch("BEGIN IMMEDIATE")?;
                let receipt = trim_inner(guard.connection, &request, &mut budget, hook)?;
                budget.result(&serde_json::to_value(&receipt)?)?;
                budget.work.check()?;
                hook(Boundary::BeforeCommit)?;
                budget.work.statement()?;
                guard.connection.execute_batch("COMMIT")?;
                hook(Boundary::AfterCommit)?;
                Ok(receipt)
            })();
            // Translate interruption before cleanup removes the progress handler.
            match result {
                Err(StoreError::Sqlite(error)) => {
                    Err(super::maintenance::sqlite_failure(error, &budget))
                }
                other => other,
            }
        };
        if self.needs_reopen {
            return Err(StoreError::NeedsReopen);
        }
        result
    }
}

pub(super) fn check_tick(connection: &Connection, time: i64) -> StoreResult<()> {
    let (cutoff, _) = fence(connection)?;
    if cutoff.is_some_and(|cutoff| time < cutoff) {
        return Err(StoreError::RetentionCutoff);
    }
    Ok(())
}

/// Returns a validated current fence and revision; required singleton rows cannot disappear in a join.
pub(super) fn fence(connection: &Connection) -> StoreResult<(Option<i64>, i64)> {
    let (cutoff, revision): (Option<i64>, i64) = connection
        .query_row(
            "SELECT cutoff_ms, revision_commit FROM retention_state WHERE singleton = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or(StoreError::CorruptData)?;
    let snapshot: i64 = connection
        .query_row(
            "SELECT last_commit FROM store_meta WHERE singleton = 1",
            [],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(StoreError::CorruptData)?;
    if snapshot < 0 || revision < 0 || revision > snapshot {
        return Err(StoreError::CorruptData);
    }
    let latest: Option<(i64, i64)> = connection.query_row(
        "SELECT cutoff_ms, commit_version FROM retention_operations UNION ALL SELECT cutoff_ms, completion_commit AS commit_version FROM retention_jobs WHERE state = 'complete' ORDER BY commit_version DESC LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional()?;
    match cutoff {
        None if revision == 0 && latest.is_none() => {}
        Some(cutoff) if safe(cutoff) && revision > 0 && latest == Some((cutoff, revision)) => {}
        _ => return Err(StoreError::CorruptData),
    }
    Ok((cutoff, revision))
}

type TargetRow = (
    String,
    String,
    i64,
    Option<i64>,
    Option<String>,
    i64,
    Option<i64>,
    i64,
);

fn trim_inner(
    connection: &Connection,
    request: &TrimRequest,
    budget: &mut Budget,
    hook: &mut impl FnMut(Boundary) -> StoreResult<()>,
) -> StoreResult<TrimReceipt> {
    let payload = serde_json::to_string(request)?;
    budget.work.statement()?;
    let old: Option<(String, i64, i64, i64, i64)> = connection.query_row(
        "SELECT payload_json, cutoff_ms, commit_version, deleted_ticks, deleted_observations FROM retention_operations WHERE request_id = ?1",
        [&request.request_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    ).optional()?;
    if let Some((old, cutoff_ms, commit, ticks, observations)) = old {
        budget.row()?;
        budget.evidence_text(&old)?;
        if old != payload {
            return Err(StoreError::Conflict);
        }
        if cutoff_ms != request.cutoff_ms
            || commit <= 0
            || ticks < 0
            || ticks > MAX_TRIM_TICKS as i64
            || observations < ticks
            || observations > 8 * ticks
        {
            return Err(StoreError::CorruptData);
        }
        return Ok(TrimReceipt {
            request_id: request.request_id.clone(),
            cutoff_ms,
            commit_version: commit as u64,
            deleted_ticks: ticks as usize,
            deleted_observations: observations as usize,
        });
    }
    budget.work.statement()?;
    jobs::ensure_idle(connection)?;
    budget.row()?;
    budget.work.statement()?;
    budget.work.statement()?;
    budget.work.statement()?;
    let (cutoff, _) = fence(connection)?;
    budget.row()?;
    budget.row()?;
    budget.row()?;
    if cutoff != request.expected_cutoff_ms || cutoff.is_some_and(|t| request.cutoff_ms <= t) {
        return Err(StoreError::Conflict);
    }
    budget.work.statement()?;
    if connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE state = 'active')",
        [],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(StoreError::Busy);
    }
    budget.row()?;
    budget.work.statement()?;
    let mut statement = connection.prepare("SELECT session_id, sequence FROM observations WHERE sample_time_ms < ?1 GROUP BY session_id, sequence ORDER BY MIN(sample_time_ms), session_id, sequence LIMIT 1025")?;
    let mut rows = statement.query([request.cutoff_ms])?;
    let mut ticks = Vec::new();
    while let Some(row) = rows.next()? {
        budget.row()?;
        if ticks.len() == MAX_TRIM_TICKS {
            return Err(StoreError::RetentionLimit);
        }
        ticks.push((row.get::<_, String>(0)?, row.get::<_, i64>(1)?));
    }
    drop(rows);
    drop(statement);
    let (removed, observations) = validate_ticks(connection, &ticks, request.cutoff_ms, budget)?;
    budget.work.statement()?;
    budget.work.statement()?;
    budget.work.statement()?;
    budget.row()?;
    let commit = next_commit(connection)?;
    connection.execute(
        "INSERT INTO retention_operations VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            request.request_id,
            payload,
            request.cutoff_ms,
            commit,
            ticks.len() as i64,
            observations as i64
        ],
    )?;
    for ((series, time), count) in &removed {
        budget.work.statement()?;
        connection.execute(
            "INSERT INTO expired_samples VALUES (?1, ?2, ?3, ?4)",
            params![series, time, request.request_id, *count as i64],
        )?;
    }
    hook(Boundary::Metadata)?;
    budget.work.statement()?;
    let deleted = connection.execute(
        "DELETE FROM observations WHERE sample_time_ms < ?1",
        [request.cutoff_ms],
    )?;
    if deleted != observations {
        return Err(StoreError::CorruptData);
    }
    hook(Boundary::Observation)?;
    budget.work.statement()?;
    connection.execute(
        "UPDATE retention_state SET cutoff_ms = ?1, revision_commit = ?2 WHERE singleton = 1",
        params![request.cutoff_ms, commit],
    )?;
    hook(Boundary::Watermark)?;
    Ok(TrimReceipt {
        request_id: request.request_id.clone(),
        cutoff_ms: request.cutoff_ms,
        commit_version: commit as u64,
        deleted_ticks: ticks.len(),
        deleted_observations: observations,
    })
}

type DeletionCounts = (BTreeMap<(String, i64), usize>, usize);

fn validate_ticks(
    connection: &Connection,
    ticks: &[(String, i64)],
    cutoff_ms: i64,
    budget: &mut Budget,
) -> StoreResult<DeletionCounts> {
    let mut removed = BTreeMap::<(String, i64), usize>::new();
    let mut observations = 0;
    for (session_id, sequence) in ticks {
        budget.work.statement()?;
        let (text, state, last_sequence, receipt_commit, payload, begin, end, snapshot): TargetRow = connection.query_row(
            "SELECT s.spec_json, s.state, s.last_sequence, c.commit_version, c.payload_json, s.begin_commit, s.end_commit, m.last_commit FROM sessions s LEFT JOIN commits c ON c.session_id = s.session_id AND c.sequence = ?2 CROSS JOIN store_meta m WHERE s.session_id = ?1 AND m.singleton = 1",
            params![session_id, sequence], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
        ).optional()?.ok_or(StoreError::CorruptData)?;
        budget.row()?;
        budget.evidence_text(&text)?;
        let spec: SessionSpec = serde_json::from_str(&text).map_err(|_| StoreError::CorruptData)?;
        let spec = spec.validated().map_err(|_| StoreError::CorruptData)?;
        let payload = payload.ok_or(StoreError::CorruptData)?;
        budget.evidence_text(&payload)?;
        let payload: serde_json::Value =
            serde_json::from_str(&payload).map_err(|_| StoreError::CorruptData)?;
        if !matches!(state.as_str(), "closed" | "interrupted")
            || spec.session_id != *session_id
            || *sequence <= 0
            || *sequence > last_sequence
            || last_sequence > MAX_SAFE as i64
            || begin <= 0
            || end.is_none_or(|e| e <= begin || e > snapshot)
            || receipt_commit
                .is_none_or(|c| c <= begin || c > snapshot || end.is_some_and(|e| c >= e))
            || payload["sessionId"].as_str() != Some(session_id)
            || payload["sequence"].as_i64() != Some(*sequence)
            || payload["observations"]
                .as_array()
                .is_none_or(|a| a.len() != spec.members.len())
        {
            return Err(StoreError::CorruptData);
        }
        budget.work.statement()?;
        let mut statement = connection.prepare("SELECT series_id, segment_id, sample_time_ms, clock_epoch, commit_version FROM observations WHERE session_id = ?1 AND sequence = ?2 ORDER BY series_id")?;
        let mut rows = statement.query(params![session_id, sequence])?;
        let mut seen = 0;
        let mut stamp = None;
        while let Some(row) = rows.next()? {
            budget.row()?;
            let series: String = row.get(0)?;
            let segment: String = row.get(1)?;
            let time: i64 = row.get(2)?;
            let clock: String = row.get(3)?;
            let commit: i64 = row.get(4)?;
            let member = spec.members.get(seen).ok_or(StoreError::CorruptData)?;
            if member.series_id != series
                || member.segment_id != segment
                || !safe(time)
                || time >= cutoff_ms
                || !id(&clock)
                || Some(commit) != receipt_commit
                || payload["sampleTimeMs"].as_i64() != Some(time)
                || payload["clockEpoch"].as_str() != Some(&clock)
                || payload["observations"][seen]["seriesId"].as_str() != Some(&series)
                || stamp
                    .as_ref()
                    .is_some_and(|old| old != &(time, clock.clone(), commit))
            {
                return Err(StoreError::CorruptData);
            }
            stamp = Some((time, clock, commit));
            *removed.entry((series, time)).or_default() += 1;
            seen += 1;
        }
        if seen != spec.members.len() {
            return Err(StoreError::CorruptData);
        }
        observations += seen;
    }
    Ok((removed, observations))
}

#[cfg(test)]
mod tests;
