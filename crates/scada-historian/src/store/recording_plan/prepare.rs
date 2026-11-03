//! Shared read-only decisions for writer transactions and advisory snapshots.
use super::*;

pub(super) enum Prepared<R, C> {
    Replay(R),
    Candidate(C),
}
pub(super) struct MappingCandidate {
    pub heads: read::Heads,
    pub active_session_id: Option<String>,
}
pub(super) struct PlanCandidate {
    pub heads: read::Heads,
    pub resolution: Option<RecordingMapping>,
    pub new_definition: bool,
    pub active_session_id: Option<String>,
}
fn activity(
    c: &Connection,
    b: &mut Budget,
    allow_recording: bool,
) -> StoreResult<recovery::StoreRecoveryState> {
    let state = recovery::read_snapshot(c, b, &mut || Ok(()))?;
    if state.active_job.is_some() || (!allow_recording && state.active_session_id.is_some()) {
        return Err(StoreError::Busy);
    }
    Ok(state)
}
pub(super) fn register(
    c: &Connection,
    b: &mut Budget,
    normalized: &RegisterMappingRequest,
    payload: &str,
    allow_recording: bool,
) -> StoreResult<Prepared<MappingReceipt, MappingCandidate>> {
    b.bounded_text(payload, MAX_DOCUMENT_BYTES)?;
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
        return Ok(Prepared::Replay(saved.receipt));
    }
    let heads = read::heads(c, b)?;
    if heads.mapping != normalized.expected_mapping_revision {
        return Err(StoreError::Conflict);
    }
    if let Some(rev) = heads.mapping {
        read::mapping(c, b, rev, heads.snapshot)?;
    }
    let active_session_id = activity(c, b, allow_recording)?.active_session_id;
    if heads.mapping.unwrap_or(0) >= MAX_LEDGER_ENTRIES {
        return Err(StoreError::RecordingPlanCapacity);
    }
    reservations::check(c, b, &normalized.mapping, None)?;
    Ok(Prepared::Candidate(MappingCandidate {
        heads,
        active_session_id,
    }))
}
pub(super) fn apply(
    c: &Connection,
    b: &mut Budget,
    request: &ApplyRecordingPlanRequest,
    payload: &str,
    allow_recording: bool,
) -> StoreResult<Prepared<RecordingPlanReceipt, PlanCandidate>> {
    b.bounded_text(payload, MAX_DOCUMENT_BYTES)?;
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
        return Ok(Prepared::Replay(saved.receipt));
    }
    let h = read::heads(c, b)?;
    if h.applied != request.expected_applied_revision {
        return Err(StoreError::Conflict);
    }
    let mut evidence_cache = reservations::EvidenceCache::default();
    if let Some(revision) = h.applied {
        read::application_with_cache(
            c,
            b,
            revision,
            h.snapshot,
            h.ledger.as_deref().ok_or(StoreError::CorruptData)?,
            &mut evidence_cache,
        )?;
    }
    let recovery = activity(c, b, allow_recording)?;
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
        reservations::check_with_cache(c, b, mapping, None, &mut evidence_cache)?;
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
    Ok(Prepared::Candidate(PlanCandidate {
        heads: h,
        resolution,
        new_definition: previous.is_none(),
        active_session_id: recovery.active_session_id,
    }))
}
