use super::*;

pub(in crate::store) fn validate_snapshot(p: &AppliedRetentionPolicy, snapshot: u64) -> bool {
    (1..=MAX_SAFE).contains(&p.applied_revision)
        && p.commit_version > 0
        && p.commit_version <= snapshot
        && id(&p.request_id)
        && super::super::clock_guard::validate::policy(&p.policy).is_ok()
        && matches!(
            p.policy.cutoff_rule,
            super::super::policy::CutoffRule::Elapsed { .. }
        )
}

pub(super) fn definition(
    connection: &Connection,
    budget: &mut Budget,
    key: &str,
    revision: u64,
) -> StoreResult<Option<(RetentionClockPolicy, u64)>> {
    budget.work.statement()?;
    let row: Option<(String,i64,Option<i64>)> = connection.query_row(
        "SELECT d.payload_json,d.created_commit,(SELECT min(a.commit_version) FROM retention_policy_applications a WHERE a.policy_id=d.policy_id AND a.policy_revision=d.policy_revision) FROM retention_policy_definitions d WHERE d.policy_id=?1 AND d.policy_revision=?2",
        params![key,revision as i64], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    ).optional()?;
    let Some((payload, created, first)) = row else {
        return Ok(None);
    };
    budget.row()?;
    budget.evidence_text(&payload)?;
    let policy: RetentionClockPolicy =
        serde_json::from_str(&payload).map_err(|_| StoreError::CorruptData)?;
    if policy.policy_id != key
        || policy.revision != revision
        || created <= 0
        || first != Some(created)
        || valid_policy(&policy, MAX_SAFE as i64).is_err()
    {
        return Err(StoreError::CorruptData);
    }
    Ok(Some((policy, created as u64)))
}

struct Record {
    applied: AppliedRetentionPolicy,
    request: PolicyApplyRequest,
    receipt: String,
}
type Row = (String, String, i64, Option<i64>, i64, String, i64, String);
fn record(
    connection: &Connection,
    budget: &mut Budget,
    revision: i64,
    snapshot: u64,
    include_receipt: bool,
) -> StoreResult<Record> {
    budget.work.statement()?;
    let (key,payload,rev,expected,commit,policy_id,policy_revision,receipt):Row=connection.query_row(
        "SELECT request_id,payload_json,applied_revision,expected_applied_revision,commit_version,policy_id,policy_revision,CASE WHEN ?2 THEN receipt_json ELSE '' END FROM retention_policy_applications WHERE applied_revision=?1",
        params![revision,include_receipt],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?)),
    ).optional()?.ok_or(StoreError::CorruptData)?;
    budget.row()?;
    budget.evidence_text(&payload)?;
    budget.evidence_text(&receipt)?;
    let request: PolicyApplyRequest =
        serde_json::from_str(&payload).map_err(|_| StoreError::CorruptData)?;
    if validate_request(&request).is_err()
        || key != request.request_id
        || rev != revision
        || rev <= 0
        || rev as u64 > MAX_SAFE
        || expected != request.expected_applied_revision.map(|n| n as i64)
        || expected != if rev == 1 { None } else { Some(rev - 1) }
        || commit <= 0
        || commit as u64 > snapshot
        || request.expected_preview_snapshot_commit.checked_add(1) != Some(commit as u64)
        || policy_id != request.proposed_policy.policy_id
        || policy_revision <= 0
        || policy_revision as u64 != request.proposed_policy.revision
    {
        return Err(StoreError::CorruptData);
    }
    let (policy, created) = definition(connection, budget, &policy_id, policy_revision as u64)?
        .ok_or(StoreError::CorruptData)?;
    if policy != request.proposed_policy || created > commit as u64 {
        return Err(StoreError::CorruptData);
    }
    if let Some(previous) = expected {
        budget.work.statement()?;
        let previous_commit:Option<i64>=connection.query_row("SELECT commit_version FROM retention_policy_applications WHERE applied_revision=?1",[previous],|r|r.get(0)).optional()?;
        budget.row()?;
        if previous_commit.is_none_or(|c| {
            c <= 0 || c >= commit || c as u64 > request.expected_preview_snapshot_commit
        }) {
            return Err(StoreError::CorruptData);
        }
    }
    Ok(Record {
        applied: AppliedRetentionPolicy {
            applied_revision: rev as u64,
            commit_version: commit as u64,
            request_id: key,
            policy,
        },
        request,
        receipt,
    })
}

