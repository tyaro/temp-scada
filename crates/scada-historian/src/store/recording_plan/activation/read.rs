use super::*;

pub(super) fn load(
    c: &Connection,
    b: &mut Budget,
    sequence: u64,
    h: &plan_read::Heads,
) -> StoreResult<(ActivateRecordingPlanRequest, RecordingActivation)> {
    load_with_cache(
        c,
        b,
        sequence,
        h,
        &mut reservations::EvidenceCache::default(),
    )
}
pub(super) fn load_with_cache(
    c: &Connection,
    b: &mut Budget,
    sequence: u64,
    h: &plan_read::Heads,
    cache: &mut reservations::EvidenceCache,
) -> StoreResult<(ActivateRecordingPlanRequest, RecordingActivation)> {
    if !(1..=MAX_LEDGER_ENTRIES).contains(&sequence) || h.activation.is_none_or(|n| sequence > n) {
        return Err(StoreError::CorruptData);
    }
    b.work.statement()?;
    b.row()?;
    type Row = (
        String,
        i64,
        i64,
        i64,
        String,
        String,
        String,
        String,
        i64,
        String,
    );
    let (key,applied_rev,mapping_rev,retention_rev,session_id,epoch,payload,hash,commit,receipt):Row=c.query_row("SELECT activation_id,applied_revision,mapping_revision,retention_revision,session_id,clock_epoch,request_json,request_hash,commit_version,receipt_json FROM recording_activations WHERE sequence=?1",[sequence as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?))).optional()?.ok_or(StoreError::CorruptData)?;
    let request: ActivateRecordingPlanRequest = plan_read::decode(&payload, b)?;
    validate(&request).map_err(|_| StoreError::CorruptData)?;
    let saved: RecordingActivationReceipt = plan_read::decode(&receipt, b)?;
    if key != request.activation_id
        || applied_rev <= 0
        || applied_rev as u64 != request.expected_applied_revision
        || mapping_rev <= 0
        || mapping_rev as u64 != request.expected_mapping_revision
        || retention_rev <= 0
        || retention_rev as u64 != request.expected_retention_applied_revision
        || session_id != request.session_id
        || epoch != request.start.clock_epoch
        || hash != canonical::hash(&payload)
        || commit <= 0
        || commit as u64 > h.snapshot
    {
        return Err(StoreError::CorruptData);
    }
    if sequence > 1 {
        b.work.statement()?;
        b.row()?;
        let previous: Option<i64> = c
            .query_row(
                "SELECT commit_version FROM recording_activations WHERE sequence=?1",
                [sequence as i64 - 1],
                |r| r.get(0),
            )
            .optional()?;
        if previous.is_none_or(|p| p <= 0 || p >= commit) {
            return Err(StoreError::CorruptData);
        }
    }
    let applied = plan_read::application_with_cache(
        c,
        b,
        applied_rev as u64,
        h.snapshot,
        h.ledger.as_deref().ok_or(StoreError::CorruptData)?,
        cache,
    )?;
    if !applied.receipt.enabled
        || applied.receipt.mapping_revision != Some(mapping_rev as u64)
        || applied.receipt.retention_applied_revision != Some(retention_rev as u64)
        || applied.receipt.commit_version >= commit as u64
    {
        return Err(StoreError::CorruptData);
    }
    let spec = SessionSpec {
        session_id: session_id.clone(),
        members: applied
            .resolution
            .ok_or(StoreError::CorruptData)?
            .members
            .into_iter()
            .map(|m| m.identity)
            .collect(),
    }
    .validated()
    .map_err(|_| StoreError::CorruptData)?;
    let expected = RecordingActivationReceipt {
        activation_id: key,
        sequence,
        applied_revision: applied_rev as u64,
        mapping_revision: mapping_rev as u64,
        retention_applied_revision: retention_rev as u64,
        commit_version: commit as u64,
        resolved_config_hash: applied.receipt.resolved_config_hash,
        spec,
        plan: applied.receipt.plan,
        start: request.start.clone(),
    };
    if saved != expected {
        return Err(StoreError::CorruptData);
    }
    let session = session(c, b, &saved, h.snapshot)?;
    evidence(c, b, &saved, &session)?;
    Ok((
        request,
        RecordingActivation {
            receipt: saved,
            session,
        },
    ))
}
fn session(
    c: &Connection,
    b: &mut Budget,
    receipt: &RecordingActivationReceipt,
    snapshot: u64,
) -> StoreResult<SessionStatus> {
    b.work.statement()?;
    b.row()?;
    type Row = (String, String, i64, i64, Option<i64>);
    let (text,state,sequence,begin,end):Row=c.query_row("SELECT spec_json,state,last_sequence,begin_commit,end_commit FROM sessions WHERE session_id=?1",[&receipt.spec.session_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?.ok_or(StoreError::CorruptData)?;
    b.bounded_text(&text, MAX_DOCUMENT_BYTES)?;
    let spec: SessionSpec = serde_json::from_str(&text).map_err(|_| StoreError::CorruptData)?;
    if spec != receipt.spec
        || text != serde_json::to_string(&spec)?
        || begin <= 0
        || begin as u64 != receipt.commit_version
        || !(0..=MAX_SAFE as i64).contains(&sequence)
        || (state == "active") != end.is_none()
        || end.is_some_and(|n| n <= begin || n as u64 > snapshot)
    {
        return Err(StoreError::CorruptData);
    }
    let state = match state.as_str() {
        "active" => SessionState::Active,
        "closed" => SessionState::Closed,
        "interrupted" => SessionState::Interrupted,
        _ => return Err(StoreError::CorruptData),
    };
    b.work.statement()?;
    let mut stmt=c.prepare("SELECT m.series_id,m.segment_id,s.series_id,d.segment_id FROM session_members m LEFT JOIN series s ON s.series_id=m.series_id LEFT JOIN segments d ON d.series_id=m.series_id AND d.segment_id=m.segment_id WHERE m.session_id=?1 ORDER BY m.series_id LIMIT 9")?;
    let mut rows = stmt.query([&spec.session_id])?;
    for d in &spec.members {
        let row = rows.next()?.ok_or(StoreError::CorruptData)?;
        b.row()?;
        if row.get::<_, String>(0)? != d.series_id
            || row.get::<_, String>(1)? != d.segment_id
            || row.get::<_, Option<String>>(2)?.as_deref() != Some(&d.series_id)
            || row.get::<_, Option<String>>(3)?.as_deref() != Some(&d.segment_id)
        {
            return Err(StoreError::CorruptData);
        }
    }
    if rows.next()?.is_some() {
        b.row()?;
        return Err(StoreError::CorruptData);
    }
    drop(rows);
    drop(stmt);
    // Validate the latest immutable tick receipt, never scan sample history.
    b.work.statement()?;
    let latest:Option<(i64,i64,String)>=c.query_row("SELECT sequence,commit_version,payload_json FROM commits WHERE session_id=?1 ORDER BY sequence DESC LIMIT 1",[&spec.session_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    match latest {
        None if sequence == 0 => {}
        Some((n, commit, payload)) => {
            b.row()?;
            b.bounded_text(&payload, MAX_DOCUMENT_BYTES)?;
            let value: serde_json::Value =
                serde_json::from_str(&payload).map_err(|_| StoreError::CorruptData)?;
            if n != sequence
                || n <= 0
                || commit <= begin
                || commit as u64 > snapshot
                || end.is_some_and(|e| commit >= e)
                || value["sessionId"] != spec.session_id
                || value["sequence"].as_i64() != Some(sequence)
                || value["observations"]
                    .as_array()
                    .is_none_or(|o| o.len() != spec.members.len())
            {
                return Err(StoreError::CorruptData);
            }
        }
        _ => return Err(StoreError::CorruptData),
    }
    Ok(SessionStatus {
        spec,
        state,
        committed_through: sequence as u64,
        begin_commit_version: begin as u64,
        end_commit_version: end.map(|n| n as u64),
    })
}
fn evidence(
    c: &Connection,
    b: &mut Budget,
    receipt: &RecordingActivationReceipt,
    session: &SessionStatus,
) -> StoreResult<()> {
    b.work.statement()?;
    b.row()?;
    type Row = (String, i64, String, i64, i64, Option<i64>, i64);
    let (plan,revision,epoch,start,frontier,end,epoch_count):Row=c.query_row("SELECT plan_id,plan_revision,clock_epoch,start_ms,observed_frontier_ms,end_ms,(SELECT count(*) FROM session_evidence WHERE clock_epoch=?2) FROM session_evidence WHERE session_id=?1",params![receipt.spec.session_id,receipt.start.clock_epoch],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).optional()?.ok_or(StoreError::CorruptData)?;
    if plan != receipt.plan.plan_id
        || revision <= 0
        || revision as u64 != receipt.plan.revision
        || epoch != receipt.start.clock_epoch
        || start != receipt.start.at_ms
        || frontier < start
        || frontier > MAX_SAFE as i64
        || epoch_count != 1
        || (session.state == SessionState::Closed
            && !end.is_some_and(|e| e > start && e == frontier))
        || (session.state != SessionState::Closed && end.is_some())
    {
        return Err(StoreError::CorruptData);
    }
    b.work.statement()?;
    b.row()?;
    type PlanRow = (
        String,
        i64,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<i64>,
    );
    let (members,created,first,session_begin,first_plan,first_revision):PlanRow=c.query_row("SELECT p.members_json,p.created_commit,a.commit_version,s.begin_commit,e.plan_id,e.plan_revision FROM recording_plans p LEFT JOIN recording_activations a ON a.applied_revision=?2 AND a.commit_version=(SELECT min(commit_version) FROM recording_activations WHERE applied_revision=?2) LEFT JOIN sessions s ON s.session_id=a.session_id LEFT JOIN session_evidence e ON e.session_id=a.session_id WHERE p.plan_id=?1 AND p.revision=?2",params![receipt.plan.plan_id,receipt.plan.revision as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional()?.ok_or(StoreError::CorruptData)?;
    b.bounded_text(&members, MAX_DOCUMENT_BYTES)?;
    let parsed: Vec<IdentityDescriptor> =
        serde_json::from_str(&members).map_err(|_| StoreError::CorruptData)?;
    if parsed != receipt.spec.members
        || created <= 0
        || created as u64 > receipt.commit_version
        || first != Some(created)
        || session_begin != Some(created)
        || first_plan.as_deref() != Some(&receipt.plan.plan_id)
        || first_revision != Some(receipt.plan.revision as i64)
    {
        return Err(StoreError::CorruptData);
    }
    Ok(())
}
