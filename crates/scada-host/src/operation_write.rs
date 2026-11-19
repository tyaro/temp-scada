//! The operation write `operation_write` on the host (operation stage-3
//! design §4–§6): the checks in the order of §4, the outcome of §5 written to
//! the operation record (`operation_db`), and the permission and phase rules
//! of §6. The Tauri command (O2b-2b) is a thin caller of [`operation_write`].
//!
//! Steps 1–6 run in the caller's future; a caller dropped inside step 6's
//! `begin` frees the send slot there (`OperationLog::begin`). Steps 7–8 (the
//! operator check, the re-check under the transition lock, the send) and
//! the outcome run in a spawned task started right after `begin` returns,
//! so a caller that goes away never leaves the send slot held or the row it
//! started unfinished.
//!
//! Repeated refusals are folded into one row by `OperationLog::refuse`
//! (`repeat_count`, §7, O2c-1).
//!
//! TODO(O2c): the write key's registration and its pairing with the Hub
//! (`hub_mismatch`), the terminal's write state (`write_stopped`,
//! `key_invalid`) and the minimum interval (`too_soon`).
use std::sync::Arc;
use std::time::Duration;

use banto_tagclient::{RequestedValue, RestClient, WriteOptions};
use serde::Serialize;
use serde_json::{json, Value};

use crate::auth::CurrentSession;
use crate::auth_phase::{AuthHost, AuthPhase};
use crate::operation_db::{
    BeginError, Finish, OperationDbError, OperationLog, Outcome, RequestRecord, INTERRUPTED,
};

mod catalog;
mod resolve;
mod view;

#[cfg(test)]
mod flow_tests;
#[cfg(test)]
mod tests;

pub use catalog::{check_catalog, hub_value, MAX_SAFE_INTEGER};
pub use resolve::{
    check_shape, parse_input, resolve, slot_decimals, AppliedProject, Known, OperationWriteRequest,
    Resolved, SlotType, WriteValue, MAX_ID_CHARS, MAX_INPUT_CHARS,
};
pub use view::{
    operation_view, LatestRow, LatestState, OperationView, OperationViewRequest, SlotView,
    ViewContext,
};

/// The refusal codes of §4 (the `reason` of a `refused` row).
pub mod reason {
    pub const INVALID_REQUEST: &str = "invalid_request";
    pub const NOT_RUNTIME: &str = "not_runtime";
    pub const AUTH_UNAVAILABLE: &str = "auth_unavailable";
    pub const PHASE_UNAVAILABLE: &str = "phase_unavailable";
    pub const NOT_AUTHORIZED: &str = "not_authorized";
    pub const PROJECT_CHANGED: &str = "project_changed";
    pub const UNKNOWN_EQUIPMENT: &str = "unknown_equipment";
    pub const UNKNOWN_SLOT: &str = "unknown_slot";
    pub const NO_WRITE_DEF: &str = "no_write_def";
    pub const INVALID_BUTTON: &str = "invalid_button";
    pub const INVALID_VALUE: &str = "invalid_value";
    pub const OUT_OF_RANGE: &str = "out_of_range";
    pub const UNBOUND: &str = "unbound";
    pub const CATALOG_UNAVAILABLE: &str = "catalog_unavailable";
    pub const CATALOG_PENDING: &str = "catalog_pending";
    pub const UNRESOLVED: &str = "unresolved";
    pub const TAG_DISABLED: &str = "tag_disabled";
    pub const NOT_WRITABLE: &str = "not_writable";
    pub const TYPE_MISMATCH: &str = "type_mismatch";
    pub const HUB_UNSUPPORTED: &str = "hub_unsupported";
    pub const NO_WRITE_KEY: &str = "no_write_key";
    pub const BUSY: &str = "busy";
    pub const RECORD_FAILED: &str = "record_failed";
    pub const INVALID_OPERATOR: &str = "invalid_operator";
    pub const AUTH_CHANGED: &str = "auth_changed";
    pub const PHASE_CHANGED: &str = "phase_changed";
}

/// The default bound of a write and of its catalog fetch (§4 "排他と時間",
/// §11-1). The write client is made with
/// `RestClient::with_request_timeout(.., WRITE_TIMEOUT)`.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// The user name of a write in the development / initial-setup phase (§6).
pub const NOT_LOGGED_IN: &str = "未ログイン";

