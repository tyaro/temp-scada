use super::*;
fn pair(
    c: &Connection,
    b: &mut Budget,
    table: &str,
    d: &IdentityDescriptor,
) -> StoreResult<Option<(String, String)>> {
    b.work.statement()?;
    let row = c
        .query_row(
            &format!("SELECT hub_id,incarnation_id FROM {table} WHERE series_id=?1"),
            [&d.series_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    if let Some((hub, inc)) = &row {
        b.row()?;
        if !id(hub) || !id(inc) {
            return Err(StoreError::CorruptData);
        }
    }
    Ok(row)
}
fn check_pair(
    c: &Connection,
    b: &mut Budget,
    table: &str,
    d: &IdentityDescriptor,
) -> StoreResult<()> {
    if let Some((hub, inc)) = pair(c, b, table, d)? {
        if hub != d.hub_instance_id || inc != d.incarnation_id {
            return Err(StoreError::Conflict);
        }
    }
    b.work.statement()?;
    let other: Option<String> = c
        .query_row(
            &format!("SELECT series_id FROM {table} WHERE hub_id=?1 AND incarnation_id=?2"),
            params![d.hub_instance_id, d.incarnation_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(other) = other {
        b.row()?;
        if !id(&other) {
            return Err(StoreError::CorruptData);
        }
        if other != d.series_id {
            return Err(StoreError::Conflict);
        }
    }
    Ok(())
}
fn permanent(c: &Connection, b: &mut Budget, d: &IdentityDescriptor) -> StoreResult<()> {
    check_pair(c, b, "series", d)?;
    b.work.statement()?;
    let text: Option<String> = c
        .query_row(
            "SELECT descriptor_json FROM segments WHERE series_id=?1 AND segment_id=?2",
            params![d.series_id, d.segment_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(text) = text {
        b.row()?;
        b.bounded_text(&text, MAX_DOCUMENT_BYTES)?;
        let old: IdentityDescriptor =
            serde_json::from_str(&text).map_err(|_| StoreError::CorruptData)?;
        SessionSpec {
            session_id: "permanent-validation".into(),
            members: vec![old.clone()],
        }
        .validate()
        .map_err(|_| StoreError::CorruptData)?;
        if old.series_id != d.series_id || old.segment_id != d.segment_id {
            return Err(StoreError::CorruptData);
        }
        let pair = pair(c, b, "series", &old)?.ok_or(StoreError::CorruptData)?;
        if pair != (old.hub_instance_id.clone(), old.incarnation_id.clone()) {
            return Err(StoreError::CorruptData);
        }
        if old != *d {
            return Err(StoreError::Conflict);
        }
    }
    Ok(())
}
pub(super) fn check(
    c: &Connection,
    b: &mut Budget,
    mapping: &RecordingMapping,
    application: Option<u64>,
) -> StoreResult<()> {
    let result = check_inner(c, b, mapping, application);
    if application.is_some() && matches!(result, Err(StoreError::Conflict)) {
        return Err(StoreError::CorruptData);
    }
    result
}
fn first_member(
    c: &Connection,
    b: &mut Budget,
    cache: &mut std::collections::HashMap<u64, AppliedRecordingPlan>,
    first: i64,
    bound: u64,
    d: &IdentityDescriptor,
    segment: bool,
) -> StoreResult<()> {
    if first <= 0 {
        return Err(StoreError::CorruptData);
    }
    let revision = first as u64;
    if let std::collections::hash_map::Entry::Vacant(entry) = cache.entry(revision) {
        entry.insert(read::first_application(c, b, revision, bound)?);
    }
    let proof = cache.get(&revision).ok_or(StoreError::CorruptData)?;
    let mapping = proof.resolution.as_ref().ok_or(StoreError::CorruptData)?;
    let found = mapping.members.iter().any(|m| {
        if segment {
            m.identity == *d
        } else {
            m.identity.series_id == d.series_id
                && m.identity.hub_instance_id == d.hub_instance_id
                && m.identity.incarnation_id == d.incarnation_id
        }
    });
    if !proof.receipt.enabled || proof.receipt.commit_version > bound || !found {
        return Err(StoreError::CorruptData);
    }
    Ok(())
}
fn check_inner(
    c: &Connection,
    b: &mut Budget,
    mapping: &RecordingMapping,
    application: Option<u64>,
) -> StoreResult<()> {
    let snapshot = read::snapshot(c, b)?;
    let bound = if let Some(revision) = application {
        b.work.statement()?;
        b.row()?;
        let commit: i64 = c.query_row(
            "SELECT commit_version FROM recording_plan_applications WHERE applied_revision=?1",
            [revision as i64],
            |r| r.get(0),
        )?;
        if commit <= 0 || commit as u64 > snapshot {
            return Err(StoreError::CorruptData);
        }
        commit as u64
    } else {
        snapshot
    };
    let mut cache = std::collections::HashMap::new();
    if let Some(revision) = application {
        b.work.statement()?;
        b.row()?;
        let n: i64 = c.query_row(
            "SELECT count(*) FROM recording_application_members WHERE applied_revision=?1",
            [revision as i64],
            |r| r.get(0),
        )?;
        if n != mapping.members.len() as i64 {
            return Err(StoreError::CorruptData);
        }
    }
    for member in &mapping.members {
        let d = &member.identity;
        permanent(c, b, d)?;
        check_pair(c, b, "recording_series_reservations", d)?;
        b.work.statement()?;
        let series_first:Option<(i64,Option<i64>)>=c.query_row("SELECT first_revision,(SELECT min(applied_revision) FROM recording_application_members WHERE series_id=?1) FROM recording_series_reservations WHERE series_id=?1",[&d.series_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        if let Some((first, actual)) = series_first {
            b.row()?;
            if first <= 0 || actual != Some(first) {
                return Err(StoreError::CorruptData);
            }
            first_member(c, b, &mut cache, first, bound, d, false)?;
        }
        b.work.statement()?;
        let saved:Option<(String,String,i64,Option<i64>)>=c.query_row("SELECT descriptor_json,descriptor_hash,first_revision,(SELECT min(applied_revision) FROM recording_application_members WHERE series_id=?1 AND segment_id=?2) FROM recording_segment_reservations WHERE series_id=?1 AND segment_id=?2",params![d.series_id,d.segment_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        if let Some((text, hash, first, actual)) = saved {
            b.row()?;
            let old: IdentityDescriptor = read::decode(&text, b)?;
            if hash != canonical::hash(&text)
                || first <= 0
                || actual != Some(first)
                || old.series_id != d.series_id
                || old.segment_id != d.segment_id
                || series_first.is_none()
            {
                return Err(StoreError::CorruptData);
            }
            SessionSpec {
                session_id: "reservation-validation".into(),
                members: vec![old.clone()],
            }
            .validate()
            .map_err(|_| StoreError::CorruptData)?;
            if pair(c, b, "recording_series_reservations", &old)?
                != Some((old.hub_instance_id.clone(), old.incarnation_id.clone()))
            {
                return Err(StoreError::CorruptData);
            }
            first_member(c, b, &mut cache, first, bound, &old, true)?;
            if old != *d {
                return Err(StoreError::Conflict);
            }
        } else if application.is_some() {
            return Err(StoreError::CorruptData);
        }
        if let Some(revision) = application {
            b.work.statement()?;
            b.row()?;
            let exists:bool=c.query_row("SELECT EXISTS(SELECT 1 FROM recording_application_members WHERE applied_revision=?1 AND series_id=?2 AND segment_id=?3)",params![revision as i64,d.series_id,d.segment_id],|r|r.get(0))?;
            if !exists {
                return Err(StoreError::CorruptData);
            }
        }
    }
    Ok(())
}
pub(super) fn reserve(
    c: &Connection,
    b: &mut Budget,
    mapping: &RecordingMapping,
    revision: u64,
) -> StoreResult<()> {
    for member in &mapping.members {
        let d = &member.identity;
        b.work.statement()?;
        c.execute("INSERT INTO recording_series_reservations VALUES(?1,?2,?3,?4) ON CONFLICT(series_id) DO NOTHING",params![d.series_id,d.hub_instance_id,d.incarnation_id,revision as i64])?;
        b.work.statement()?;
        c.execute("INSERT INTO recording_segment_reservations VALUES(?1,?2,?3,?4,?5) ON CONFLICT(series_id,segment_id) DO NOTHING",params![d.series_id,d.segment_id,canonical::encode(d)?,canonical::hash(&canonical::encode(d)?),revision as i64])?;
        b.work.statement()?;
        c.execute(
            "INSERT INTO recording_application_members VALUES(?1,?2,?3)",
            params![revision as i64, d.series_id, d.segment_id],
        )?;
    }
    Ok(())
}
