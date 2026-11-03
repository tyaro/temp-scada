use super::*;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
pub(super) fn encode<T: Serialize + ?Sized>(value: &T) -> StoreResult<String> {
    query::control::serialized_size(value, MAX_DOCUMENT_BYTES)?;
    let mut value = serde_json::to_value(value)?;
    document_budget(&value, 1, &mut 0)?;
    normalize(&mut value)?;
    Ok(serde_json::to_string(&value)?)
}
// Typed management envelopes are shallow; still bound corrupt saved Value fields explicitly.
fn document_budget(value: &Value, depth: usize, nodes: &mut usize) -> StoreResult<()> {
    *nodes += 1;
    if depth > 32 || *nodes > 8192 {
        return invalid("recording ledger document limit");
    }
    match value {
        Value::Array(rows) => {
            for child in rows {
                document_budget(child, depth + 1, nodes)?;
            }
        }
        Value::Object(rows) => {
            for child in rows.values() {
                document_budget(child, depth + 1, nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn normalize(value: &mut Value) -> StoreResult<()> {
    match value {
        Value::Number(n) => {
            if n.is_i64() || n.is_u64() {
                return Ok(());
            }
            let f = n.as_f64().ok_or(StoreError::CorruptData)?;
            if !f.is_finite() || f.fract() != 0.0 || f.abs() > MAX_SAFE as f64 {
                return invalid("invalid ledger integer");
            }
            *n = serde_json::Number::from(f as i64);
        }
        Value::Array(rows) => {
            for row in rows {
                normalize(row)?;
            }
        }
        Value::Object(rows) => {
            for child in rows.values_mut() {
                normalize(child)?;
            }
            if let Some(Value::Array(members)) = rows.get_mut("members") {
                members.sort_by(|a, b| a["memberId"].as_str().cmp(&b["memberId"].as_str()));
            }
        }
        _ => {}
    }
    Ok(())
}
pub(super) fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
pub(super) fn valid_revision(value: Option<u64>) -> bool {
    value.is_none_or(|n| (1..=MAX_SAFE).contains(&n))
}
pub(super) fn validate_mapping(request: &RegisterMappingRequest) -> StoreResult<()> {
    if !id(&request.request_id) || !valid_revision(request.expected_mapping_revision) {
        return invalid("invalid recording mapping request");
    }
    let m = &request.mapping;
    if !id(&m.hub_ref) || !id(&m.hub_instance_id) || !(1..=8).contains(&m.members.len()) {
        return invalid("invalid recording mapping");
    }
    query::control::serialized_size(request, MAX_DOCUMENT_BYTES)?;
    let mut ids = std::collections::HashSet::new();
    let mut names = std::collections::HashSet::new();
    for entry in &m.members {
        if !id(&entry.member_id)
            || !ids.insert(&entry.member_id)
            || !names.insert(&entry.identity.external_name)
            || entry.identity.hub_instance_id != m.hub_instance_id
            || !(100..=3_600_000).contains(&entry.identity.period_ms)
        {
            return invalid("invalid recording mapping member");
        }
    }
    SessionSpec {
        session_id: "mapping-validation".into(),
        members: m.members.iter().map(|m| m.identity.clone()).collect(),
    }
    .validate()
}
pub(super) fn validate_apply(request: &ApplyRecordingPlanRequest) -> StoreResult<()> {
    if !id(&request.request_id)
        || ![
            request.expected_applied_revision,
            request.expected_mapping_revision,
            request.expected_retention_applied_revision,
        ]
        .into_iter()
        .all(valid_revision)
    {
        return invalid("invalid recording plan request");
    }
    scada_model::recording_plan::validate_recording_plan(&request.desired)
        .map_err(|_| StoreError::Invalid("invalid desired recording plan"))?;
    let enabled = request.desired["enabled"]
        .as_bool()
        .ok_or(StoreError::CorruptData)?;
    if enabled
        != (request.expected_mapping_revision.is_some()
            && request.expected_retention_applied_revision.is_some())
        || (!enabled
            && (request.expected_mapping_revision.is_some()
                || request.expected_retention_applied_revision.is_some()))
    {
        return invalid("recording mapping and retention expectations required only when enabled");
    }
    query::control::serialized_size(request, MAX_DOCUMENT_BYTES)?;
    Ok(())
}
pub(super) fn resolution(
    request: &ApplyRecordingPlanRequest,
    mapping: Option<RecordingMapping>,
) -> StoreResult<Option<RecordingMapping>> {
    if request.desired["enabled"] == false {
        return Ok(None);
    }
    let mapping = mapping.ok_or(StoreError::Conflict)?;
    let group = &request.desired["group"];
    let members = group["members"].as_array().ok_or(StoreError::CorruptData)?;
    if group["hubRef"] != mapping.hub_ref || members.len() != mapping.members.len() {
        return Err(StoreError::Conflict);
    }
    for member in members {
        let Some(found) = mapping
            .members
            .iter()
            .find(|row| member["memberId"] == row.member_id)
        else {
            return Err(StoreError::Conflict);
        };
        if member["externalName"] != found.identity.external_name
            || member["valueType"] != serde_json::to_value(found.identity.value_type)?
            || group["periodMs"].as_f64() != Some(found.identity.period_ms as f64)
        {
            return Err(StoreError::Conflict);
        }
    }
    Ok(Some(mapping))
}
