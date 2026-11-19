//! The operation rows of one equipment as the faceplate shows them
//! (operation stage-3 design §8, §9; O3a): the slots that can be written,
//! the last request of each from the record, and why a write would be
//! refused now. Read-only: nothing is recorded, and neither the transition
//! lock nor the send slot is taken.
//!
//! `blocked` is a dry run of the parts of steps 2 and 5 (§4) that do not
//! depend on a request, by the same functions the write uses
//! ([`admission`], [`write_client`]), plus the record and the send slot. A
//! request can still be refused for its own reasons (steps 1, 3, 4).
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{admission, reason, write_client, AppliedProject, HubAccess, OperationEnv};
use super::{MAX_ID_CHARS, PHASE_UNKNOWN};
use crate::auth_phase::AuthHost;
use crate::operation_db::{OperationLog, Outcome, RecordState, StoredRow};

/// The `operation_view` request: the equipment the faceplate shows. The
/// Project is the host's applied one, never the webview's.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationViewRequest {
    pub equipment_id: String,
}

/// What one view reads. `log` is `None` when the record could not be opened
/// (`record_failed`); `hub` is built as for the write.
pub struct ViewContext<'a> {
    pub env: Arc<dyn OperationEnv>,
    pub auth: Option<Arc<AuthHost>>,
    pub log: Option<Arc<OperationLog>>,
    pub project: Option<AppliedProject<'a>>,
    pub hub: HubAccess<'a>,
}

/// The answer of `operation_view`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationView {
    /// The applied Project; `None` when there is none.
    pub project_id: Option<String>,
    pub project_digest: Option<String>,
    /// The §4 code a write would be refused with now, before its own checks.
    pub blocked: Option<&'static str>,
    /// The phase word a record would carry (`unknown` without the auth DB).
    pub phase: String,
    pub slots: Vec<SlotView>,
}

/// One slot with `write`, in the equipment type's slot order.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotView {
    pub slot: String,
    /// The slot's last request (§8); `None` when there is none or the record
    /// could not be read.
    pub latest: Option<LatestRow>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LatestState {
    Finished,
    /// Sent by this process now (§9).
    Sending,
    /// The send ended but its outcome is not in the record (§8).
    Unrecorded,
}

/// The last request of a slot. `outcome`, `reason`, `finished_at_ms` and
/// `audit_id` come from the finish: absent while `sending`, and for an
/// `unrecorded` row whose outcome this process no longer has. `value` is
/// the resolved value (the record's `value.value`), as in the write's answer.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestRow {
    pub id: String,
    pub state: LatestState,
    pub outcome: Option<Outcome>,
    pub reason: Option<String>,
    pub requested_at_ms: i64,
    pub finished_at_ms: Option<i64>,
    pub tag: Option<String>,
    pub value: Option<Value>,
    pub audit_id: Option<i64>,
}

impl LatestRow {
    pub fn new(row: StoredRow, state: RecordState) -> Self {
        let (state, finish) = match state {
            RecordState::Finished(finish) => (LatestState::Finished, Some(finish)),
            RecordState::Sending => (LatestState::Sending, None),
            RecordState::Unrecorded { finish } => (LatestState::Unrecorded, finish),
        };
        Self {
            id: row.id,
            state,
            outcome: finish.as_ref().map(|finish| finish.outcome),
            reason: finish.as_ref().and_then(|finish| finish.reason.clone()),
            requested_at_ms: row.request.requested_at_ms,
            finished_at_ms: finish.as_ref().map(|finish| finish.finished_at_ms),
            tag: row.request.tag,
            value: row.request.value.get("value").cloned(),
            audit_id: finish.and_then(|finish| finish.audit_id),
        }
    }
}

/// Read the operation rows of `request.equipment_id`. `Err` (a §4 code) is
/// a malformed id (`invalid_request`) or an equipment the applied Project
/// does not have (`unknown_equipment`); neither is recorded.
pub async fn operation_view(
    context: &ViewContext<'_>,
    request: &OperationViewRequest,
) -> Result<OperationView, &'static str> {
    let chars = request.equipment_id.chars().count();
    if chars == 0 || chars > MAX_ID_CHARS {
        return Err(reason::INVALID_REQUEST);
    }
    let slots = match &context.project {
        Some(applied) => write_slots(applied, &request.equipment_id)?,
        None => Vec::new(),
    };
    let admission = admission(&*context.env, context.auth.as_deref()).await;
    let phase = admission
        .phase
        .map_or(PHASE_UNKNOWN, |phase| phase.as_str())
        .to_owned();
    // The order of the write: the record (checked by the caller before
    // step 2), step 2, step 3's applied Project, step 5, step 6's slot.
    let mut blocked = match &context.log {
        None => Some(reason::RECORD_FAILED),
        Some(log) => admission
            .result
            .err()
            .or(context.project.is_none().then_some(reason::PROJECT_CHANGED))
            .or_else(|| write_client(&context.hub).err())
            .or(log.is_sending().then_some(reason::BUSY)),
    };
    let mut views = Vec::with_capacity(slots.len());
    let mut unreadable = false;
    for slot in slots {
        let latest = match (&context.log, &context.project) {
            (Some(log), Some(applied)) if !unreadable => {
                match log.latest(applied.id, &request.equipment_id, &slot).await {
                    Ok(found) => found.map(|(row, state)| LatestRow::new(row, state)),
                    Err(error) => {
                        eprintln!("operation view: the record could not be read: {error:?}");
                        unreadable = true;
                        None
                    }
                }
            }
            _ => None,
        };
        views.push(SlotView { slot, latest });
    }
    // A record read only in part is not shown: `latest: null` must mean
    // "no request" or "the record cannot be read" (with `record_failed`),
    // never a mix of the two.
    if unreadable {
        blocked = Some(reason::RECORD_FAILED);
        for view in &mut views {
            view.latest = None;
        }
    }
    Ok(OperationView {
        project_id: context.project.map(|applied| applied.id.to_owned()),
        project_digest: context.project.map(|applied| applied.digest.to_owned()),
        blocked,
        phase,
        slots: views,
    })
}

/// The names of the equipment type's slots with `write` (§3), in order.
fn write_slots(
    applied: &AppliedProject<'_>,
    equipment_id: &str,
) -> Result<Vec<String>, &'static str> {
    let doc = applied.project.as_value();
    let equipment = items(&doc["equipment"])
        .find(|item| item["id"] == equipment_id)
        .ok_or(reason::UNKNOWN_EQUIPMENT)?;
    Ok(items(&doc["equipmentTypes"])
        .find(|kind| kind["id"] == equipment["typeId"])
        .into_iter()
        .flat_map(|kind| items(&kind["slots"]))
        .filter(|slot| slot.get("write").is_some_and(Value::is_object))
        .filter_map(|slot| slot["name"].as_str().map(str::to_owned))
        .collect())
}

fn items(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}
