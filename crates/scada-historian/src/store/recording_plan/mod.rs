//! H5b1/2: durable configuration and atomic session binding. No SDK/worker startup.
mod activation;
mod canonical;
mod preflight;
mod prepare;
mod read;
mod reservations;
mod types;
mod write;
use super::{
    evidence, id, invalid, next_commit, query, recovery, retention, Boundary, IdentityDescriptor,
    SessionSpec, SqliteStore, StoreError, StoreResult, MAX_SAFE,
};
pub use activation::*;
use query::{control::Budget, QueryControl};
use rusqlite::{params, Connection, OptionalExtension};
pub use types::*;
pub const MAX_DOCUMENT_BYTES: usize = 128 * 1024;
pub const MAX_LEDGER_ENTRIES: u64 = 4096;
fn bounded(control: &QueryControl) -> QueryControl {
    let mut c = control.clone();
    c.limits.max_decoded_rows = c.limits.max_decoded_rows.min(256);
    c
}
fn sql(c: &Connection, b: &Budget, text: &str) -> StoreResult<()> {
    b.work.statement()?;
    c.execute_batch(text)?;
    Ok(())
}
fn commit_number(c: &Connection, b: &mut Budget) -> StoreResult<u64> {
    b.work.statement()?;
    b.work.statement()?;
    b.row()?;
    Ok(next_commit(c)? as u64)
}
fn idle(c: &Connection, b: &mut Budget) -> StoreResult<recovery::StoreRecoveryState> {
    let state = recovery::read_snapshot(c, b, &mut || Ok(()))?;
    if state.active_session_id.is_some() || state.active_job.is_some() {
        return Err(StoreError::Busy);
    }
    Ok(state)
}
fn find(
    c: &Connection,
    b: &mut Budget,
    table: &str,
    column: &str,
    key: &str,
) -> StoreResult<Option<u64>> {
    b.work.statement()?;
    let n: Option<i64> = c
        .query_row(
            &format!("SELECT {column} FROM {table} WHERE request_id=?1"),
            [key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(n) = n {
        b.row()?;
        if !(1..=MAX_LEDGER_ENTRIES as i64).contains(&n) {
            return Err(StoreError::CorruptData);
        }
        Ok(Some(n as u64))
    } else {
        Ok(None)
    }
}
/// Called inside the existing session-begin transaction, after old receipt replay.
pub(super) fn ensure_unmanaged_start(c: &Connection) -> StoreResult<()> {
    let control = QueryControl::with_timeout(std::time::Duration::from_secs(10))?;
    let mut b = Budget::new(&control);
    let state = read::heads(c, &mut b)?;
    if state.applied.is_some() {
        return Err(StoreError::ManagedRecordingRequired);
    }
    Ok(())
}
impl SqliteStore {
    pub fn register_recording_mapping(
        &mut self,
        request: &RegisterMappingRequest,
        control: &QueryControl,
    ) -> StoreResult<MappingReceipt> {
        self.register_mapping_with_hook(request, control, &mut |_| Ok(()))
    }
    fn register_mapping_with_hook(
        &mut self,
        request: &RegisterMappingRequest,
        control: &QueryControl,
        hook: &mut impl FnMut(Boundary) -> StoreResult<()>,
    ) -> StoreResult<MappingReceipt> {
        canonical::validate_mapping(request)?;
        let payload = canonical::encode(request)?;
        let normalized: RegisterMappingRequest = serde_json::from_str(&payload)?;
        self.run_maintenance(&bounded(control), false, |c, b| {
            write::register(c, b, &normalized, &payload, hook)
        })
    }
    pub fn apply_recording_plan(
        &mut self,
        request: &ApplyRecordingPlanRequest,
        control: &QueryControl,
    ) -> StoreResult<RecordingPlanReceipt> {
        self.apply_recording_plan_with_hook(request, control, &mut |_| Ok(()))
    }
    fn apply_recording_plan_with_hook(
        &mut self,
        request: &ApplyRecordingPlanRequest,
        control: &QueryControl,
        hook: &mut impl FnMut(Boundary) -> StoreResult<()>,
    ) -> StoreResult<RecordingPlanReceipt> {
        canonical::validate_apply(request)?;
        let payload = canonical::encode(request)?;
        let request: ApplyRecordingPlanRequest = serde_json::from_str(&payload)?;
        self.run_maintenance(&bounded(control), false, |c, b| {
            write::apply(c, b, &request, &payload, hook)
        })
    }
    pub fn recording_plan_state(
        &mut self,
        control: &QueryControl,
    ) -> StoreResult<RecordingPlanState> {
        self.run_maintenance(&bounded(control), true, |c, b| {
            sql(c, b, "BEGIN DEFERRED")?;
            let state = read::state(c, b)?;
            b.result(&serde_json::to_value(&state)?)?;
            sql(c, b, "ROLLBACK")?;
            Ok(state)
        })
    }
    pub fn recording_mapping_receipt(
        &mut self,
        key: &str,
        control: &QueryControl,
    ) -> StoreResult<Option<MappingReceipt>> {
        if !id(key) {
            return invalid("invalid recording mapping request ID");
        }
        self.run_maintenance(&bounded(control), true, |c, b| {
            sql(c, b, "BEGIN DEFERRED")?;
            let snapshot = read::heads(c, b)?.snapshot;
            let receipt = find(c, b, "recording_mapping_revisions", "mapping_revision", key)?
                .map(|r| read::mapping(c, b, r, snapshot).map(|m| m.receipt))
                .transpose()?;
            b.result(&serde_json::to_value(&receipt)?)?;
            sql(c, b, "ROLLBACK")?;
            Ok(receipt)
        })
    }
    pub fn recording_plan_receipt(
        &mut self,
        key: &str,
        control: &QueryControl,
    ) -> StoreResult<Option<RecordingPlanReceipt>> {
        if !id(key) {
            return invalid("invalid recording plan request ID");
        }
        self.run_maintenance(&bounded(control), true, |c, b| {
            sql(c, b, "BEGIN DEFERRED")?;
            let h = read::heads(c, b)?;
            let receipt = find(c, b, "recording_plan_applications", "applied_revision", key)?
                .map(|r| {
                    read::application(
                        c,
                        b,
                        r,
                        h.snapshot,
                        h.ledger.as_deref().ok_or(StoreError::CorruptData)?,
                    )
                    .map(|a| a.receipt)
                })
                .transpose()?;
            b.result(&serde_json::to_value(&receipt)?)?;
            sql(c, b, "ROLLBACK")?;
            Ok(receipt)
        })
    }
}
#[cfg(test)]
pub(in crate::store) mod tests;
