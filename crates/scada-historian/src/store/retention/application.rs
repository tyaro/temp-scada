//! Atomic, explicit retention policy application. Never starts deletion.
mod read;
use super::{
    clock_guard::RetentionClockPolicy,
    policy::derive_cutoff,
    preview::{self, RetentionPreview, RetentionPreviewRequest},
};
use crate::store::{
    id, next_commit,
    query::{control::Budget, QueryControl},
    recovery, Boundary, SqliteStore, StoreError, StoreResult, MAX_SAFE,
};
pub(in crate::store) use read::{load_current, validate_binding, validate_snapshot};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppliedRetentionPolicy {
    pub applied_revision: u64,
    pub commit_version: u64,
    pub request_id: String,
    pub policy: RetentionClockPolicy,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyPreparationRequest {
    pub proposed_policy: RetentionClockPolicy,
    pub reference_wall_ms: i64,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PolicyPreparation {
    pub expected_applied_revision: Option<u64>,
    pub snapshot_commit: u64,
    pub preview: RetentionPreview,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyApplyRequest {
    pub request_id: String,
    pub expected_applied_revision: Option<u64>,
    pub expected_preview_snapshot_commit: u64,
    pub proposed_policy: RetentionClockPolicy,
    pub reference_wall_ms: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyApplyReceipt {
    pub request_id: String,
    pub applied_revision: u64,
    pub commit_version: u64,
    pub policy_id: String,
    pub policy_revision: u64,
    pub preview: RetentionPreview,
}

impl SqliteStore {
    pub fn preview_retention_policy_application(
        &mut self,
        request: &PolicyPreparationRequest,
        control: &QueryControl,
    ) -> StoreResult<PolicyPreparation> {
        valid_policy(&request.proposed_policy, request.reference_wall_ms)?;
        self.run_maintenance(control, true, |connection, budget| {
            sql(connection, budget, "BEGIN DEFERRED")?;
            let state = recovery::read_snapshot(connection, budget, &mut || Ok(()))?;
            let expected_applied_revision = state
                .applied_retention_policy
                .as_ref()
                .map(|p| p.applied_revision);
            let snapshot_commit = state.snapshot_commit;
            let comparison_policy = state
                .applied_retention_policy
                .as_ref()
                .map(|p| p.policy.clone());
            let preview = preview::build_preview(
                connection,
                budget,
                &RetentionPreviewRequest {
                    reference_wall_ms: request.reference_wall_ms,
                    proposed_policy: request.proposed_policy.clone(),
                    comparison_policy,
                },
                state,
            )?;
            let result = PolicyPreparation {
                expected_applied_revision,
                snapshot_commit,
                preview,
            };
            budget.result(&serde_json::to_value(&result)?)?;
            sql(connection, budget, "ROLLBACK")?;
            Ok(result)
        })
    }

    pub fn apply_retention_policy(
        &mut self,
        request: &PolicyApplyRequest,
        control: &QueryControl,
    ) -> StoreResult<PolicyApplyReceipt> {
        self.apply_policy_with_hook(request, control, &mut |_| Ok(()))
    }

    fn apply_policy_with_hook(
        &mut self,
        request: &PolicyApplyRequest,
        control: &QueryControl,
        hook: &mut impl FnMut(Boundary) -> StoreResult<()>,
    ) -> StoreResult<PolicyApplyReceipt> {
        validate_request(request)?;
        self.run_maintenance(control, false, |connection, budget| {
            sql(connection, budget, "BEGIN IMMEDIATE")?;
            budget.work.statement()?;
            let saved: Option<i64> = connection.query_row("SELECT applied_revision FROM retention_policy_applications WHERE request_id=?1", [&request.request_id], |r| r.get(0)).optional()?;
            if let Some(revision) = saved {
                budget.row()?;
                let (old, receipt) = read::load_receipt(connection, budget, revision)?;
                if old != *request { return Err(StoreError::Conflict); }
                budget.result(&serde_json::to_value(&receipt)?)?;
                sql(connection, budget, "COMMIT")?;
                return Ok(receipt);
            }
            let state = recovery::read_snapshot(connection, budget, &mut || Ok(()))?;
            let current = state.applied_retention_policy.as_ref();
            if current.map(|p| p.applied_revision) != request.expected_applied_revision
                || state.snapshot_commit != request.expected_preview_snapshot_commit { return Err(StoreError::Conflict); }
            if state.active_job.is_some() { return Err(StoreError::Busy); }
            let revision = request.expected_applied_revision.unwrap_or(0).checked_add(1)
                .filter(|n| *n <= MAX_SAFE).ok_or(StoreError::Invalid("applied policy revision exhausted"))?;
            let comparison_policy = current.map(|p| p.policy.clone());
            let preview = preview::build_preview(connection, budget, &RetentionPreviewRequest {
                reference_wall_ms: request.reference_wall_ms, proposed_policy: request.proposed_policy.clone(), comparison_policy,
            }, state)?;
            let p = &request.proposed_policy;
            let definition = read::definition(connection, budget, &p.policy_id, p.revision)?;
            if definition.as_ref().is_some_and(|(old, _)| old != p) { return Err(StoreError::Conflict); }
            budget.work.statement()?; budget.work.statement()?; budget.row()?;
            let commit = next_commit(connection)? as u64;
            if definition.is_none() {
                budget.work.statement()?;
                connection.execute("INSERT INTO retention_policy_definitions VALUES (?1,?2,?3,?4)", params![p.policy_id,p.revision as i64,serde_json::to_string(p)?,commit as i64])?;
            }
            hook(Boundary::Metadata)?;
            let receipt = PolicyApplyReceipt { request_id: request.request_id.clone(), applied_revision: revision,
                commit_version: commit, policy_id: p.policy_id.clone(), policy_revision: p.revision, preview };
            budget.work.statement()?;
            connection.execute("INSERT INTO retention_policy_applications VALUES (?1,?2,?3,?4,?5,?6,?7,?8)", params![request.request_id,serde_json::to_string(request)?,revision as i64,request.expected_applied_revision.map(|n|n as i64),commit as i64,p.policy_id,p.revision as i64,serde_json::to_string(&receipt)?])?;
            hook(Boundary::Observation)?;
            budget.work.statement()?;
            if connection.execute("UPDATE retention_policy_state SET applied_revision=?1 WHERE singleton=1", [revision as i64])? != 1 { return Err(StoreError::CorruptData); }
            hook(Boundary::Watermark)?;
            budget.result(&serde_json::to_value(&receipt)?)?;
            hook(Boundary::BeforeCommit)?;
            sql(connection, budget, "COMMIT")?;
            hook(Boundary::AfterCommit)?;
            Ok(receipt)
        })
    }
}

fn valid_policy(policy: &RetentionClockPolicy, reference: i64) -> StoreResult<()> {
    derive_cutoff(policy, reference).map(|_| ()).map_err(|_| {
        StoreError::Invalid("application requires a valid elapsed policy and reference time")
    })
}
fn validate_request(request: &PolicyApplyRequest) -> StoreResult<()> {
    if !id(&request.request_id)
        || request
            .expected_applied_revision
            .is_some_and(|r| !(1..=MAX_SAFE).contains(&r))
        || request.expected_preview_snapshot_commit >= i64::MAX as u64
    {
        return Err(StoreError::Invalid("invalid policy application request"));
    }
    valid_policy(&request.proposed_policy, request.reference_wall_ms)
}
fn sql(connection: &Connection, budget: &Budget, text: &str) -> StoreResult<()> {
    budget.work.statement()?;
    connection.execute_batch(text)?;
    Ok(())
}

#[cfg(test)]
mod tests;
