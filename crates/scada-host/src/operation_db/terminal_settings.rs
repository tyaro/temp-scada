//! The terminal's write settings (operation stage-3 design §7, §9, §11-7,
//! §11-10): the minimum interval between writes (O2c-4b) and the retention
//! of the record (O4a). One row in `operations.db` (table
//! `terminal_settings`, format 4; retention columns format 6), apart from
//! the write state's row so saving a setting never touches the state or its
//! time. No row (or a NULL retention column) is the default.
use sqlx::SqlitePool;

use super::OperationDbError;

/// The default minimum interval (§11-10): one second.
pub const DEFAULT_MIN_INTERVAL_MS: i64 = 1_000;
/// The range of the minimum interval, in steps of [`MIN_INTERVAL_STEP_MS`].
pub const MIN_INTERVAL_RANGE_MS: std::ops::RangeInclusive<i64> = 100..=60_000;
pub const MIN_INTERVAL_STEP_MS: i64 = 100;

/// The default retention (§11-7): a year or 100,000 rows, whichever
/// deletes first.
pub const DEFAULT_RETENTION_DAYS: u32 = 365;
pub const DEFAULT_RETENTION_COUNT: u32 = 100_000;
/// The ranges of the retention, as the alarm history's terminal settings.
pub const RETENTION_DAYS_RANGE: std::ops::RangeInclusive<u32> = 1..=3_650;
pub const RETENTION_COUNT_RANGE: std::ops::RangeInclusive<u32> = 10_000..=10_000_000;

/// The retention of the record (§9, §11-7; O4a): both limits apply, and a
/// row past either one is deleted (the earlier one wins).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRetention {
    pub days: u32,
    pub count: u32,
}

impl Default for OperationRetention {
    fn default() -> Self {
        Self {
            days: DEFAULT_RETENTION_DAYS,
            count: DEFAULT_RETENTION_COUNT,
        }
    }
}

impl OperationRetention {
    /// Whether both limits are in their ranges.
    pub fn is_valid(self) -> bool {
        RETENTION_DAYS_RANGE.contains(&self.days) && RETENTION_COUNT_RANGE.contains(&self.count)
    }
}

/// The table, created with the record (format 6) or added to an older
/// file. The CHECK of the interval is `valid_min_interval`: an integer
/// (SQLite keeps a REAL in an INTEGER column, and `%` would truncate it) in
/// the range, on the step; the retention's is its ranges, NULL the default.
pub(super) const CREATE_TABLE: &str = "CREATE TABLE terminal_settings (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       min_interval_ms INTEGER NOT NULL
         CHECK (typeof(min_interval_ms) = 'integer'
                AND min_interval_ms BETWEEN 100 AND 60000
                AND min_interval_ms % 100 = 0),
       retention_days INTEGER
         CHECK (retention_days IS NULL
                OR (typeof(retention_days) = 'integer'
                    AND retention_days BETWEEN 1 AND 3650)),
       retention_count INTEGER
         CHECK (retention_count IS NULL
                OR (typeof(retention_count) = 'integer'
                    AND retention_count BETWEEN 10000 AND 10000000))
     );";

/// Format 5 to 6: the retention columns (O4a), NULL (the default) in a
/// saved row.
pub(super) const ADD_RETENTION: &str =
    "ALTER TABLE terminal_settings ADD COLUMN retention_days INTEGER
       CHECK (retention_days IS NULL
              OR (typeof(retention_days) = 'integer'
                  AND retention_days BETWEEN 1 AND 3650));
     ALTER TABLE terminal_settings ADD COLUMN retention_count INTEGER
       CHECK (retention_count IS NULL
              OR (typeof(retention_count) = 'integer'
                  AND retention_count BETWEEN 10000 AND 10000000));";

/// Format 4 to 5: the table again with the integer CHECK (#324 owner's
/// review). A saved value the new CHECK allows is kept; any other is
/// dropped, which reads as the default (as `load_min_interval` already
/// read it).
pub(super) const REBUILD_TABLE: &str =
    "ALTER TABLE terminal_settings RENAME TO terminal_settings_4;";
pub(super) const COPY_FROM_4: &str = "INSERT INTO terminal_settings (id, min_interval_ms)
       SELECT id, min_interval_ms FROM terminal_settings_4
        WHERE typeof(min_interval_ms) = 'integer'
          AND min_interval_ms BETWEEN 100 AND 60000
          AND min_interval_ms % 100 = 0;
     DROP TABLE terminal_settings_4;";

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

/// The saved retention; the default for a limit not saved (or out of its
/// range).
pub(super) async fn load_retention(
    pool: &SqlitePool,
) -> Result<OperationRetention, OperationDbError> {
    let saved: Option<(Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT retention_days, retention_count FROM terminal_settings WHERE id = 1",
    )
    .fetch_optional(pool)
    .await?;
    let (days, count) = saved.unwrap_or_default();
    let pick = |value: Option<i64>, range: &std::ops::RangeInclusive<u32>, default: u32| {
        value
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| range.contains(value))
            .unwrap_or(default)
    };
    Ok(OperationRetention {
        days: pick(days, &RETENTION_DAYS_RANGE, DEFAULT_RETENTION_DAYS),
        count: pick(count, &RETENTION_COUNT_RANGE, DEFAULT_RETENTION_COUNT),
    })
}

/// Save both limits. A new row takes the default interval, which is what
/// no row read as.
pub(super) async fn save_retention(
    pool: &SqlitePool,
    retention: OperationRetention,
) -> Result<(), OperationDbError> {
    sqlx::query(
        "INSERT INTO terminal_settings (id, min_interval_ms, retention_days, retention_count)
         VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET retention_days = excluded.retention_days,
                                        retention_count = excluded.retention_count",
    )
    .bind(DEFAULT_MIN_INTERVAL_MS)
    .bind(i64::from(retention.days))
    .bind(i64::from(retention.count))
    .execute(pool)
    .await?;
    Ok(())
}