pub(super) fn load_receipt(
    connection: &Connection,
    budget: &mut Budget,
    revision: i64,
) -> StoreResult<(PolicyApplyRequest, PolicyApplyReceipt)> {
    budget.work.statement()?;
    let snapshot: i64 = connection
        .query_row(
            "SELECT last_commit FROM store_meta WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(StoreError::CorruptData)?;
    budget.row()?;
    if snapshot < 0 {
        return Err(StoreError::CorruptData);
    }
    let row = record(connection, budget, revision, snapshot as u64, true)?;
    let receipt: PolicyApplyReceipt =
        serde_json::from_str(&row.receipt).map_err(|_| StoreError::CorruptData)?;
    let previous = if let Some(rev) = row.request.expected_applied_revision {
        Some(record(connection, budget, rev as i64, snapshot as u64, false)?.applied)
    } else {
        None
    };
    if receipt.request_id != row.applied.request_id
        || receipt.applied_revision != row.applied.applied_revision
        || receipt.commit_version != row.applied.commit_version
        || receipt.policy_id != row.applied.policy.policy_id
        || receipt.policy_revision != row.applied.policy.revision
        || receipt.preview.reference_wall_ms != row.request.reference_wall_ms
        || receipt.preview.proposed.policy != row.request.proposed_policy
        || receipt.preview.recovery.snapshot_commit != row.request.expected_preview_snapshot_commit
        || receipt.preview.recovery.active_job.is_some()
        || receipt.preview.recovery.applied_retention_policy != previous
        || receipt.preview.comparison.as_ref().map(|p| &p.policy)
            != previous.as_ref().map(|p| &p.policy)
    {
        return Err(StoreError::CorruptData);
    }
    preview::validate_saved_preview(&receipt.preview)?;
    Ok((row.request, receipt))
}

pub(in crate::store) fn load_current(
    connection: &Connection,
    budget: &mut Budget,
    snapshot: u64,
) -> StoreResult<Option<AppliedRetentionPolicy>> {
    budget.work.statement()?;
    let pointer: Option<i64> = connection
        .query_row(
            "SELECT applied_revision FROM retention_policy_state WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .optional()?
        .ok_or(StoreError::CorruptData)?;
    budget.row()?;
    budget.work.statement()?;
    let (head, last): (Option<i64>, Option<i64>) = connection.query_row(
        "SELECT (SELECT applied_revision FROM retention_policy_applications ORDER BY applied_revision DESC LIMIT 1),(SELECT commit_version FROM retention_policy_applications ORDER BY commit_version DESC LIMIT 1)",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    budget.row()?;
    if pointer != head || last.is_some_and(|c| c <= 0 || c as u64 > snapshot) {
        return Err(StoreError::CorruptData);
    }
    let Some(revision) = pointer else {
        budget.work.statement()?;
        let orphan: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM retention_policy_definitions)",
            [],
            |r| r.get(0),
        )?;
        budget.row()?;
        if orphan || last.is_some() {
            return Err(StoreError::CorruptData);
        }
        return Ok(None);
    };
    let (_, receipt) = load_receipt(connection, budget, revision)?;
    if Some(receipt.commit_version as i64) != last {
        return Err(StoreError::CorruptData);
    }
    let applied = AppliedRetentionPolicy {
        applied_revision: receipt.applied_revision,
        commit_version: receipt.commit_version,
        request_id: receipt.request_id,
        policy: receipt.preview.proposed.policy,
    };
    if !validate_snapshot(&applied, snapshot) {
        return Err(StoreError::CorruptData);
    }
    Ok(Some(applied))
}

pub(in crate::store) fn validate_binding(
    connection: &Connection,
    budget: &mut Budget,
    revision: u64,
    begin: u64,
) -> StoreResult<()> {
    let (_, receipt) = load_receipt(connection, budget, revision as i64)?;
    if receipt.commit_version >= begin {
        return Err(StoreError::CorruptData);
    }
    Ok(())
}
