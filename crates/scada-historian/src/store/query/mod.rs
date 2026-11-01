//! Bounded raw and min/max snapshot queries without inferred recording coverage.
mod control;
mod minmax;
pub use control::{CancellationToken, QueryControl, QueryLimits};

use std::fmt;
use std::sync::{atomic::Ordering, Arc};
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};

use super::{
    regular_file, IdentityDescriptor, SqliteStore, StoreError, StoreResult, WriterOwnership,
};
use control::Budget;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueryError {
    InvalidRequest(crate::ContractError),
    InvalidLimits,
    UnsupportedMode,
    Cancelled,
    Deadline,
    WorkLimit,
    ByteLimit,
    TooManyPoints,
    MetadataLimit,
    MetadataAmbiguous,
    CorruptData,
    Database,
    ReaderUnusable,
}
impl fmt::Display for QueryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Historian query: {}",
            match self {
                Self::InvalidRequest(_) => "invalid request",
                Self::InvalidLimits => "invalid limits",
                Self::UnsupportedMode => "unsupported mode",
                Self::Cancelled => "cancelled",
                Self::Deadline => "deadline exceeded",
                Self::WorkLimit => "work limit exceeded",
                Self::ByteLimit => "result byte limit exceeded",
                Self::TooManyPoints => "raw point limit exceeded",
                Self::MetadataLimit => "metadata limit exceeded",
                Self::MetadataAmbiguous => "empty bin metadata cannot be determined",
                Self::CorruptData => "inconsistent stored data",
                Self::Database => "database failure",
                Self::ReaderUnusable => "reader must be reopened",
            }
        )
    }
}
impl std::error::Error for QueryError {}
impl From<rusqlite::Error> for QueryError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Database
    }
}
impl From<serde_json::Error> for QueryError {
    fn from(_: serde_json::Error) -> Self {
        Self::CorruptData
    }
}

struct ReaderLease(Arc<WriterOwnership>);
impl Drop for ReaderLease {
    fn drop(&mut self) {
        self.0.readers.fetch_sub(1, Ordering::AcqRel);
    }
}

/// One owned read-only connection. Idle readers also occupy one of two slots.
/// Drop every reader before transferring the store's writer ownership.
pub struct HistoryReader {
    // Close connection before releasing its ownership lease, including on panic.
    connection: Option<Connection>,
    _lease: ReaderLease,
}

impl SqliteStore {
    pub fn reader(&self) -> StoreResult<HistoryReader> {
        self.check_writable()?;
        self.ownership
            .readers
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 2).then_some(n + 1)
            })
            .map_err(|_| StoreError::Busy)?;
        let lease = ReaderLease(Arc::clone(&self.ownership));
        regular_file(&self.database_path)?;
        let connection = Connection::open_with_flags(
            &self.database_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::ZERO)?;
        connection.execute_batch(
            "PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON;",
        )?;
        Ok(HistoryReader {
            connection: Some(connection),
            _lease: lease,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Boundary {
    Snapshot,
    Series,
    BeforeReturn,
}

// Manual transaction guard so cancellation is removed BEFORE rollback, on every
// success/error/unwind path. Transaction::Drop alone could interrupt cleanup.
struct Snapshot<'a> {
    connection: &'a mut Connection,
    healthy: &'a mut bool,
}
impl Drop for Snapshot<'_> {
    fn drop(&mut self) {
        if self
            .connection
            .progress_handler(0, None::<fn() -> bool>)
            .is_err()
        {
            *self.healthy = false;
        }
        if !self.connection.is_autocommit() && self.connection.execute_batch("ROLLBACK").is_err() {
            *self.healthy = false;
        }
        if !self.connection.is_autocommit() {
            *self.healthy = false;
        }
    }
}

impl HistoryReader {
    /// Returns one complete H1 raw result or a typed operation error. No truncation.
    pub fn query_raw(
        &mut self,
        query: &Value,
        control: &QueryControl,
    ) -> Result<Value, QueryError> {
        self.query_with_hook(query, control, &mut |_| Ok(()))
    }

