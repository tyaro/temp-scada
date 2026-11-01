//! Local diagnostics and one explicit, best-effort PASSIVE checkpoint.
//! These measurements are not a History result, a disk-free-space estimate, or
//! a physical-erasure guarantee. Checkpoint I/O has no hard deadline guarantee.
use rusqlite::Connection;
use serde::Serialize;
use std::{
    fs,
    path::Path,
    sync::{atomic::Ordering, Arc},
};

use super::{
    query::{control::Budget, QueryControl},
    SqliteStore, StoreError, StoreResult,
};

pub const MAX_PASSIVE_WAL_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageDiagnostics {
    pub page_size: u64,
    pub page_count: u64,
    pub freelist_count: u64,
    pub logical_bytes: u64,
    pub free_page_bytes: u64,
    pub database_file_bytes: u64,
    /// None means the WAL file was absent when sampled, not a measured zero.
    pub wal_file_bytes: Option<u64>,
    /// Includes idle leases; it does not count pinned snapshots.
    pub live_reader_leases: usize,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CheckpointStatus {
    Complete,
    Incomplete,
    Busy,
    NoWal,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointReport {
    pub status: CheckpointStatus,
    /// SQLite's cumulative WAL counts, not frames copied by this call.
    pub log_frames: Option<u64>,
    pub checkpointed_frames: Option<u64>,
}

impl SqliteStore {
    pub fn storage_diagnostics(
        &mut self,
        control: &QueryControl,
    ) -> StoreResult<StorageDiagnostics> {
        self.diagnostics_with_hook(control, &mut || Ok(()))
    }

    fn diagnostics_with_hook(
        &mut self,
        control: &QueryControl,
        hook: &mut impl FnMut() -> StoreResult<()>,
    ) -> StoreResult<StorageDiagnostics> {
        let path = self.database_path.clone();
        let ownership = Arc::clone(&self.ownership);
        self.run_maintenance(control, true, |connection, budget| {
            budget.work.statement()?;
            connection.execute_batch("BEGIN DEFERRED")?;
            // Pin the page measurements with an actual read, not just BEGIN.
            scalar(
                connection,
                "SELECT last_commit FROM store_meta WHERE singleton = 1",
                budget,
            )?;
            let page_count = scalar(connection, "PRAGMA main.page_count", budget)?;
            hook()?;
            let freelist_count = scalar(connection, "PRAGMA main.freelist_count", budget)?;
            let page_size = scalar(connection, "PRAGMA main.page_size", budget)?;
            if !(512..=65536).contains(&page_size)
                || !page_size.is_power_of_two()
                || page_count == 0
                || freelist_count > page_count
            {
                return Err(StoreError::CorruptData);
            }
            let logical_bytes = page_size
                .checked_mul(page_count)
                .ok_or(StoreError::CorruptData)?;
            let free_page_bytes = page_size
                .checked_mul(freelist_count)
                .ok_or(StoreError::CorruptData)?;
            budget.work.statement()?;
            connection.execute_batch("ROLLBACK")?;
            budget.work.check()?;
            let database_file_bytes = regular_length(&path)?
                .ok_or_else(|| StoreError::Invalid("store database is missing"))?;
            let wal_file_bytes = regular_length(&path.with_extension("sqlite3-wal"))?;
            let result = StorageDiagnostics {
                page_size,
                page_count,
                freelist_count,
                logical_bytes,
                free_page_bytes,
                database_file_bytes,
                wal_file_bytes,
                live_reader_leases: ownership.readers.load(Ordering::Acquire),
            };
            budget.result(&serde_json::to_value(&result)?)?;
            Ok(result)
        })
    }

    /// One PASSIVE call, with no retry or reader wait. Success is reported even
    /// if cancellation arrives during checkpoint I/O: that work is not undone.
    pub fn checkpoint_passive(&mut self, control: &QueryControl) -> StoreResult<CheckpointReport> {
        self.checkpoint_with_hook(control, &mut || Ok(()))
    }

    fn checkpoint_with_hook(
        &mut self,
        control: &QueryControl,
        hook: &mut impl FnMut() -> StoreResult<()>,
    ) -> StoreResult<CheckpointReport> {
        let path = self.database_path.with_extension("sqlite3-wal");
        self.run_maintenance(control, false, |connection, budget| {
            // Reserve the largest report before physical work. No post-checkpoint
            // byte/deadline check can turn successful work into a false non-result.
            budget.result(&serde_json::to_value(CheckpointReport {
                status: CheckpointStatus::Incomplete,
                log_frames: Some(u64::MAX),
                checkpointed_frames: Some(u64::MAX),
            })?)?;
            if regular_length(&path)?.is_some_and(|bytes| bytes > MAX_PASSIVE_WAL_BYTES) {
                return Err(StoreError::MaintenanceLimit);
            }
            budget.work.statement()?;
            budget.row()?;
            let (busy, log, done): (i64, i64, i64) =
                connection.query_row("PRAGMA main.wal_checkpoint(PASSIVE)", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?;
            hook()?;
            checkpoint_report(busy, log, done)
        })
    }

    fn run_maintenance<T>(
        &mut self,
        control: &QueryControl,
        finish_check: bool,
        action: impl FnOnce(&Connection, &mut Budget) -> StoreResult<T>,
    ) -> StoreResult<T> {
        self.check_writable()?;
        control.validate()?;
        let mut budget = Budget::new(control);
        budget.work.check()?;
        if !self.connection.is_autocommit() {
            self.needs_reopen = true;
            return Err(StoreError::NeedsReopen);
        }
        let main_file = regular_length(&self.database_path);
        self.after_write(main_file)?
            .ok_or(StoreError::Invalid("store database is missing"))?;
        let result = {
            let guard = Operation {
                connection: &mut self.connection,
                needs_reopen: &mut self.needs_reopen,
            };
            let progress = Arc::clone(&budget.work);
            guard
                .connection
                .progress_handler(1000, Some(move || progress.progress()))?;
            let result = action(guard.connection, &mut budget);
            match result {
                Err(StoreError::Sqlite(error)) => Err(sqlite_failure(error, &budget)),
                Ok(value) if finish_check => budget
                    .work
                    .check()
                    .map(|()| value)
                    .map_err(StoreError::from),
                other => other,
            }
        };
        if self.needs_reopen {
            return Err(StoreError::NeedsReopen);
        }
        self.after_write(result)
    }
}

fn scalar(connection: &Connection, sql: &str, budget: &mut Budget) -> StoreResult<u64> {
    budget.work.statement()?;
    let n: i64 = connection.query_row(sql, [], |r| r.get(0))?;
    budget.row()?;
    u64::try_from(n).map_err(|_| StoreError::CorruptData)
}

fn regular_length(path: &Path) -> StoreResult<Option<u64>> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() => Ok(Some(meta.len())),
        Ok(_) => Err(StoreError::Invalid(
            "maintenance requires regular store files",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(StoreError::Io(error)),
    }
}

fn checkpoint_report(busy: i64, log: i64, done: i64) -> StoreResult<CheckpointReport> {
    if !matches!(busy, 0 | 1)
        || (log == -1) != (done == -1)
        || log < -1
        || done < -1
        || (log >= 0 && done > log)
    {
        return Err(StoreError::CorruptData);
    }
    let status = if busy == 1 {
        CheckpointStatus::Busy
    } else if log == -1 {
        CheckpointStatus::NoWal
    } else if done == log {
        CheckpointStatus::Complete
    } else {
        CheckpointStatus::Incomplete
    };
    Ok(CheckpointReport {
        status,
        log_frames: (log >= 0).then_some(log as u64),
        checkpointed_frames: (done >= 0).then_some(done as u64),
    })
}
// Only SQLite's interrupt code can stand for cooperative cancellation. A real
// storage failure must retain its cause and poison the writer even if a control
// flag changes before we inspect it.
pub(super) fn sqlite_failure(error: rusqlite::Error, budget: &Budget) -> StoreError {
    if error.sqlite_error_code() == Some(rusqlite::ErrorCode::OperationInterrupted) {
        if let Err(reason) = budget.work.check() {
            return StoreError::Control(reason);
        }
    }
    StoreError::Sqlite(error)
}

// Remove cancellation before rollback, including during unwinding. The writer
// remains poisoned if cleanup fails; it never releases ownership mid-operation.
pub(super) struct Operation<'a> {
    pub(super) connection: &'a mut Connection,
    pub(super) needs_reopen: &'a mut bool,
}
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        if self
            .connection
            .progress_handler(0, None::<fn() -> bool>)
            .is_err()
        {
            *self.needs_reopen = true;
        }
        if !self.connection.is_autocommit() && self.connection.execute_batch("ROLLBACK").is_err() {
            *self.needs_reopen = true;
        }
        if !self.connection.is_autocommit() {
            *self.needs_reopen = true;
        }
    }
}

#[cfg(test)]
mod tests;
