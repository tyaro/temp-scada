//! H2b3 durable recording evidence. This is not public coverage projection.
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use super::{
    id, invalid, next_commit, status, Boundary, SessionSpec, SessionState, SessionStatus,
    SqliteStore, StoreError, StoreResult, Tick, MAX_SAFE,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRef {
    pub plan_id: String,
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClockStamp {
    pub clock_epoch: String,
    pub at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimedStart {
    pub clock_epoch: String,
    pub at_ms: i64,
    pub plan: PlanRef,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionEvidence {
    pub session_id: String,
    pub start: TimedStart,
    pub observed_frontier_ms: i64,
    /// Only an explicit normal close supplies this exclusive boundary.
    pub end_ms: Option<i64>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GapReason {
    SamplingMissed,
    StorageLoss,
}

/// A no-record claim for ALL members, scoped to one session and clock domain.
/// observed_at_ms is a caller-supplied fact, not the machine's current clock.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GapEvidence {
    pub session_id: String,
    pub gap_id: String,
    pub clock_epoch: String,
    pub from_ms: i64,
    pub to_ms: i64,
    pub observed_at_ms: i64,
    pub reason: GapReason,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GapReceipt {
    pub session_id: String,
    pub gap_id: String,
    pub commit_version: u64,
}

fn safe_time(value: i64) -> bool {
    (-(MAX_SAFE as i64)..=MAX_SAFE as i64).contains(&value)
}
impl TimedStart {
    pub(super) fn validate(&self) -> StoreResult<()> {
        if !id(&self.clock_epoch)
            || !safe_time(self.at_ms)
            || !id(&self.plan.plan_id)
            || !(1..=MAX_SAFE).contains(&self.plan.revision)
        {
            return invalid("invalid recording start evidence");
        }
        Ok(())
    }
}
impl ClockStamp {
    fn validate(&self) -> StoreResult<()> {
        if !id(&self.clock_epoch) || !safe_time(self.at_ms) {
            return invalid("invalid clock stamp");
        }
        Ok(())
    }
}
impl GapEvidence {
    fn validate(&self) -> StoreResult<()> {
        if !id(&self.session_id)
            || !id(&self.gap_id)
            || !id(&self.clock_epoch)
            || !safe_time(self.from_ms)
            || !safe_time(self.to_ms)
            || !safe_time(self.observed_at_ms)
            || self.from_ms >= self.to_ms
            || self.to_ms > self.observed_at_ms
        {
            return invalid("invalid recording gap evidence");
        }
        Ok(())
    }
}

impl SqliteStore {
    pub fn begin_timed_session(
        &mut self,
        spec: SessionSpec,
        start: TimedStart,
    ) -> StoreResult<SessionStatus> {
        self.check_writable()?;
        let result = self.begin_evidence_with_hook(spec, Some(start), &mut |_| Ok(()));
        self.after_write(result)
    }

    pub fn close_timed_session(
        &mut self,
        session: &str,
        stamp: ClockStamp,
    ) -> StoreResult<SessionStatus> {
        self.check_writable()?;
        let result = self.close_evidence_with_hook(session, Some(stamp), &mut |_| Ok(()));
        self.after_write(result)
    }

    /// Ends ownership of an active session without inventing a UTC end time.
    pub fn interrupt_session(&mut self, session: &str) -> StoreResult<SessionStatus> {
        self.check_writable()?;
        let result = self.interrupt_with_hook(session, &mut |_| Ok(()));
        self.after_write(result)
    }

    fn interrupt_with_hook(
        &mut self,
        session: &str,
        hook: &mut impl FnMut(Boundary) -> StoreResult<()>,
    ) -> StoreResult<SessionStatus> {
        let tx = self.connection.transaction()?;
        let Some(mut existing) = status(&tx, session)? else {
            return invalid("unknown session");
        };
        if existing.state != SessionState::Active {
            return Ok(existing);
        }
        let commit = next_commit(&tx)?;
        tx.execute(
            "UPDATE sessions SET state = 'interrupted', end_commit = ?1 WHERE session_id = ?2",
            params![commit, session],
        )?;
        hook(Boundary::Metadata)?;
        hook(Boundary::BeforeCommit)?;
        tx.commit()?;
        hook(Boundary::AfterCommit)?;
        existing.state = SessionState::Interrupted;
        existing.end_commit_version = Some(commit as u64);
        Ok(existing)
    }

    pub fn session_evidence(&self, session: &str) -> StoreResult<Option<SessionEvidence>> {
        load(&self.connection, session)
    }

    /// Does not create observations or advance session committedThrough.
    pub fn record_gap(&mut self, gap: GapEvidence) -> StoreResult<GapReceipt> {
        self.check_writable()?;
        let result = self.gap_with_hook(gap, &mut |_| Ok(()));
        self.after_write(result)
    }

    fn gap_with_hook(
        &mut self,
        gap: GapEvidence,
        hook: &mut impl FnMut(Boundary) -> StoreResult<()>,
    ) -> StoreResult<GapReceipt> {
        gap.validate()?;
        let payload = serde_json::to_string(&gap)?;
        let tx = self.connection.transaction()?;
        let existing: Option<(String, i64)> = tx.query_row("SELECT payload_json, commit_version FROM recording_gaps WHERE session_id = ?1 AND gap_id = ?2",
            params![gap.session_id, gap.gap_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        if let Some((old, commit)) = existing {
            return if old == payload {
                Ok(gap_receipt(&gap, commit))
            } else {
                Err(StoreError::Conflict)
            };
        }
        let Some(session) = status(&tx, &gap.session_id)? else {
            return invalid("unknown session");
        };
        if session.state != SessionState::Active {
            return Err(StoreError::SessionInactive);
        }
        let Some(evidence) = load(&tx, &gap.session_id)? else {
            return invalid("timed recording evidence required");
        };
        if gap.clock_epoch != evidence.start.clock_epoch
            || gap.from_ms < evidence.start.at_ms
            || gap.observed_at_ms < evidence.observed_frontier_ms
        {
            return invalid("gap violates recording clock boundary");
        }
        if tx.query_row("SELECT EXISTS(SELECT 1 FROM observations WHERE session_id = ?1 AND sample_time_ms >= ?2 AND sample_time_ms < ?3)",
            params![gap.session_id, gap.from_ms, gap.to_ms], |r| r.get::<_, bool>(0))? { return Err(StoreError::Conflict); }
        let previous: Option<i64> = tx.query_row("SELECT to_ms FROM recording_gaps WHERE session_id = ?1 AND from_ms < ?2 ORDER BY from_ms DESC LIMIT 1",
            params![gap.session_id, gap.to_ms], |r| r.get(0)).optional()?;
        if previous.is_some_and(|end| end > gap.from_ms) {
            return Err(StoreError::Conflict);
        }
        let commit = next_commit(&tx)?;
        tx.execute(
            "INSERT INTO recording_gaps VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                gap.session_id,
                gap.gap_id,
                gap.clock_epoch,
                gap.from_ms,
                gap.to_ms,
                gap.observed_at_ms,
                super::enum_text(Some(gap.reason))?,
                payload,
                commit
            ],
        )?;
        tx.execute(
            "UPDATE session_evidence SET observed_frontier_ms = ?1 WHERE session_id = ?2",
            params![gap.observed_at_ms, gap.session_id],
        )?;
        hook(Boundary::Metadata)?;
        hook(Boundary::BeforeCommit)?;
        tx.commit()?;
        hook(Boundary::AfterCommit)?;
        Ok(gap_receipt(&gap, commit))
    }
}

fn gap_receipt(gap: &GapEvidence, commit: i64) -> GapReceipt {
    GapReceipt {
        session_id: gap.session_id.clone(),
        gap_id: gap.gap_id.clone(),
        commit_version: commit as u64,
    }
}

pub(super) fn load(connection: &Connection, session: &str) -> StoreResult<Option<SessionEvidence>> {
    type EvidenceRow = (String, i64, String, i64, i64, Option<i64>);
    let row: Option<EvidenceRow> = connection.query_row("SELECT clock_epoch, start_ms, plan_id, plan_revision, observed_frontier_ms, end_ms FROM session_evidence WHERE session_id = ?1", [session],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).optional()?;
    Ok(row.map(
        |(clock_epoch, at_ms, plan_id, revision, observed_frontier_ms, end_ms)| SessionEvidence {
            session_id: session.to_owned(),
            start: TimedStart {
                clock_epoch,
                at_ms,
                plan: PlanRef {
                    plan_id,
                    revision: revision as u64,
                },
            },
            observed_frontier_ms,
            end_ms,
        },
    ))
}

pub(super) fn save_start(
    tx: &Transaction<'_>,
    spec: &SessionSpec,
    start: &TimedStart,
    commit: i64,
) -> StoreResult<()> {
    let members = serde_json::to_string(&spec.members)?;
    let old: Option<String> = tx
        .query_row(
            "SELECT members_json FROM recording_plans WHERE plan_id = ?1 AND revision = ?2",
            params![start.plan.plan_id, start.plan.revision as i64],
            |r| r.get(0),
        )
        .optional()?;
    match old {
        Some(old) if old != members => return Err(StoreError::Conflict),
        Some(_) => {}
        None => {
            tx.execute(
                "INSERT INTO recording_plans VALUES (?1, ?2, ?3, ?4)",
                params![
                    start.plan.plan_id,
                    start.plan.revision as i64,
                    members,
                    commit
                ],
            )?;
        }
    }
    tx.execute(
        "INSERT INTO session_evidence VALUES (?1, ?2, ?3, ?4, ?5, ?5, NULL)",
        params![
            spec.session_id,
            start.plan.plan_id,
            start.plan.revision as i64,
            start.clock_epoch,
            start.at_ms
        ],
    )?;
    Ok(())
}

pub(super) fn check_close(
    tx: &Transaction<'_>,
    session: &SessionStatus,
    stamp: Option<&ClockStamp>,
) -> StoreResult<()> {
    if let Some(stamp) = stamp {
        stamp.validate()?;
    }
    let Some(evidence) = load(tx, &session.spec.session_id)? else {
        return if stamp.is_some() {
            invalid("cannot backfill recording evidence")
        } else {
            Ok(())
        };
    };
    let Some(stamp) = stamp else {
        return if session.state == SessionState::Active {
            invalid("timed close stamp required")
        } else {
            Ok(())
        };
    };
    if session.state == SessionState::Closed {
        return if evidence.end_ms == Some(stamp.at_ms)
            && evidence.start.clock_epoch == stamp.clock_epoch
        {
            Ok(())
        } else {
            Err(StoreError::Conflict)
        };
    }
    if session.state != SessionState::Active {
        return Err(StoreError::SessionInactive);
    }
    let latest: Option<i64> = tx.query_row(
        "SELECT MAX(sample_time_ms) FROM observations WHERE session_id = ?1",
        [&session.spec.session_id],
        |r| r.get(0),
    )?;
    if stamp.clock_epoch != evidence.start.clock_epoch
        || stamp.at_ms <= evidence.start.at_ms
        || stamp.at_ms < evidence.observed_frontier_ms
        || latest.is_some_and(|time| stamp.at_ms <= time)
    {
        return invalid("close violates recording clock boundary");
    }
    Ok(())
}

pub(super) fn advance_tick(tx: &Transaction<'_>, tick: &Tick) -> StoreResult<()> {
    let Some(evidence) = load(tx, &tick.session_id)? else {
        return Ok(());
    };
    if tick.clock_epoch != evidence.start.clock_epoch
        || tick.sample_time_ms < evidence.observed_frontier_ms
    {
        return invalid("tick violates recording clock boundary");
    }
    let previous: Option<i64> = tx.query_row("SELECT to_ms FROM recording_gaps WHERE session_id = ?1 AND from_ms <= ?2 ORDER BY from_ms DESC LIMIT 1",
        params![tick.session_id, tick.sample_time_ms], |r| r.get(0)).optional()?;
    if previous.is_some_and(|end| tick.sample_time_ms < end) {
        return Err(StoreError::Conflict);
    }
    tx.execute(
        "UPDATE session_evidence SET observed_frontier_ms = ?1 WHERE session_id = ?2",
        params![tick.sample_time_ms, tick.session_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests;
