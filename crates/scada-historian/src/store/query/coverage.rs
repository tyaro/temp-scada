//! Conservative projection of domain-scoped no-record evidence into UTC coverage.
use rusqlite::{params, types::FromSql, Connection, Row};
mod expired;
use serde_json::{json, Value};
use std::collections::HashMap;

use super::{control::Budget, QueryError};
use crate::store::{
    evidence::{GapEvidence, GapReason, PlanRef, TimedStart},
    id, IdentityDescriptor, SessionSpec, MAX_SAFE,
};

const SESSION_LIMIT: usize = 256;
const GAP_LIMIT: usize = 1024;
const COVERAGE_LIMIT: usize = 256;

struct Domain {
    session: String,
    start: TimedStart,
    frontier: i64,
    end: Option<i64>,
    begin_commit: i64,
    end_commit: Option<i64>,
    snapshot_commit: i64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Reason {
    SamplingMissed,
    StorageLoss,
    Unknown,
    Expired,
}
impl Reason {
    fn text(self) -> &'static str {
        match self {
            Self::SamplingMissed => "samplingMissed",
            Self::StorageLoss => "storageLoss",
            Self::Unknown => "unknownCoverage",
            Self::Expired => "expired",
        }
    }
}
struct Span {
    from: i64,
    to: i64,
    reason: Reason,
}

pub(super) fn project(
    connection: &Connection,
    series: &str,
    query: &Value,
    budget: &mut Budget,
) -> Result<Vec<Value>, QueryError> {
    let base = base(connection, series, query, budget)?;
    let spans = expired::overlay(connection, series, query, base, budget)?;
    if spans.len() > COVERAGE_LIMIT {
        return Err(QueryError::CoverageLimit);
    }
    publish(connection, series, spans, query, budget)
}

fn base(
    connection: &Connection,
    series: &str,
    query: &Value,
    budget: &mut Budget,
) -> Result<Vec<Span>, QueryError> {
    let from = crate::integer(&query["fromMs"]);
    let to = crate::integer(&query["toMs"]);
    let (domains, untimed) = domains(connection, series, budget)?;
    if untimed {
        return Ok(vec![Span {
            from,
            to,
            reason: Reason::Unknown,
        }]);
    }

    let gaps = gaps(connection, series, from, to, &domains, budget)?;
    let mut fragments = Vec::new();
    for gap in gaps {
        budget.work.check()?;
        let a = gap.from_ms.max(from);
        let b = gap.to_ms.min(to);
        let mut blockers = Vec::new();
        for domain in domains.values() {
            budget.work.check()?;
            if domain.session == gap.session_id {
                continue;
            }
            let low = domain.start.at_ms.max(a);
            let high = domain.end.unwrap_or(to).min(b);
            if low < high {
                blockers.push((low, high));
            }
        }
        blockers.sort_unstable();
        let mut cursor = a;
        let reason = match gap.reason {
            GapReason::SamplingMissed => Reason::SamplingMissed,
            GapReason::StorageLoss => Reason::StorageLoss,
        };
        for (low, high) in blockers {
            budget.work.check()?;
            if low > cursor {
                fragments.push(Span {
                    from: cursor,
                    to: low,
                    reason,
                });
            }
            cursor = cursor.max(high);
        }
        if cursor < b {
            fragments.push(Span {
                from: cursor,
                to: b,
                reason,
            });
        }
    }
    fragments.sort_by_key(|s| (s.from, s.to));
    let mut result: Vec<Span> = Vec::new();
    let mut cursor = from;
    for span in fragments {
        budget.work.check()?;
        if span.from < cursor {
            return Err(QueryError::CorruptData);
        }
        if span.from > cursor {
            append(
                &mut result,
                Span {
                    from: cursor,
                    to: span.from,
                    reason: Reason::Unknown,
                },
            )?;
        }
        cursor = span.to;
        append(&mut result, span)?;
    }
    if cursor < to {
        append(
            &mut result,
            Span {
                from: cursor,
                to,
                reason: Reason::Unknown,
            },
        )?;
    }
    Ok(result)
}

fn append(result: &mut Vec<Span>, span: Span) -> Result<(), QueryError> {
    if let Some(previous) = result.last_mut() {
        if previous.to == span.from && previous.reason == span.reason {
            previous.to = span.to;
            return Ok(());
        }
    }
    result.push(span);
    Ok(())
}