/// The phase word of a record (and of the view) when the auth DB could not
/// be opened.
pub const PHASE_UNKNOWN: &str = "unknown";

/// Upper bound of `on_behalf_of` (§4-7, the Hub's limit).
pub const MAX_OPERATOR_CHARS: usize = 128;

/// What the host supplies besides auth and the record: the clock and the
/// terminal's mode, read at §4-2 and again at §4-8.
pub trait OperationEnv: Send + Sync + 'static {
    fn now_ms(&self) -> i64;
    /// Whether the terminal runs in Runtime mode now (§4-2 `not_runtime`).
    fn is_runtime(&self) -> bool;
}

/// The Hub as this write sees it (§4-4, §4-5, §4.1).
pub struct HubAccess<'a> {
    /// The Hub's identity for the record (`hub_endpoint`).
    pub endpoint: Option<String>,
    /// The read-key client the catalog (§4.1) and the Hub's status
    /// (§11-8) are fetched with; `None` is `catalog_unavailable` for the
    /// write and `hub_unsupported` for the view.
    pub read: Option<&'a RestClient>,
    /// The catalog revision the terminal's subscription resolved against.
    pub subscribed_revision: Option<u64>,
    /// The write-key client; `None` is `no_write_key` (§7).
    pub write: Option<Arc<RestClient>>,
    /// The bound of the catalog and status fetches, the write's own for
    /// the write.
    pub timeout: Duration,
}

/// Everything one `operation_write` uses. `auth` is `None` when the host's
/// auth could not be opened (`auth_unavailable`); `project` is the applied
/// Project, `None` when there is none (`project_changed`).
pub struct OperationWrite<'a> {
    pub env: Arc<dyn OperationEnv>,
    pub auth: Option<Arc<AuthHost>>,
    pub log: Arc<OperationLog>,
    pub project: Option<AppliedProject<'a>>,
    pub hub: HubAccess<'a>,
}

/// The answer to the screen (§5): the outcome, its reason, what the Project
/// resolved to, the Hub's `audit_id` and the record row. `record_id` is
/// `None` for an `invalid_request` (never recorded, §4) and when the row
/// could not be written; `unrecorded` says the outcome is not (yet) in the
/// record, which the screen shows as 「記録に失敗」.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub outcome: Outcome,
    pub reason: Option<String>,
    /// The resolved external name, when resolution got that far.
    pub tag: Option<String>,
    /// The resolved value to write (JSON), when resolution got that far.
    pub value: Option<Value>,
    pub audit_id: Option<i64>,
    pub record_id: Option<String>,
    pub unrecorded: bool,
}

/// Who §4-2 admitted, compared again under the transition lock at §4-8.
#[derive(Clone, Debug, PartialEq)]
struct Admitted {
    phase: AuthPhase,
    session: Option<CurrentSession>,
}