    /// Returns common-grid min/max bins, without fetching raw rows into Rust.
    pub fn query_minmax(
        &mut self,
        query: &Value,
        control: &QueryControl,
    ) -> Result<Value, QueryError> {
        self.query_with_mode(query, control, "minmax", &mut |_| Ok(()))
    }

    fn query_with_hook(
        &mut self,
        query: &Value,
        control: &QueryControl,
        hook: &mut impl FnMut(Boundary) -> Result<(), QueryError>,
    ) -> Result<Value, QueryError> {
        self.query_with_mode(query, control, "raw", hook)
    }

    fn query_with_mode(
        &mut self,
        query: &Value,
        control: &QueryControl,
        mode: &str,
        hook: &mut impl FnMut(Boundary) -> Result<(), QueryError>,
    ) -> Result<Value, QueryError> {
        control.validate()?;
        let mut budget = Budget::new(control);
        budget.work.check()?;
        control::serialized_size(query, 8192)?;
        crate::validate_history_contract(query).map_err(QueryError::InvalidRequest)?;
        if query["kind"] != "query" {
            return Err(QueryError::InvalidRequest(crate::ContractError::Schema));
        }
        if query["mode"] != mode {
            return Err(QueryError::UnsupportedMode);
        }
        budget.work.check()?;
        let connection = self.connection.as_mut().ok_or(QueryError::ReaderUnusable)?;
        let mut healthy = true;
        let result = {
            let snapshot = Snapshot {
                connection,
                healthy: &mut healthy,
            };
            (|| {
                let progress = Arc::clone(&budget.work);
                snapshot
                    .connection
                    .progress_handler(1000, Some(move || progress.progress()))?;
                budget.work.statement()?;
                snapshot.connection.execute_batch("BEGIN DEFERRED")?;
                budget.work.statement()?;
                let version: i64 = snapshot.connection.query_row(
                    "SELECT last_commit FROM store_meta WHERE singleton = 1",
                    [],
                    |r| r.get(0),
                )?;
                budget.row()?;
                if version < 0 {
                    return Err(QueryError::CorruptData);
                }
                // The first read pins all following metadata, samples and progress.
                hook(Boundary::Snapshot)?;
                let mut series = Vec::new();
                for id in crate::rows(&query["seriesIds"]) {
                    budget.work.check()?;
                    series.push(series_result(
                        snapshot.connection,
                        crate::text(id),
                        query,
                        &mut budget,
                    )?);
                    hook(Boundary::Series)?;
                }
                let result = json!({
                    "version": 1, "kind": "result", "query": query, "status": "ready",
                    "snapshotId": uuid::Uuid::new_v4().to_string(), "series": series
                });
                budget.result(&result)?;
                crate::validate_history_contract(&result).map_err(|_| QueryError::CorruptData)?;
                hook(Boundary::BeforeReturn)?;
                budget.work.check()?;
                Ok(result)
            })()
            // snapshot drops here, after all SQL statements/rows in the closure.
        };
        if !healthy {
            self.connection.take();
            return Err(QueryError::ReaderUnusable);
        }
        budget.work.check()?;
        result
    }
}