fn publish(
    connection: &Connection,
    series: &str,
    spans: Vec<Span>,
    query: &Value,
    budget: &mut Budget,
) -> Result<Vec<Value>, QueryError> {
    let mut result = Vec::new();
    for span in spans {
        budget.work.check()?;
        if span.reason != Reason::Unknown {
            budget.work.statement()?;
            let exists: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM observations WHERE series_id = ?1 AND sample_time_ms >= ?2 AND sample_time_ms < ?3)",
                params![series, span.from, span.to], |r| r.get(0))?;
            budget.row()?;
            if exists {
                return Err(QueryError::CorruptData);
            }
        }
        let from = if span.from == crate::integer(&query["fromMs"]) {
            query["fromMs"].clone()
        } else {
            json!(span.from)
        };
        let to = if span.to == crate::integer(&query["toMs"]) {
            query["toMs"].clone()
        } else {
            json!(span.to)
        };
        let value = json!({"fromMs":from,"toMs":to,"reason":span.reason.text()});
        budget.value(&value)?;
        result.push(value);
    }
    Ok(result)
}

fn required<T: FromSql>(row: &Row<'_>, field: &str) -> Result<T, QueryError> {
    row.get(field).map_err(|_| QueryError::CorruptData)
}

fn domains(
    connection: &Connection,
    series: &str,
    budget: &mut Budget,
) -> Result<(HashMap<String, Domain>, bool), QueryError> {
    budget.work.statement()?;
    let mut statement = connection.prepare(
        "SELECT s.session_id, s.spec_json, s.state, s.last_sequence, s.begin_commit, s.end_commit, m.segment_id,
         e.session_id AS evidence_id, e.clock_epoch, e.start_ms, e.observed_frontier_ms, e.end_ms, e.plan_id, e.plan_revision,
         p.members_json, p.created_commit, meta.last_commit, d.descriptor_json AS member_descriptor
         FROM session_members AS m LEFT JOIN sessions AS s ON s.session_id = m.session_id
         LEFT JOIN session_evidence AS e ON e.session_id = s.session_id
         LEFT JOIN recording_plans AS p ON p.plan_id = e.plan_id AND p.revision = e.plan_revision
         LEFT JOIN segments AS d ON d.series_id = m.series_id AND d.segment_id = m.segment_id
         CROSS JOIN store_meta AS meta
         WHERE m.series_id = ?1 AND meta.singleton = 1 ORDER BY s.begin_commit, s.session_id LIMIT 257")?;
    let mut rows = statement.query([series])?;
    let mut result = HashMap::new();
    let mut untimed = false;
    let mut count = 0;
    while let Some(row) = rows.next()? {
        budget.row()?;
        count += 1;
        if count > SESSION_LIMIT {
            return Err(QueryError::EvidenceLimit);
        }
        let session: String = required(row, "session_id")?;
        let spec_text: String = required(row, "spec_json")?;
        budget.evidence_text(&spec_text)?;
        let spec: SessionSpec = serde_json::from_str(&spec_text)?;
        let spec = spec.validated().map_err(|_| QueryError::CorruptData)?;
        let segment: String = required(row, "segment_id")?;
        if spec.session_id != session
            || !spec
                .members
                .iter()
                .any(|m| m.series_id == series && m.segment_id == segment)
        {
            return Err(QueryError::CorruptData);
        }
        let descriptor_text: String = required(row, "member_descriptor")?;
        budget.evidence_text(&descriptor_text)?;
        let descriptor: IdentityDescriptor = serde_json::from_str(&descriptor_text)?;
        if !spec
            .members
            .iter()
            .any(|member| *member == descriptor && member.series_id == series)
        {
            return Err(QueryError::CorruptData);
        }
        let state: String = required(row, "state")?;
        let sequence: i64 = required(row, "last_sequence")?;
        let begin_commit: i64 = required(row, "begin_commit")?;
        let end_commit: Option<i64> = required(row, "end_commit")?;
        let snapshot_commit: i64 = required(row, "last_commit")?;
        if !(0..=MAX_SAFE as i64).contains(&sequence)
            || begin_commit <= 0
            || begin_commit > snapshot_commit
            || (state == "active" && end_commit.is_some())
            || (state != "active"
                && !end_commit.is_some_and(|end| end > begin_commit && end <= snapshot_commit))
            || !matches!(state.as_str(), "active" | "closed" | "interrupted")
        {
            return Err(QueryError::CorruptData);
        }
        let evidence_id: Option<String> = required(row, "evidence_id")?;
        if evidence_id.is_none() {
            untimed = true;
            continue;
        }
        if evidence_id.as_deref() != Some(&session) {
            return Err(QueryError::CorruptData);
        }
        let start = TimedStart {
            clock_epoch: required(row, "clock_epoch")?,
            at_ms: required(row, "start_ms")?,
            plan: PlanRef {
                plan_id: required(row, "plan_id")?,
                revision: u64::try_from(required::<i64>(row, "plan_revision")?)
                    .map_err(|_| QueryError::CorruptData)?,
            },
        };
        start.validate().map_err(|_| QueryError::CorruptData)?;
        let frontier: i64 = required(row, "observed_frontier_ms")?;
        let end: Option<i64> = required(row, "end_ms")?;
        if frontier < start.at_ms
            || frontier > MAX_SAFE as i64
            || (state == "closed" && !end.is_some_and(|end| end > start.at_ms && end == frontier))
            || (state != "closed" && end.is_some())
        {
            return Err(QueryError::CorruptData);
        }
        let plan_text: String = required(row, "members_json")?;
        budget.evidence_text(&plan_text)?;
        let members: Vec<IdentityDescriptor> = serde_json::from_str(&plan_text)?;
        let plan = SessionSpec {
            session_id: session.clone(),
            members,
        }
        .validated()
        .map_err(|_| QueryError::CorruptData)?;
        let plan_commit: i64 = required(row, "created_commit")?;
        if spec.members != plan.members || plan_commit <= 0 || plan_commit > begin_commit {
            return Err(QueryError::CorruptData);
        }
        let domain = Domain {
            session: session.clone(),
            start,
            frontier,
            end,
            begin_commit,
            end_commit,
            snapshot_commit,
        };
        if result.insert(session, domain).is_some() {
            return Err(QueryError::CorruptData);
        }
    }
    if count == 0 {
        return Err(QueryError::CorruptData);
    }
    Ok((result, untimed))
}

fn gaps(
    connection: &Connection,
    series: &str,
    from: i64,
    to: i64,
    domains: &HashMap<String, Domain>,
    budget: &mut Budget,
) -> Result<Vec<GapEvidence>, QueryError> {
    budget.work.statement()?;
    let mut statement = connection.prepare(
        "SELECT g.session_id, g.gap_id, g.clock_epoch, g.from_ms, g.to_ms, g.observed_at_ms, g.reason, g.payload_json, g.commit_version
         FROM recording_gaps AS g JOIN session_members AS m ON m.session_id = g.session_id
         WHERE m.series_id = ?1 AND g.from_ms < ?3 AND g.to_ms > ?2
         ORDER BY g.session_id, g.from_ms, g.gap_id LIMIT 1025")?;
    let mut rows = statement.query(params![series, from, to])?;
    let mut result = Vec::new();
    let mut ends = HashMap::new();
    while let Some(row) = rows.next()? {
        budget.row()?;
        if result.len() == GAP_LIMIT {
            return Err(QueryError::EvidenceLimit);
        }
        let payload: String = required(row, "payload_json")?;
        budget.evidence_text(&payload)?;
        let gap: GapEvidence = serde_json::from_str(&payload)?;
        let reason: String = required(row, "reason")?;
        let reason: GapReason = serde_json::from_value(json!(reason))?;
        let saved = GapEvidence {
            session_id: required(row, "session_id")?,
            gap_id: required(row, "gap_id")?,
            clock_epoch: required(row, "clock_epoch")?,
            from_ms: required(row, "from_ms")?,
            to_ms: required(row, "to_ms")?,
            observed_at_ms: required(row, "observed_at_ms")?,
            reason,
        };
        let domain = domains
            .get(&gap.session_id)
            .ok_or(QueryError::CorruptData)?;
        let commit: i64 = required(row, "commit_version")?;
        if gap != saved
            || !id(&gap.gap_id)
            || gap.clock_epoch != domain.start.clock_epoch
            || gap.from_ms < domain.start.at_ms
            || gap.from_ms >= gap.to_ms
            || gap.to_ms > gap.observed_at_ms
            || gap.observed_at_ms > domain.frontier
            || domain.end.is_some_and(|end| gap.to_ms > end)
            || commit <= domain.begin_commit
            || commit > domain.snapshot_commit
            || domain.end_commit.is_some_and(|end| commit >= end)
            || ends
                .insert(gap.session_id.clone(), gap.to_ms)
                .is_some_and(|old| gap.from_ms < old)
        {
            return Err(QueryError::CorruptData);
        }
        result.push(gap);
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