/// Run one operation write (§4): check in order, record, send at most once.
pub async fn operation_write(
    context: &OperationWrite<'_>,
    request: &OperationWriteRequest,
) -> WriteResult {
    // 1. The request's shape: refused without a record.
    if let Err(field) = check_shape(request) {
        eprintln!("operation write: invalid request ({field})");
        return WriteResult {
            outcome: Outcome::Refused,
            reason: Some(reason::INVALID_REQUEST.into()),
            tag: None,
            value: None,
            audit_id: None,
            record_id: None,
            unrecorded: false,
        };
    }
    let mut record = RequestRecord {
        requested_at_ms: context.env.now_ms(),
        user: NOT_LOGGED_IN.into(),
        phase: PHASE_UNKNOWN.into(),
        hub_endpoint: context.hub.endpoint.clone(),
        project_id: request.project_id.clone(),
        project_digest: request.project_digest.clone(),
        screen_id: request.screen_id.clone(),
        object_id: request.object_id.clone(),
        equipment_id: request.equipment_id.clone(),
        equipment_code: None,
        slot: request.slot_name.clone(),
        tag: None,
        value: record_value(request, None),
    };
    // 2. Mode, phase and permission.
    let admitted = match admit(context, &mut record).await {
        Ok(admitted) => admitted,
        Err(code) => return refuse(context, &record, code).await,
    };
    // 3. The applied Project.
    let mut known = Known::default();
    let resolved = match context.project.as_ref() {
        None => Err(reason::PROJECT_CHANGED),
        Some(applied) => resolve(applied, request, &mut known),
    };
    record.equipment_code = known.equipment_code.clone();
    record.tag = known.tag.clone();
    record.value = record_value(request, known.value);
    let resolved = match resolved {
        Ok(resolved) => resolved,
        Err(code) => return refuse(context, &record, code).await,
    };
    // 4. The catalog, fetched now with the read key (§4.1).
    let value = match fetch_and_check(&context.hub, &resolved).await {
        Ok(value) => value,
        Err(code) => return refuse(context, &record, code).await,
    };
    // 5. The Hub's contract and the write key.
    let client = match write_client(&context.hub).await {
        Ok(client) => client,
        Err(code) => return refuse(context, &record, code).await,
    };
    // 6. The `pending` row; `busy` when another write holds the send slot.
    let id = match context.log.begin(&record).await {
        Ok(id) => id,
        Err(BeginError::Busy) => return refuse(context, &record, reason::BUSY).await,
        Err(BeginError::Record(error)) => {
            eprintln!("operation write: the pending row could not be written: {error:?}");
            return WriteResult {
                outcome: Outcome::Refused,
                reason: Some(reason::RECORD_FAILED.into()),
                value: record.value.get("value").cloned(),
                tag: record.tag,
                audit_id: None,
                record_id: None,
                unrecorded: true,
            };
        }
    };
    // 7–8 in a task of their own (see the module doc).
    let send = Sending {
        id: id.clone(),
        user: record.user.clone(),
        admitted,
        tag: resolved.tag.clone(),
        value,
        client,
        env: context.env.clone(),
        auth: context.auth.clone(),
        log: context.log.clone(),
    };
    // Supervised in a task of its own too, so a panic of the send task is
    // finished (and the send slot freed) even when the caller stopped
    // waiting.
    let log = context.log.clone();
    let env = context.env.clone();
    let supervised_id = id.clone();
    let supervised = tokio::spawn(async move {
        match tokio::spawn(send.run()).await {
            Ok(done) => done,
            Err(_) => finish_interrupted(&log, &supervised_id, &*env).await,
        }
    });
    let (finish, unrecorded) = match supervised.await {
        Ok(done) => done,
        // Only when the runtime is shutting down: the row reads as
        // unrecorded and the next start makes it `interrupted`.
        Err(_) => (interrupted(&*context.env), true),
    };
    WriteResult {
        outcome: finish.outcome,
        reason: finish.reason,
        value: record.value.get("value").cloned(),
        tag: record.tag,
        audit_id: finish.audit_id,
        record_id: Some(id),
        unrecorded,
    }
}

/// Step 2 (§4-2, §6). Fills the record's user and phase as far as known.
async fn admit(
    context: &OperationWrite<'_>,
    record: &mut RequestRecord,
) -> Result<Admitted, &'static str> {
    let admission = admission(&*context.env, context.auth.as_deref()).await;
    if let Some(phase) = admission.phase {
        record.phase = phase.as_str().into();
    }
    if let Some(user) = admission.user {
        record.user = user;
    }
    admission.result
}

/// What step 2 found: the phase (`None` when the auth DB could not be
/// opened), the logged-in user when known, and whether the request may go
/// on. Shared by the write and the view (`operation_view`) so their rules
/// cannot drift.
struct Admission {
    phase: Option<AuthPhase>,
    user: Option<String>,
    result: Result<Admitted, &'static str>,
}

