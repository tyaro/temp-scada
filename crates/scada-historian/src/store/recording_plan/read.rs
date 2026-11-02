use super::*;
use serde::de::DeserializeOwned;
use serde::Serialize;
pub(super) struct Heads {
    pub snapshot: u64,
    pub ledger: Option<String>,
    pub mapping: Option<u64>,
    pub applied: Option<u64>,
    pub definitions: u64,
}
pub(super) fn snapshot(c: &Connection, b: &mut Budget) -> StoreResult<u64> {
    b.work.statement()?;
    b.row()?;
    let n: Option<i64> = c
        .query_row(
            "SELECT last_commit FROM store_meta WHERE singleton=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    n.filter(|n| *n >= 0)
        .map(|n| n as u64)
        .ok_or(StoreError::CorruptData)
}
pub(super) fn heads(c: &Connection, b: &mut Budget) -> StoreResult<Heads> {
    let snapshot = snapshot(c, b)?;
    b.work.statement()?;
    b.row()?;
    let (mapping,count,max,actual):(Option<i64>,i64,Option<i64>,i64)=c.query_row("SELECT mapping_revision,revision_count,(SELECT max(mapping_revision) FROM recording_mapping_revisions),(SELECT count(*) FROM recording_mapping_revisions) FROM recording_mapping_state WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?.ok_or(StoreError::CorruptData)?;
    if mapping != max
        || count != actual
        || count != mapping.unwrap_or(0)
        || !(0..=MAX_LEDGER_ENTRIES as i64).contains(&count)
    {
        return Err(StoreError::CorruptData);
    }
    b.work.statement()?;
    b.row()?;
    type Row = (Option<String>, Option<i64>, i64, i64, Option<i64>, i64, i64);
    let (ledger,applied,count,definitions,max,actual,defs):Row=c.query_row("SELECT ledger_plan_id,applied_revision,application_count,definition_count,(SELECT max(applied_revision) FROM recording_plan_applications),(SELECT count(*) FROM recording_plan_applications),(SELECT count(*) FROM recording_desired_definitions) FROM recording_plan_state WHERE singleton=1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?.ok_or(StoreError::CorruptData)?;
    if applied != max
        || count != actual
        || count != applied.unwrap_or(0)
        || !(0..=MAX_LEDGER_ENTRIES as i64).contains(&count)
        || definitions != defs
        || !(0..=count).contains(&definitions)
        || ledger.is_some() != applied.is_some()
        || ledger.as_ref().is_some_and(|id_| !id(id_))
        || applied.is_none() && definitions != 0
    {
        return Err(StoreError::CorruptData);
    }
    Ok(Heads {
        snapshot,
        ledger,
        mapping: mapping.map(|n| n as u64),
        applied: applied.map(|n| n as u64),
        definitions: definitions as u64,
    })
}
pub(super) fn decode<T: DeserializeOwned + Serialize>(
    text: &str,
    b: &mut Budget,
) -> StoreResult<T> {
    b.bounded_text(text, MAX_DOCUMENT_BYTES)?;
    let result: T = serde_json::from_str(text).map_err(|_| StoreError::CorruptData)?;
    if canonical::encode(&result).map_err(|_| StoreError::CorruptData)? != text {
        return Err(StoreError::CorruptData);
    }
    Ok(result)
}
fn previous(
    c: &Connection,
    b: &mut Budget,
    table: &str,
    key: &str,
    revision: u64,
    commit: u64,
) -> StoreResult<()> {
    if !(1..=MAX_LEDGER_ENTRIES).contains(&revision) || commit == 0 {
        return Err(StoreError::CorruptData);
    }
    if revision > 1 {
        b.work.statement()?;
        b.row()?;
        let n: Option<i64> = c
            .query_row(
                &format!("SELECT commit_version FROM {table} WHERE {key}=?1"),
                [revision as i64 - 1],
                |r| r.get(0),
            )
            .optional()?;
        if n.is_none_or(|n| n <= 0 || n as u64 >= commit) {
            return Err(StoreError::CorruptData);
        }
    }
    Ok(())
}
pub(super) fn mapping(
    c: &Connection,
    b: &mut Budget,
    revision: u64,
    snapshot: u64,
) -> StoreResult<RegisteredRecordingMapping> {
    b.work.statement()?;
    b.row()?;
    type Row = (String, Option<i64>, String, String, i64, String);
    let (key,expected,payload,hash,commit,receipt):Row=c.query_row("SELECT request_id,expected_revision,request_json,mapping_hash,commit_version,receipt_json FROM recording_mapping_revisions WHERE mapping_revision=?1",[revision as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?.ok_or(StoreError::CorruptData)?;
    let request: RegisterMappingRequest = decode(&payload, b)?;
    canonical::validate_mapping(&request).map_err(|_| StoreError::CorruptData)?;
    let result: MappingReceipt = decode(&receipt, b)?;
    previous(
        c,
        b,
        "recording_mapping_revisions",
        "mapping_revision",
        revision,
        commit as u64,
    )?;
    if key != request.request_id
        || expected != request.expected_mapping_revision.map(|n| n as i64)
        || expected
            != if revision == 1 {
                None
            } else {
                Some(revision as i64 - 1)
            }
        || commit <= 0
        || commit as u64 > snapshot
        || hash != canonical::hash(&canonical::encode(&request.mapping)?)
        || result
            != (MappingReceipt {
                request_id: key,
                mapping_revision: revision,
                commit_version: commit as u64,
                mapping_hash: hash,
            })
    {
        return Err(StoreError::CorruptData);
    }
    Ok(RegisteredRecordingMapping {
        receipt: result,
        mapping: request.mapping,
    })
}
pub(super) fn definition(
    c: &Connection,
    b: &mut Budget,
    plan_id: &str,
    revision: u64,
) -> StoreResult<Option<(serde_json::Value, String, u64)>> {
    b.work.statement()?;
    let row:Option<(String,String,i64,Option<i64>)>=c.query_row("SELECT desired_json,desired_hash,created_commit,(SELECT min(commit_version) FROM recording_plan_applications WHERE plan_id=?1 AND desired_revision=?2) FROM recording_desired_definitions WHERE plan_id=?1 AND revision=?2",params![plan_id,revision as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let Some((text, hash, created, first)) = row else {
        return Ok(None);
    };
    b.row()?;
    let desired: serde_json::Value = decode(&text, b)?;
    if scada_model::recording_plan::validate_recording_plan(&desired).is_err()
        || desired["planId"] != plan_id
        || desired["revision"].as_u64() != Some(revision)
        || hash != canonical::hash(&text)
        || created <= 0
        || first != Some(created)
    {
        return Err(StoreError::CorruptData);
    }
    Ok(Some((desired, hash, created as u64)))
}
fn application_evidence(
    c: &Connection,
    b: &mut Budget,
    revision: u64,
    snapshot: u64,
    ledger: &str,
    verify_receipt: bool,
) -> StoreResult<AppliedRecordingPlan> {
    b.work.statement()?;
    b.row()?;
    type Row = (
        String,
        Option<i64>,
        String,
        String,
        i64,
        Option<i64>,
        Option<i64>,
        String,
        String,
        i64,
        String,
    );
    let (key,expected,payload,desired_id,desired_revision,mapping_rev,retention_rev,resolved,hash,commit,receipt):Row=c.query_row("SELECT request_id,expected_revision,request_json,plan_id,desired_revision,mapping_revision,retention_revision,resolved_json,resolved_hash,commit_version,CASE WHEN ?2 THEN receipt_json ELSE 'null' END FROM recording_plan_applications WHERE applied_revision=?1",params![revision as i64, verify_receipt],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?))).optional()?.ok_or(StoreError::CorruptData)?;
    let request: ApplyRecordingPlanRequest = decode(&payload, b)?;
    canonical::validate_apply(&request).map_err(|_| StoreError::CorruptData)?;
    let result: Option<RecordingPlanReceipt> = if verify_receipt {
        Some(decode(&receipt, b)?)
    } else {
        None
    };
    let resolution: Option<RecordingMapping> = decode(&resolved, b)?;
    previous(
        c,
        b,
        "recording_plan_applications",
        "applied_revision",
        revision,
        commit as u64,
    )?;
    if key != request.request_id
        || expected != request.expected_applied_revision.map(|n| n as i64)
        || expected
            != if revision == 1 {
                None
            } else {
                Some(revision as i64 - 1)
            }
        || commit <= 0
        || commit as u64 > snapshot
        || mapping_rev != request.expected_mapping_revision.map(|n| n as i64)
        || retention_rev
            != request
                .expected_retention_applied_revision
                .map(|n| n as i64)
    {
        return Err(StoreError::CorruptData);
    }
    let (desired, desired_hash, first) =
        definition(c, b, &desired_id, desired_revision as u64)?.ok_or(StoreError::CorruptData)?;
    if desired != request.desired || first > commit as u64 {
        return Err(StoreError::CorruptData);
    }
    let saved_mapping = mapping_rev
        .map(|r| mapping(c, b, r as u64, snapshot))
        .transpose()?;
    if saved_mapping
        .as_ref()
        .is_some_and(|m| m.receipt.commit_version >= commit as u64)
    {
        return Err(StoreError::CorruptData);
    }
    let expected_resolution = canonical::resolution(&request, saved_mapping.map(|m| m.mapping))
        .map_err(|_| StoreError::CorruptData)?;
    let config = serde_json::json!({"desired":request.desired,"mapping":resolution});
    if resolution != expected_resolution || hash != canonical::hash(&canonical::encode(&config)?) {
        return Err(StoreError::CorruptData);
    }
    if let Some(rev) = retention_rev {
        retention::application::validate_binding(c, b, rev as u64, commit as u64)?;
    }
    let expected_receipt = RecordingPlanReceipt {
        request_id: key,
        applied_revision: revision,
        commit_version: commit as u64,
        desired_plan_id: desired_id,
        desired_revision: desired_revision as u64,
        desired_hash,
        resolved_config_hash: hash,
        plan: evidence::PlanRef {
            plan_id: ledger.into(),
            revision,
        },
        mapping_revision: mapping_rev.map(|n| n as u64),
        retention_applied_revision: retention_rev.map(|n| n as u64),
        enabled: request.desired["enabled"] == true,
    };
    if result.as_ref().is_some_and(|r| r != &expected_receipt) {
        return Err(StoreError::CorruptData);
    }
    Ok(AppliedRecordingPlan {
        request,
        receipt: expected_receipt,
        resolution,
    })
}
/// Read one application's direct evidence, never its reservations or prior receipt bodies.
pub(super) fn first_application(
    c: &Connection,
    b: &mut Budget,
    revision: u64,
    snapshot: u64,
) -> StoreResult<AppliedRecordingPlan> {
    // PlanRef is unused in this metadata-only proof; the ledger ID is checked at the outer head.
    application_evidence(c, b, revision, snapshot, "first-use-proof", false)
}
pub(super) fn application(
    c: &Connection,
    b: &mut Budget,
    revision: u64,
    snapshot: u64,
    ledger: &str,
) -> StoreResult<AppliedRecordingPlan> {
    let result = application_evidence(c, b, revision, snapshot, ledger, true)?;
    if let Some(mapping) = &result.resolution {
        reservations::check(c, b, mapping, Some(revision))?;
    }
    Ok(result)
}
pub(super) fn state(c: &Connection, b: &mut Budget) -> StoreResult<RecordingPlanState> {
    let h = heads(c, b)?;
    let mapping = h
        .mapping
        .map(|rev| mapping(c, b, rev, h.snapshot))
        .transpose()?;
    let applied = h
        .applied
        .map(|rev| {
            application(
                c,
                b,
                rev,
                h.snapshot,
                h.ledger.as_deref().ok_or(StoreError::CorruptData)?,
            )
        })
        .transpose()?;
    Ok(RecordingPlanState {
        snapshot_commit: h.snapshot,
        ledger_plan_id: h.ledger,
        mapping,
        applied,
        activation_supported: false,
    })
}