fn series_result(
    connection: &Connection,
    id: &str,
    query: &Value,
    budget: &mut Budget,
) -> Result<Value, QueryError> {
    budget.work.statement()?;
    let identity: Option<(String, String)> = connection
        .query_row(
            "SELECT hub_id, incarnation_id FROM series WHERE series_id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if identity.is_some() {
        budget.row()?;
    }
    let Some((hub, incarnation)) = identity else {
        return Ok(
            json!({"seriesId": id, "status": "unknownSeries", "segments": [], "raw": [], "bins": [], "coverage": [], "watermark": null}),
        );
    };
    budget.work.statement()?;
    let mut statement = connection.prepare("SELECT segment_id, descriptor_json FROM segments WHERE series_id = ?1 ORDER BY segment_id LIMIT 33")?;
    let mut rows = statement.query([id])?;
    let mut segments = Vec::new();
    while let Some(row) = rows.next()? {
        budget.row()?;
        if segments.len() == 32 {
            return Err(QueryError::MetadataLimit);
        }
        let segment: String = row.get(0)?;
        let text: String = row.get(1)?;
        if text.len() > 8192 {
            return Err(QueryError::CorruptData);
        }
        let descriptor: IdentityDescriptor = serde_json::from_str(&text)?;
        if descriptor.series_id != id
            || descriptor.segment_id != segment
            || descriptor.hub_instance_id != hub
            || descriptor.incarnation_id != incarnation
        {
            return Err(QueryError::CorruptData);
        }
        let descriptor = serde_json::to_value(descriptor)?;
        budget.value(&descriptor)?;
        segments.push(descriptor);
    }
    if segments.is_empty() {
        return Err(QueryError::CorruptData);
    }
    let (raw, bins) = if query["mode"] == "raw" {
        (raw_values(connection, id, query, budget)?, Vec::new())
    } else {
        (
            Vec::new(),
            minmax::bins(connection, id, query, &segments, budget)?,
        )
    };
    budget.work.statement()?;
    let latest: Option<(String, i64)> = connection.query_row(
        "SELECT s.session_id, s.last_sequence FROM sessions AS s JOIN session_members AS m ON m.session_id = s.session_id
         WHERE m.series_id = ?1 ORDER BY s.begin_commit DESC LIMIT 1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let watermark = if let Some((session, sequence)) = latest {
        budget.row()?;
        if sequence < 0 {
            return Err(QueryError::CorruptData);
        }
        if sequence == 0 {
            Value::Null
        } else {
            json!({"sessionId": session, "committedThrough": sequence})
        }
    } else {
        return Err(QueryError::CorruptData);
    };
    Ok(json!({
        "seriesId": id, "status": "ready", "segments": segments, "raw": raw, "bins": bins,
        "coverage": [{"fromMs": query["fromMs"], "toMs": query["toMs"], "reason": "unknownCoverage"}],
        "watermark": watermark
    }))
}

fn raw_values(
    connection: &Connection,
    id: &str,
    query: &Value,
    budget: &mut Budget,
) -> Result<Vec<Value>, QueryError> {
    let limit = crate::integer(&query["maxPointsPerSeries"]);
    budget.work.statement()?;
    let mut statement = connection.prepare(
        "SELECT segment_id, session_id, sequence, clock_epoch, sample_time_ms, source_time_ms, ingested_at_ms, quality, source, number_value, bool_value, reason
         FROM observations WHERE series_id = ?1 AND sample_time_ms >= ?2 AND sample_time_ms < ?3
         ORDER BY sample_time_ms, session_id, sequence LIMIT ?4")?;
    let mut rows = statement.query(params![
        id,
        crate::integer(&query["fromMs"]),
        crate::integer(&query["toMs"]),
        limit + 1
    ])?;
    let mut raw = Vec::new();
    while let Some(row) = rows.next()? {
        budget.row()?;
        if raw.len() as i64 == limit {
            return Err(QueryError::TooManyPoints);
        }
        let number: Option<f64> = row.get(9)?;
        let boolean: Option<i64> = row.get(10)?;
        let value = match (number, boolean) {
            (Some(n), None) if n.is_finite() => json!(n),
            (None, Some(b)) if b == 0 || b == 1 => json!(b == 1),
            (None, None) => Value::Null,
            _ => return Err(QueryError::CorruptData),
        };
        let sample = json!({
            "seriesId": id, "segmentId": row.get::<_, String>(0)?,
            "recordId": {"sessionId": row.get::<_, String>(1)?, "sequence": row.get::<_, i64>(2)?},
            "clockEpoch": row.get::<_, String>(3)?, "sampleTimeMs": row.get::<_, i64>(4)?,
            "sourceTimeMs": row.get::<_, Option<i64>>(5)?, "ingestedAtMs": row.get::<_, i64>(6)?,
            "quality": row.get::<_, Option<String>>(7)?, "source": row.get::<_, Option<String>>(8)?,
            "value": value, "reason": row.get::<_, Option<String>>(11)?
        });
        budget.value(&sample)?;
        raw.push(sample);
    }
    Ok(raw)
}

#[cfg(test)]
mod tests;