/// The rules of step 2 (§4-2, §6), without a request.
async fn admission(env: &dyn OperationEnv, auth: Option<&AuthHost>) -> Admission {
    let refused = |phase, user, code| Admission {
        phase,
        user,
        result: Err(code),
    };
    let Some(auth) = auth else {
        let code = if env.is_runtime() {
            reason::AUTH_UNAVAILABLE
        } else {
            reason::NOT_RUNTIME
        };
        return refused(None, None, code);
    };
    let phase = auth.phase().await;
    if !env.is_runtime() {
        return refused(Some(phase), None, reason::NOT_RUNTIME);
    }
    let Ok(session) = auth.auth().current().await else {
        return refused(Some(phase), None, reason::AUTH_UNAVAILABLE);
    };
    match phase {
        AuthPhase::Bootstrapping | AuthPhase::Transitioning => {
            refused(Some(phase), None, reason::PHASE_UNAVAILABLE)
        }
        // §6: only users with `equipment.operate`, which needs
        // tyaro/banto#697. Until then nobody (no fallback to Admin).
        // TODO(O5): admit `equipment.operate`.
        AuthPhase::Operational => {
            let user = session
                .as_ref()
                .map(|current| current.session.identity().username.clone());
            refused(Some(phase), user, reason::NOT_AUTHORIZED)
        }
        // Development / initial setup: no login (§6).
        AuthPhase::Initializing => Admission {
            phase: Some(phase),
            user: None,
            result: Ok(Admitted { phase, session }),
        },
    }
}

/// Step 5: the Hub's write contract and the write key. Shared by the write
/// and the view. TODO(O2c): `hub_mismatch`, `write_stopped`, `key_invalid`,
/// `too_soon`.
async fn write_client(hub: &HubAccess<'_>) -> Result<Arc<RestClient>, &'static str> {
    if !write_contract_confirmed(hub).await {
        return Err(reason::HUB_UNSUPPORTED);
    }
    hub.write.clone().ok_or(reason::NO_WRITE_KEY)
}

/// Whether the Hub lists the #1201 write contract (`write_contract_v1`) in
/// `GET /api/v1/status` now (§11-8, upstream #1223). Asked on every write
/// and view, like the catalog (§4.1), so a Hub replaced by an older one is
/// not trusted from an earlier answer. A Hub that cannot be asked (no read
/// client, an error, no answer within the bound) is not confirmed: never
/// write to a Hub whose contract is unknown.
async fn write_contract_confirmed(hub: &HubAccess<'_>) -> bool {
    let Some(client) = hub.read else {
        return false;
    };
    matches!(
        tokio::time::timeout(hub.timeout, client.fetch_status()).await,
        Ok(Ok(status)) if status.supports_write_contract()
    )
}

/// Step 4: fetch the catalog within the write's bound and check the tag.
async fn fetch_and_check(
    hub: &HubAccess<'_>,
    resolved: &Resolved,
) -> Result<RequestedValue, &'static str> {
    let client = hub.read.ok_or(reason::CATALOG_UNAVAILABLE)?;
    let catalog = match tokio::time::timeout(hub.timeout, client.fetch_catalog()).await {
        Ok(Ok(catalog)) => catalog,
        _ => return Err(reason::CATALOG_UNAVAILABLE),
    };
    check_catalog(
        &catalog,
        hub.subscribed_revision,
        &resolved.tag,
        resolved.slot_type,
        resolved.value,
        resolved.fractional,
    )
}

/// Record a refusal of steps 2–5 (§4).
async fn refuse(context: &OperationWrite<'_>, record: &RequestRecord, code: &str) -> WriteResult {
    let finished_at_ms = context.env.now_ms();
    let (record_id, unrecorded) = match context.log.refuse(record, code, finished_at_ms).await {
        Ok(id) => (Some(id), false),
        Err(error) => {
            eprintln!("operation write: the refusal could not be written: {error:?}");
            (None, true)
        }
    };
    WriteResult {
        outcome: Outcome::Refused,
        reason: Some(code.into()),
        tag: record.tag.clone(),
        value: record.value.get("value").cloned(),
        audit_id: None,
        record_id,
        unrecorded,
    }
}

/// The record's `value` (§9): the value to write once resolved, with the
/// button's index or the typed text.
fn record_value(request: &OperationWriteRequest, value: Option<WriteValue>) -> Value {
    let mut record = match (request.button_index, &request.input) {
        (Some(index), _) => json!({ "button": index }),
        (None, Some(text)) => json!({ "input": text }),
        (None, None) => json!({}),
    };
    if let Some(value) = value {
        record["value"] = value.to_json();
    }
    record
}

/// Whether `on_behalf_of` can carry the user name (§4-7).
fn valid_operator(user: &str) -> bool {
    let chars = user.chars().count();
    chars > 0 && chars <= MAX_OPERATOR_CHARS && !user.chars().any(char::is_control)
}

