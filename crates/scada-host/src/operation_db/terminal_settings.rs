//! The terminal's write settings (operation stage-3 design §7, §11-10;
//! O2c-4b): the minimum interval between writes. One row in
//! `operations.db` (table `terminal_settings`, format 4), apart from the
//! write state's row so saving the interval never touches the state or its
//! time. No row is the default.
use sqlx::SqlitePool;

use super::OperationDbError;

/// The default minimum interval (§11-10): one second.
pub const DEFAULT_MIN_INTERVAL_MS: i64 = 1_000;
/// The range of the minimum interval, in steps of [`MIN_INTERVAL_STEP_MS`].
pub const MIN_INTERVAL_RANGE_MS: std::ops::RangeInclusive<i64> = 100..=60_000;
pub const MIN_INTERVAL_STEP_MS: i64 = 100;

/// The table, created with the record (format 4) or added to an older file.
pub(super) const CREATE_TABLE: &str = "CREATE TABLE terminal_settings (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       min_interval_ms INTEGER NOT NULL
         CHECK (min_interval_ms BETWEEN 100 AND 60000 AND min_interval_ms % 100 = 0)
     );";

/// Whether `ms` may be saved as the minimum interval.
pub fn valid_min_interval(ms: i64) -> bool {
    MIN_INTERVAL_RANGE_MS.contains(&ms) && ms % MIN_INTERVAL_STEP_MS == 0
}

/// The saved minimum interval; the default when none is saved (or a value
/// the range no longer allows).
pub(super) async fn load_min_interval(pool: &SqlitePool) -> Result<i64, OperationDbError> {
    let saved: Option<i64> =
        sqlx::query_scalar("SELECT min_interval_ms FROM terminal_settings WHERE id = 1")
            .fetch_optional(pool)
            .await?;
    Ok(saved
        .filter(|ms| valid_min_interval(*ms))
        .unwrap_or(DEFAULT_MIN_INTERVAL_MS))
}

pub(super) async fn save_min_interval(pool: &SqlitePool, ms: i64) -> Result<(), OperationDbError> {
    sqlx::query(
        "INSERT INTO terminal_settings (id, min_interval_ms) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET min_interval_ms = excluded.min_interval_ms",
    )
    .bind(ms)
    .execute(pool)
    .await?;
    Ok(())
}
