use super::*;

pub(super) fn activate(
    c: &Connection,
    b: &mut Budget,
    request: &ActivateRecordingPlanRequest,
    payload: &str,
    hook: &mut impl FnMut(Boundary) -> StoreResult<()>,
) -> StoreResult<RecordingActivationReceipt> {
    b.bounded_text(payload, MAX_DOCUMENT_BYTES)?;
    sql(c, b, "BEGIN IMMEDIATE")?;
    let h = plan_read::heads(c, b)?;
    if let Some(sequence) = find(c, b, &request.activation_id)? {
        let (old, saved) = read::load(c, b, sequence, &h)?;
        if canonical::encode(&old)? != payload {
            return Err(StoreError::Conflict);
        }
        b.result(&serde_json::to_value(&saved.receipt)?)?;
        sql(c, b, "COMMIT")?;
        return Ok(saved.receipt);
    }
    if h.applied != Some(request.expected_applied_revision)
        || h.mapping != Some(request.expected_mapping_revision)
    {
        return Err(StoreError::Conflict);
    }
    let applied = plan_read::application(
        c,
        b,
        request.expected_applied_revision,
        h.snapshot,
        h.ledger.as_deref().ok_or(StoreError::CorruptData)?,
    )?;
    if !applied.receipt.enabled
        || applied.receipt.mapping_revision != Some(request.expected_mapping_revision)
        || applied.receipt.retention_applied_revision
            != Some(request.expected_retention_applied_revision)
    {
        return Err(StoreError::Conflict);
    }
    let state = idle(c, b)?;
    if state
        .applied_retention_policy
        .as_ref()
        .map(|p| p.applied_revision)
        != Some(request.expected_retention_applied_revision)
    {
        return Err(StoreError::Conflict);
    }
    if state
        .retention_fence
        .cutoff_ms
        .is_some_and(|fence| request.start.at_ms < fence)
    {
        return Err(StoreError::Conflict);
    }
    if h.activation.unwrap_or(0) >= MAX_LEDGER_ENTRIES {
        return Err(StoreError::RecordingPlanCapacity);
    }
    b.work.statement()?;
    b.row()?;
    let reused:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE session_id=?1) OR EXISTS(SELECT 1 FROM session_evidence WHERE clock_epoch=?2)",params![request.session_id,request.start.clock_epoch],|r|r.get(0))?;
    if reused {
        return Err(StoreError::Conflict);
    }
    // Current applied evidence validates both permanent and reserved identity before materialization.
    let mapping = applied.resolution.ok_or(StoreError::CorruptData)?;
    let spec = SessionSpec {
        session_id: request.session_id.clone(),
        members: mapping.members.into_iter().map(|m| m.identity).collect(),
    }
    .validated()?;
    let start = evidence::TimedStart {
        clock_epoch: request.start.clock_epoch.clone(),
        at_ms: request.start.at_ms,
        plan: applied.receipt.plan,
    };
    let sequence = h.activation.unwrap_or(0) + 1;
    let commit = commit_number(c, b)?;
    for d in &spec.members {
        b.work.statement()?;
        c.execute(
            "INSERT INTO series VALUES(?1,?2,?3) ON CONFLICT(series_id) DO NOTHING",
            params![d.series_id, d.hub_instance_id, d.incarnation_id],
        )?;
        b.work.statement()?;
        c.execute(
            "INSERT INTO segments VALUES(?1,?2,?3) ON CONFLICT(series_id,segment_id) DO NOTHING",
            params![d.series_id, d.segment_id, serde_json::to_string(d)?],
        )?;
    }
    hook(Boundary::Metadata)?;
    b.work.statement()?;
    c.execute(
        "INSERT INTO sessions VALUES(?1,'active',?2,0,?3,NULL)",
        params![
            spec.session_id,
            serde_json::to_string(&spec)?,
            commit as i64
        ],
    )?;
    for d in &spec.members {
        b.work.statement()?;
        c.execute(
            "INSERT INTO session_members VALUES(?1,?2,?3)",
            params![spec.session_id, d.series_id, d.segment_id],
        )?;
    }
    evidence::save_start(c, &spec, &start, commit as i64, Some(b))?;
    hook(Boundary::Observation)?;
    let receipt = RecordingActivationReceipt {
        activation_id: request.activation_id.clone(),
        sequence,
        applied_revision: request.expected_applied_revision,
        mapping_revision: request.expected_mapping_revision,
        retention_applied_revision: request.expected_retention_applied_revision,
        commit_version: commit,
        resolved_config_hash: applied.receipt.resolved_config_hash,
        spec,
        plan: start.plan,
        start: request.start.clone(),
    };
    b.work.statement()?;
    c.execute(
        "INSERT INTO recording_activations VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            sequence as i64,
            request.activation_id,
            request.expected_applied_revision as i64,
            request.expected_mapping_revision as i64,
            request.expected_retention_applied_revision as i64,
            request.session_id,
            request.start.clock_epoch,
            payload,
            canonical::hash(payload),
            commit as i64,
            canonical::encode(&receipt)?
        ],
    )?;
    b.work.statement()?;
    let changed=c.execute("UPDATE recording_activation_state SET last_sequence=?1,activation_count=?1 WHERE singleton=1",[sequence as i64])?;
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