/// Steps 7–8 and the outcome of one write whose `pending` row is written.
struct Sending {
    id: String,
    user: String,
    admitted: Admitted,
    tag: String,
    value: RequestedValue,
    client: Arc<RestClient>,
    env: Arc<dyn OperationEnv>,
    auth: Option<Arc<AuthHost>>,
    log: Arc<OperationLog>,
}

impl Sending {
    /// The finish of the row and whether it could not be written.
    async fn run(self) -> (Finish, bool) {
        // 7. The operator claim; the record keeps the name as it is.
        if !valid_operator(&self.user) {
            return self
                .finish(refused(reason::INVALID_OPERATOR, &*self.env))
                .await;
        }
        // 8. Re-check and start the send under the transition lock; release
        // it once the send has started, never waiting for the Hub.
        let started = match self.auth.as_deref() {
            None => Err(reason::AUTH_CHANGED),
            Some(auth) => {
                let gate = auth.gate().await;
                let checked = recheck(gate.phase(), auth, &*self.env, &self.admitted).await;
                let started = checked.map(|()| {
                    let client = self.client.clone();
                    let tag = self.tag.clone();
                    let value = self.value.clone();
                    let options = WriteOptions::default()
                        .with_correlation_id(self.id.clone())
                        .with_on_behalf_of(self.user.clone());
                    tokio::spawn(async move { client.write_tag(&tag, value, options).await })
                });
                drop(gate);
                started
            }
        };
        let finish = match started {
            Err(code) => refused(code, &*self.env),
            Ok(sending) => match sending.await {
                Ok(result) => Finish::of_write(&result, self.env.now_ms()),
                // The send task panicked: whether it reached the Hub is unknown.
                Err(_) => interrupted(&*self.env),
            },
        };
        self.finish(finish).await
    }

    async fn finish(&self, finish: Finish) -> (Finish, bool) {
        match self.log.complete(&self.id, finish.clone()).await {
            Ok(()) => (finish, false),
            Err(error) => {
                eprintln!("operation write: the outcome could not be written: {error:?}");
                (finish, true)
            }
        }
    }
}

fn interrupted(env: &dyn OperationEnv) -> Finish {
    Finish {
        outcome: Outcome::Uncertain,
        reason: Some(INTERRUPTED.into()),
        audit_id: None,
        finished_at_ms: env.now_ms(),
    }
}

/// The send task panicked, before or after the send started: whether the
/// write reached the Hub is unknown, so the row is finished `uncertain`
/// (`interrupted`) and the send slot freed. Never re-sent. When the outcome
/// cannot be written, the log keeps it as unrecorded (`complete`). A row the
/// task had already finished (`InvalidRow`) keeps its recorded outcome.
async fn finish_interrupted(
    log: &OperationLog,
    id: &str,
    env: &dyn OperationEnv,
) -> (Finish, bool) {
    let finish = interrupted(env);
    match log.complete(id, finish.clone()).await {
        Ok(()) | Err(OperationDbError::InvalidRow) => (finish, false),
        Err(error) => {
            eprintln!("operation write: the outcome could not be written: {error:?}");
            (finish, true)
        }
    }
}

fn refused(code: &str, env: &dyn OperationEnv) -> Finish {
    Finish {
        outcome: Outcome::Refused,
        reason: Some(code.into()),
        audit_id: None,
        finished_at_ms: env.now_ms(),
    }
}

/// §4-8: the state under the lock against what step 2 admitted. A phase
/// change is `phase_changed`; another user, session generation or role (or
/// an auth DB that no longer answers) is `auth_changed`. A terminal that
/// left Runtime mode is refused with step 2's `not_runtime`.
async fn recheck(
    phase: AuthPhase,
    auth: &AuthHost,
    env: &dyn OperationEnv,
    admitted: &Admitted,
) -> Result<(), &'static str> {
    if phase != admitted.phase {
        return Err(reason::PHASE_CHANGED);
    }
    if !env.is_runtime() {
        return Err(reason::NOT_RUNTIME);
    }
    match auth.auth().current().await {
        Ok(session) if session == admitted.session => Ok(()),
        _ => Err(reason::AUTH_CHANGED),
    }
}
