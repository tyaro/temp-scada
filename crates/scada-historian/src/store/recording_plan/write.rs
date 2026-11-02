use super::*;
pub(super) fn register(
    c: &Connection,
    b: &mut Budget,
    normalized: &RegisterMappingRequest,
    payload: &str,
    hook: &mut impl FnMut(Boundary) -> StoreResult<()>,
) -> StoreResult<MappingReceipt> {
    b.bounded_text(payload, MAX_DOCUMENT_BYTES)?;
    sql(c, b, "BEGIN IMMEDIATE")?;
    let snapshot = read::heads(c, b)?.snapshot;
    if let Some(revision) = find(
        c,
        b,
        "recording_mapping_revisions",
        "mapping_revision",
        &normalized.request_id,
    )? {
        let saved = read::mapping(c, b, revision, snapshot)?;
        b.work.statement()?;
        b.row()?;
        let old: String = c.query_row(
            "SELECT request_json FROM recording_mapping_revisions WHERE mapping_revision=?1",
            [revision as i64],
            |r| r.get(0),
        )?;
        b.bounded_text(&old, MAX_DOCUMENT_BYTES)?;
        if old != payload {
            return Err(StoreError::Conflict);
        }
        b.result(&serde_json::to_value(&saved.receipt)?)?;
        sql(c, b, "COMMIT")?;
        return Ok(saved.receipt);
    }
    let heads = read::heads(c, b)?;
    if heads.mapping != normalized.expected_mapping_revision {
        return Err(StoreError::Conflict);
    }
    if let Some(rev) = heads.mapping {
        read::mapping(c, b, rev, heads.snapshot)?;
    }
    idle(c, b)?;
    if heads.mapping.unwrap_or(0) >= MAX_LEDGER_ENTRIES {
        return Err(StoreError::RecordingPlanCapacity);
    }
    reservations::check(c, b, &normalized.mapping, None)?;
    let revision = heads.mapping.unwrap_or(0) + 1;
    let commit = commit_number(c, b)?;
    let receipt = MappingReceipt {
        request_id: normalized.request_id.clone(),
        mapping_revision: revision,
        commit_version: commit,
        mapping_hash: canonical::hash(&canonical::encode(&normalized.mapping)?),
    };
    b.work.statement()?;
    c.execute(
        "INSERT INTO recording_mapping_revisions VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            revision as i64,
            normalized.request_id,
            normalized.expected_mapping_revision.map(|n| n as i64),
            payload,
            receipt.mapping_hash,
            commit as i64,
            canonical::encode(&receipt)?
        ],
    )?;
    hook(Boundary::Metadata)?;
    b.work.statement()?;
    let changed = c.execute(
        "UPDATE recording_mapping_state SET mapping_revision=?1,revision_count=?1 WHERE singleton=1",
        [revision as i64],
    )?;
    if changed != 1 {
        return Err(StoreError::CorruptData);
    }
    hook(Boundary::Watermark)?;
    b.result(&serde_json::to_value(&receipt)?)?;
    hook(Boundary::BeforeCommit)?;
    sql(c, b, "COMMIT")?;
    hook(Boundary::AfterCommit)?;
    Ok(receipt)
}

