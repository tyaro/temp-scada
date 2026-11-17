//! Deleting the old end of the `event` table by the terminal retention limit
//! (terminal settings design §3) and the retention status for
//! `alarm_settings_get` (§6). `session`, `last_state` and `applied` are never
//! deleted.
use std::collections::BTreeSet;

use scada_alarm::Session;
use serde::Serialize;
use sqlx::Row;

use super::{require_session, AlarmDb, AlarmDbError};

/// The events kept regardless of the limit: the newest event of the DB (the
/// start of the next unknown period) and, per `last_state` row, the newest
/// event with a display (the source copied into an end event). Without NULLs,
/// so `seq NOT IN (...)` stays true for the other events.
macro_rules! kept_seqs {
    () => {
        "SELECT kept FROM (SELECT MAX(seq) AS kept FROM event \
         UNION SELECT (SELECT MAX(e.seq) FROM event e WHERE e.condition_id = l.condition_id AND e.display IS NOT NULL) FROM last_state l) \
         WHERE kept IS NOT NULL"
    };
}
const KEPT_SEQS: &str = kept_seqs!();

const MS_PER_DAY: i64 = 86_400_000;

/// The terminal retention limit (terminal settings design §2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetentionLimit {
    Days(u32),
    Count(u32),
}

/// One deletion round.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PruneOutcome {
    pub deleted: u64,
    /// The round stopped at the batch limit; more may have expired.
    pub reached_batch: bool,
}

/// The retention status of `alarm_settings_get`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionStatus {
    pub event_count: u64,
    /// `at_ms` of the oldest (smallest seq) event that is not a kept event.
    pub oldest_at_ms: Option<i64>,
}

impl AlarmDb {
    /// Delete expired events in seq order, skipping kept events and stopping
    /// at the first event within the limit, so the history has no hole and
    /// only its old end moves. At most `batch` events per call; the caller's
    /// session must still own the DB.
    pub async fn prune(
        &self,
        session: &Session,
        limit: RetentionLimit,
        now_ms: i64,
        batch: usize,
    ) -> Result<PruneOutcome, AlarmDbError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        require_session(&mut tx, session).await?;
        let kept: BTreeSet<i64> = sqlx::query_scalar(KEPT_SEQS)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .collect();
        // (seq at or below, at_ms before): an event is expired when either holds.
        let (seq_cutoff, at_cutoff) = match limit {
            RetentionLimit::Days(days) => (
                i64::MIN,
                now_ms.saturating_sub(i64::from(days).saturating_mul(MS_PER_DAY)),
            ),
            RetentionLimit::Count(count) => {
                // AUTOINCREMENT never reuses a seq, so the newest seq minus
                // the count approximates the count without scanning.
                let max_seq: Option<i64> = sqlx::query_scalar("SELECT MAX(seq) FROM event")
                    .fetch_one(&mut *tx)
                    .await?;
                (
                    max_seq.unwrap_or(0).saturating_sub(i64::from(count)),
                    i64::MIN,
                )
            }
        };
        let scan = i64::try_from(batch.saturating_add(kept.len()))
            .map_err(|_| AlarmDbError::InvalidRow)?;
        let rows = sqlx::query("SELECT seq, at_ms FROM event ORDER BY seq LIMIT ?")
            .bind(scan)
            .fetch_all(&mut *tx)
            .await?;
        let mut deleted = 0usize;
        let mut last = None;
        for row in rows {
            if deleted == batch {
                break;
            }
            let seq: i64 = row.try_get("seq")?;
            if kept.contains(&seq) {
                continue;
            }
            let at_ms: i64 = row.try_get("at_ms")?;
            if seq > seq_cutoff && at_ms >= at_cutoff {
                break;
            }
            deleted += 1;
            last = Some(seq);
        }
        if let Some(last) = last {
            // Every event up to `last` is expired or kept (the scan above).
            let result = sqlx::query(concat!(
                "DELETE FROM event WHERE seq <= ? AND seq NOT IN (",
                kept_seqs!(),
                ")"
            ))
            .bind(last)
            .execute(&mut *tx)
            .await?;
            if result.rows_affected() != deleted as u64 {
                return Err(AlarmDbError::InvalidRow);
            }
        }
        tx.commit().await?;
        Ok(PruneOutcome {
            deleted: deleted as u64,
            reached_batch: batch > 0 && deleted == batch,
        })
    }

    /// The event count and the time of the oldest event that is not kept.
    pub async fn retention_status(&self) -> Result<RetentionStatus, AlarmDbError> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM event")
            .fetch_one(&self.pool)
            .await?;
        let oldest_at_ms: Option<i64> = sqlx::query_scalar(concat!(
            "SELECT at_ms FROM event WHERE seq NOT IN (",
            kept_seqs!(),
            ") ORDER BY seq LIMIT 1"
        ))
        .fetch_optional(&self.pool)
        .await?;
        Ok(RetentionStatus {
            event_count: u64::try_from(count).map_err(|_| AlarmDbError::InvalidRow)?,
            oldest_at_ms,
        })
    }
}

#[cfg(test)]
mod tests;
