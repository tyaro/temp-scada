use super::*;
use serde::de::DeserializeOwned;
use serde::Serialize;
pub(super) struct Heads {
    pub snapshot: u64,
    pub ledger: Option<String>,
    pub mapping: Option<u64>,
    pub applied: Option<u64>,
    pub definitions: u64,
    pub activation: Option<u64>,
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
    let activation =
        activation::head(c, b, applied.map(|n| n as u64), snapshot, ledger.as_deref())?;
    Ok(Heads {
        activation,
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
fn previous_saved(revision: u64, commit: i64, previous: Option<i64>) -> StoreResult<()> {
    if !(1..=MAX_LEDGER_ENTRIES).contains(&revision)
        || commit <= 0
        || (revision > 1 && previous.is_none_or(|n| n <= 0 || n >= commit))
    {
        return Err(StoreError::CorruptData);
    }
    Ok(())
}
type MappingRow = (
    String,
    Option<i64>,
    String,
    String,
    i64,
    String,
    Option<i64>,
);
type DefinitionRow = (String, String, i64, Option<i64>);
pub(super) fn mapping(
    c: &Connection,
    b: &mut Budget,
    revision: u64,
    snapshot: u64,
) -> StoreResult<RegisteredRecordingMapping> {
    b.work.statement()?;
    b.row()?;
    let row:MappingRow=c.query_row("SELECT m.request_id,m.expected_revision,m.request_json,m.mapping_hash,m.commit_version,m.receipt_json,(SELECT commit_version FROM recording_mapping_revisions WHERE mapping_revision=m.expected_revision) FROM recording_mapping_revisions m WHERE m.mapping_revision=?1",[revision as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?.ok_or(StoreError::CorruptData)?;
    mapping_evidence(row, revision, snapshot, b)
}
fn mapping_evidence(
    row: MappingRow,
    revision: u64,
    snapshot: u64,
    b: &mut Budget,
) -> StoreResult<RegisteredRecordingMapping> {
    let (key, expected, payload, hash, commit, receipt, previous) = row;
    let request: RegisterMappingRequest = decode(&payload, b)?;
    canonical::validate_mapping(&request).map_err(|_| StoreError::CorruptData)?;
    let result: MappingReceipt = decode(&receipt, b)?;
    previous_saved(revision, commit, previous)?;
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
    let row:Option<DefinitionRow>=c.query_row("SELECT desired_json,desired_hash,created_commit,(SELECT min(commit_version) FROM recording_plan_applications WHERE plan_id=?1 AND desired_revision=?2) FROM recording_desired_definitions WHERE plan_id=?1 AND revision=?2",params![plan_id,revision as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    row.map(|row| {
        b.row()?;
        definition_evidence(row, plan_id, revision, b)
    })
    .transpose()
}
fn definition_evidence(
    row: DefinitionRow,
    plan_id: &str,
    revision: u64,
    b: &mut Budget,
) -> StoreResult<(serde_json::Value, String, u64)> {
    let (text, hash, created, first) = row;
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
    Ok((desired, hash, created as u64))
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
    type ApplicationRow = (
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
    let (row,previous,definition_row,mapping_row):(ApplicationRow,Option<i64>,Option<DefinitionRow>,Option<MappingRow>)=c.query_row(
        "SELECT a.request_id,a.expected_revision,a.request_json,a.plan_id,a.desired_revision,a.mapping_revision,a.retention_revision,a.resolved_json,a.resolved_hash,a.commit_version,CASE WHEN ?2 THEN a.receipt_json ELSE 'null' END,(SELECT commit_version FROM recording_plan_applications WHERE applied_revision=a.expected_revision),d.desired_json,d.desired_hash,d.created_commit,(SELECT min(commit_version) FROM recording_plan_applications WHERE plan_id=a.plan_id AND desired_revision=a.desired_revision),m.request_id,m.expected_revision,m.request_json,m.mapping_hash,m.commit_version,m.receipt_json,(SELECT commit_version FROM recording_mapping_revisions WHERE mapping_revision=m.expected_revision) FROM recording_plan_applications a LEFT JOIN recording_desired_definitions d ON d.plan_id=a.plan_id AND d.revision=a.desired_revision LEFT JOIN recording_mapping_revisions m ON m.mapping_revision=a.mapping_revision WHERE a.applied_revision=?1",
        params![revision as i64,verify_receipt],|r| {
            let application=(r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?);
            let definition=match r.get::<_,Option<String>>(12)? {None=>None,Some(text)=>Some((text,r.get(13)?,r.get(14)?,r.get(15)?))};
            let mapping=match r.get::<_,Option<String>>(16)? {None=>None,Some(key)=>Some((key,r.get(17)?,r.get(18)?,r.get(19)?,r.get(20)?,r.get(21)?,r.get(22)?))};
            Ok((application,r.get(11)?,definition,mapping))
        },
    ).optional()?.ok_or(StoreError::CorruptData)?;
    let (
        key,
        expected,
        payload,
        desired_id,
        desired_revision,
        mapping_rev,
        retention_rev,
        resolved,
        hash,
        commit,
        receipt,
    ) = row;
    let request: ApplyRecordingPlanRequest = decode(&payload, b)?;
    canonical::validate_apply(&request).map_err(|_| StoreError::CorruptData)?;
    let result: Option<RecordingPlanReceipt> = if verify_receipt {
        Some(decode(&receipt, b)?)
    } else {
        None
    };
    let resolution: Option<RecordingMapping> = decode(&resolved, b)?;
    previous_saved(revision, commit, previous)?;
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
    let (desired, desired_hash, first) = definition_evidence(
        definition_row.ok_or(StoreError::CorruptData)?,
        &desired_id,
        desired_revision as u64,
        b,
    )?;
    if desired != request.desired || first > commit as u64 {
        return Err(StoreError::CorruptData);
    }
    let saved_mapping = match (mapping_rev, mapping_row) {
        (None, None) => None,
        (Some(rev), Some(row)) => Some(mapping_evidence(row, rev as u64, snapshot, b)?),
        _ => return Err(StoreError::CorruptData),
    };
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
    application_with_cache(
        c,
        b,
        revision,
        snapshot,
        ledger,
        &mut reservations::EvidenceCache::default(),
    )
}
pub(super) fn application_with_cache(
    c: &Connection,
    b: &mut Budget,
    revision: u64,
    snapshot: u64,
    ledger: &str,
    cache: &mut reservations::EvidenceCache,
) -> StoreResult<AppliedRecordingPlan> {
    if let Some(saved) = cache.applications.get(&revision) {
        if saved.receipt.applied_revision != revision
            || saved.receipt.plan.plan_id != ledger
            || saved.receipt.commit_version > snapshot
        {
            return Err(StoreError::CorruptData);
        }
        return Ok(saved.clone());
    }
    let result = application_evidence(c, b, revision, snapshot, ledger, true)?;
    if let Some(mapping) = &result.resolution {
        reservations::check_with_cache(c, b, mapping, Some(revision), cache)?;
    }
    cache.applications.insert(revision, result.clone());
    Ok(result)
}
pub(super) fn state(c: &Connection, b: &mut Budget) -> StoreResult<RecordingPlanState> {
    let h = heads(c, b)?;
    state_from_heads(c, b, &h, &mut reservations::EvidenceCache::default())
}
pub(super) fn state_from_heads(
    c: &Connection,
    b: &mut Budget,
    h: &Heads,
    cache: &mut reservations::EvidenceCache,
) -> StoreResult<RecordingPlanState> {
    let mapping = h
        .mapping
        .map(|rev| mapping(c, b, rev, h.snapshot))
        .transpose()?;
    let applied = h
        .applied
        .map(|rev| {
            application_with_cache(
                c,
                b,
                rev,
                h.snapshot,
                h.ledger.as_deref().ok_or(StoreError::CorruptData)?,
                cache,
            )
        })
        .transpose()?;
    Ok(RecordingPlanState {
        snapshot_commit: h.snapshot,
        ledger_plan_id: h.ledger.clone(),
        mapping,
        applied,
        activation_supported: true,
    })
}