pub(super) fn apply(
    c: &Connection,
    b: &mut Budget,
    request: &ApplyRecordingPlanRequest,
    payload: &str,
    hook: &mut impl FnMut(Boundary) -> StoreResult<()>,
) -> StoreResult<RecordingPlanReceipt> {
    b.bounded_text(payload, MAX_DOCUMENT_BYTES)?;
    sql(c, b, "BEGIN IMMEDIATE")?;
    if let Some(revision) = find(
        c,
        b,
        "recording_plan_applications",
        "applied_revision",
        &request.request_id,
    )? {
        let h = read::heads(c, b)?;
        let saved = read::application(
            c,
            b,
            revision,
            h.snapshot,
            h.ledger.as_deref().ok_or(StoreError::CorruptData)?,
        )?;
        if canonical::encode(&saved.request)? != payload {
            return Err(StoreError::Conflict);
        }
        b.result(&serde_json::to_value(&saved.receipt)?)?;
        sql(c, b, "COMMIT")?;
        return Ok(saved.receipt);
    }
    let h = read::heads(c, b)?;
    if h.applied != request.expected_applied_revision {
        return Err(StoreError::Conflict);
    }
    if let Some(revision) = h.applied {
        read::application(
            c,
            b,
            revision,
            h.snapshot,
            h.ledger.as_deref().ok_or(StoreError::CorruptData)?,
        )?;
    }
    let recovery = idle(c, b)?;
    if h.applied.unwrap_or(0) >= MAX_LEDGER_ENTRIES {
        return Err(StoreError::RecordingPlanCapacity);
    }
    let mapping = if let Some(revision) = request.expected_mapping_revision {
        if h.mapping != Some(revision)
            || recovery
                .applied_retention_policy
                .as_ref()
                .map(|p| p.applied_revision)
                != request.expected_retention_applied_revision
        {
            return Err(StoreError::Conflict);
        }
        Some(read::mapping(c, b, revision, h.snapshot)?.mapping)
    } else {
        None
    };
    let resolution = canonical::resolution(request, mapping)?;
    if let Some(mapping) = &resolution {
        reservations::check(c, b, mapping, None)?;
    }
    let plan_id = request.desired["planId"]
        .as_str()
        .ok_or(StoreError::CorruptData)?;
    let desired_revision = request.desired["revision"]
        .as_u64()
        .ok_or(StoreError::CorruptData)?;
    let previous = read::definition(c, b, plan_id, desired_revision)?;
    if previous
        .as_ref()
        .is_some_and(|(old, _, _)| old != &request.desired)
    {
        return Err(StoreError::Conflict);
    }
    if previous.is_none() && h.definitions >= MAX_LEDGER_ENTRIES {
        return Err(StoreError::RecordingPlanCapacity);
    }
    let ledger = h
        .ledger
        .unwrap_or_else(|| format!("recording:{}", uuid::Uuid::new_v4()));
    if h.applied.is_none() {
        b.work.statement()?;
        b.row()?;
        let collision: bool = c.query_row(
            "SELECT EXISTS(SELECT 1 FROM recording_plans WHERE plan_id=?1)",
            [&ledger],
            |r| r.get(0),
        )?;
        if collision {
            return Err(StoreError::Conflict);
        }
    }
    let revision = h.applied.unwrap_or(0) + 1;
    let commit = commit_number(c, b)?;
    let desired_text = canonical::encode(&request.desired)?;
    let desired_hash = canonical::hash(&desired_text);
    if previous.is_none() {
        b.work.statement()?;
        c.execute(
            "INSERT INTO recording_desired_definitions VALUES(?1,?2,?3,?4,?5)",
            params![
                plan_id,
                desired_revision as i64,
                desired_text,
                desired_hash,
                commit as i64
            ],
        )?;
    }
    hook(Boundary::Metadata)?;
    let hash = canonical::hash(&canonical::encode(
        &serde_json::json!({"desired":request.desired,"mapping":resolution}),
    )?);
    let receipt = RecordingPlanReceipt {
        request_id: request.request_id.clone(),
        applied_revision: revision,
        commit_version: commit,
        desired_plan_id: plan_id.into(),
        desired_revision,
        desired_hash,
        resolved_config_hash: hash,
        plan: evidence::PlanRef {
            plan_id: ledger.clone(),
            revision,
        },
        mapping_revision: request.expected_mapping_revision,
        retention_applied_revision: request.expected_retention_applied_revision,
        enabled: request.desired["enabled"] == true,
    };
    b.work.statement()?;
    c.execute(
        "INSERT INTO recording_plan_applications VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            revision as i64,
            request.request_id,
            request.expected_applied_revision.map(|n| n as i64),
            payload,
            plan_id,
            desired_revision as i64,
            request.expected_mapping_revision.map(|n| n as i64),
            request
                .expected_retention_applied_revision
                .map(|n| n as i64),
            canonical::encode(&resolution)?,
            receipt.resolved_config_hash,
            commit as i64,
            canonical::encode(&receipt)?
        ],
    )?;
    hook(Boundary::Observation)?;
    if let Some(mapping) = &resolution {
        reservations::reserve(c, b, mapping, revision)?;
    }
    b.work.statement()?;
    let changed = c.execute(
        "UPDATE recording_plan_state SET ledger_plan_id=?1,applied_revision=?2,application_count=?2,definition_count=?3 WHERE singleton=1",
        params![ledger, revision as i64, (h.definitions + u64::from(previous.is_none())) as i64],
    )?;
    if changed != 1 {
        return Err(StoreError::CorruptData);
    }
    hook(Boundary::Watermark)?;
    b.result(&serde_json::to_value(&receipt)?)?;
    hook(Boundary::BeforeCommit)?;
    sql(c, b, "COMMIT")?;
    hook(Boundary::AfterCommit)?;
    Ok(receipt)
}
