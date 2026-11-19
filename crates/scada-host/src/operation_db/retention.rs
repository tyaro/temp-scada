//! Deleting the old end of `operation` by the terminal's retention
//! (operation stage-3 design §9, §11-7; O4a) and the retention status of the
//! terminal settings.
//!
//! - Both limits apply: a row is expired when it is older than the days or
//!   beyond the count, whichever deletes first.
//! - The count is of every row of the table, `pending` included; a
//!   `pending` row is never deleted (its outcome is still to be written).
//! - Rows go from the old end in `(requested_at_ms, seq)` order, stopping at
//!   the first row within both limits, so only the old end moves. At most
//!   [`PRUNE_BATCH`] rows per round, as the alarm history's retention.
use std::sync::Weak;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::{OperationDb, OperationDbError, OperationLog, OperationRetention};

/// The rows one round deletes at most.
pub const PRUNE_BATCH: usize = 10_000;
/// The next round after one that reached the batch limit.
pub const PRUNE_CONTINUE: Duration = Duration::from_secs(5);
/// The next round otherwise (or after a failure, which is logged).
pub const PRUNE_INTERVAL: Duration = Duration::from_secs(3_600);

const MS_PER_DAY: i64 = 86_400_000;

/// The order the retention deletes in (format 6).
pub(super) const CREATE_INDEX: &str =
    "CREATE INDEX IF NOT EXISTS operation_requested ON operation(requested_at_ms, seq);";

/// The candidates of a round: the oldest rows that are not `pending`.
macro_rules! oldest_finished {
    ($column:literal) => {
        concat!(
            "SELECT ",
            $column,
            " FROM operation WHERE outcome <> 'pending' ORDER BY requested_at_ms, seq LIMIT ?"
        )
    };
}

/// One deletion round.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PruneOutcome {
    pub deleted: u64,
    /// The round stopped at the batch limit; more may have expired.
    pub reached_batch: bool,
}

/// The record's size for the terminal settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionStatus {
    /// Every row, `pending` included (the count the limit is of).
    pub row_count: u64,
    /// `requested_at_ms` of the oldest row.
    pub oldest_requested_at_ms: Option<i64>,
}

impl OperationDb {
    /// Delete up to `batch` expired rows from the old end (module docs).
    pub async fn prune(
        &self,
        retention: OperationRetention,
        now_ms: i64,
        batch: usize,
    ) -> Result<PruneOutcome, OperationDbError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM operation")
            .fetch_one(&mut *tx)
            .await?;
        let excess = total.saturating_sub(i64::from(retention.count)).max(0);
        let cutoff = now_ms.saturating_sub(i64::from(retention.days).saturating_mul(MS_PER_DAY));
        let scan = i64::try_from(batch).map_err(|_| OperationDbError::InvalidRow)?;
        let times: Vec<i64> = sqlx::query_scalar(oldest_finished!("requested_at_ms"))
            .bind(scan)
            .fetch_all(&mut *tx)
            .await?;
        let mut deleted: i64 = 0;
        for at_ms in times {
            if deleted >= excess && at_ms >= cutoff {
                break;
            }
            deleted += 1;
        }
        if deleted > 0 {
            let result = sqlx::query(concat!(
                "DELETE FROM operation WHERE seq IN (",
                oldest_finished!("seq"),
                ")"
            ))
            .bind(deleted)
            .execute(&mut *tx)
            .await?;
            if result.rows_affected() != deleted as u64 {
                return Err(OperationDbError::InvalidRow);
            }
        }
        tx.commit().await?;
        Ok(PruneOutcome {
            deleted: deleted as u64,
            reached_batch: batch > 0 && deleted as usize == batch,
        })
    }

    /// The row count and the oldest row's request time.
    pub async fn retention_status(&self) -> Result<RetentionStatus, OperationDbError> {
        let row_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM operation")
            .fetch_one(&self.pool)
            .await?;
        let oldest_requested_at_ms: Option<i64> = sqlx::query_scalar(
            "SELECT requested_at_ms FROM operation ORDER BY requested_at_ms, seq LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(RetentionStatus {
            row_count: u64::try_from(row_count).map_err(|_| OperationDbError::InvalidRow)?,
            oldest_requested_at_ms,
        })
    }
}

impl OperationLog {
    /// The retention of the record (§9, §11-7).
    pub fn retention(&self) -> OperationRetention {
        *self.retention.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Save the retention (O4a). Out of a range is `InvalidSetting` and
    /// changes nothing; the in-memory retention changes only once the file
    /// has it, and a round runs at once (`run_retention`).
    pub async fn set_retention(
        &self,
        retention: OperationRetention,
    ) -> Result<(), OperationDbError> {
        if !retention.is_valid() {
            return Err(OperationDbError::InvalidSetting);
        }
        let _settings = self.settings_lock.lock().await;
        super::terminal_settings::save_retention(&self.db.pool, retention).await?;
        *self.retention.lock().unwrap_or_else(|e| e.into_inner()) = retention;
        self.retention_wake.notify_one();
        Ok(())
    }

    pub async fn retention_status(&self) -> Result<RetentionStatus, OperationDbError> {
        self.db.retention_status().await
    }

    /// One round at `now_ms`; returns the delay to the next one. A failure
    /// is logged and retried at the next round.
    pub async fn prune_at(&self, now_ms: i64, batch: usize) -> Duration {
        match self.db.prune(self.retention(), now_ms, batch).await {
            Ok(outcome) if outcome.reached_batch => PRUNE_CONTINUE,
            Ok(_) => PRUNE_INTERVAL,
            Err(error) => {
                eprintln!("operation record retention failed, retrying later: {error:?}");
                PRUNE_INTERVAL
            }
        }
    }
}

fn wall_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            elapsed.as_millis().min(i64::MAX as u128) as i64
        })
}

/// Run the retention of `log` until it is gone: a round at once, then
/// after the delay the round answers or when the retention changes. The
/// log is held only during a round, so its owner can close it between.
pub async fn run_retention(log: Weak<OperationLog>) {
    let Some(wake) = log.upgrade().map(|log| log.retention_wake.clone()) else {
        return;
    };
    loop {
        let delay = match log.upgrade() {
            Some(log) => log.prune_at(wall_ms(), PRUNE_BATCH).await,
            None => return,
        };
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            () = wake.notified() => {}
        }
    }
}

#[cfg(test)]
mod tests;
