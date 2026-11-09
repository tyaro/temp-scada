//! The recording DB, its idle Supervisor and the History host of the desktop
//! host (product-owner design §3, C5-1).
//!
//! At start the host opens (or, on the first start, creates) the store in the
//! app data dir's `historian/`, takes one `HistoryReader` for the History host
//! and hands the store to `RecordingSupervisor::try_new`, which takes the
//! other reader for its preflight. The Supervisor stays `Idle`: recording is
//! started only by an explicit operation (C5-2, C5-4). A store that cannot be
//! opened leaves the runtime `unavailable(reason)`; the app keeps running.
use crate::durable;
use scada_historian::store::query::{CancellationToken, QueryControl, QueryError};
use scada_historian::store::recording_plan::{RecordingMapping, RecordingPlanState};
use scada_historian::store::{SqliteStore, StoreError, StoreIdentity};
use scada_model::Project;
use scada_runtime::history_host::{HistoryHost, HistoryHostError, HistoryPhase};
use scada_runtime::recording_host::RecordingSupervisor;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::Path;
use std::time::Duration;
use tokio::sync::Mutex;

/// The store identity file in the app data dir (design §3, §8-1).
pub const STORE_IDENTITY_FILE: &str = "historian-store.json";
/// The store directory in the app data dir (`store.sqlite3`, `writer.lock`, WAL).
pub const STORE_DIR: &str = "historian";
/// Held from reading the identity until the store is open, so that two
/// processes starting on a new data dir cannot each save their own identity.
pub const STORE_INIT_LOCK_FILE: &str = "historian-store.lock";

/// Why the runtime is unavailable. Fixed codes only: no path, SQLite message
/// or identity value reaches the UI.
pub const NO_DATA_DIR: &str = "no_data_dir";
pub const IDENTITY_UNREADABLE: &str = "store_identity_unreadable";
pub const IDENTITY_INVALID: &str = "store_identity_invalid";
pub const IDENTITY_MISSING: &str = "store_identity_missing";
pub const IDENTITY_UNSAVED: &str = "store_identity_unsaved";
pub const IDENTITY_MISMATCH: &str = "store_identity_mismatch";
pub const STORE_LOCKED: &str = "store_locked";
pub const INIT_LOCK_FAILED: &str = "store_init_lock_failed";
pub const STORE_UNSUPPORTED: &str = "store_unsupported";
pub const STORE_UNAVAILABLE: &str = "store_unavailable";

/// Each history query's deadline. Time spent waiting for the blocking pool
/// counts against it (History host design).
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);
/// The bounded reads at start (the applied plan).
const START_READ_TIMEOUT: Duration = Duration::from_secs(5);
/// Cancels that arrive before their query: kept so that the query does not run.
const EARLY_CANCELS: usize = 16;

/// `historian-store.json`. `storeId` and `historianNamespace` are drawn at
/// random when the store is created; the file is saved before the store.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoreIdentityFile {
    pub version: u32,
    pub store_id: String,
    pub deployment_id: String,
    pub historian_namespace: String,
}

impl StoreIdentityFile {
    fn generate(deployment_id: &str) -> Self {
        Self {
            version: 1,
            store_id: format!("store:{}", uuid::Uuid::new_v4()),
            deployment_id: deployment_id.to_owned(),
            historian_namespace: format!("historian:{}", uuid::Uuid::new_v4()),
        }
    }

    fn valid(&self) -> bool {
        self.version == 1
            && h1_id(&self.store_id)
            && h1_id(&self.deployment_id)
            && h1_id(&self.historian_namespace)
    }

    fn store_identity(&self) -> StoreIdentity {
        StoreIdentity {
            store_id: self.store_id.clone(),
            deployment_id: self.deployment_id.clone(),
        }
    }
}

/// The H1 ID rule (1..64 ASCII, `[A-Za-z0-9][A-Za-z0-9._:-]*`).
fn h1_id(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}

/// The series the History host can answer for: the applied plan's resolved
/// mapping, read once at start. Operations that change the applied plan
/// (C5-2 and later) replace it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct HistoryCatalog {
    plan_id: String,
    applied_revision: u64,
    series: Vec<(String, String)>,
}

impl HistoryCatalog {
    fn from_state(state: RecordingPlanState) -> Option<Self> {
        let applied = state.applied?;
        // A disabled plan resolves no mapping; its series are those of the
        // registered mapping, which earlier runs recorded.
        let mapping: RecordingMapping = match applied.resolution {
            Some(mapping) => mapping,
            None => state.mapping?.mapping,
        };
        Some(Self {
            plan_id: applied.receipt.desired_plan_id,
            applied_revision: applied.receipt.applied_revision,
            series: mapping
                .members
                .into_iter()
                .map(|m| (m.identity.series_id, m.identity.external_name))
                .collect(),
        })
    }
}

/// Why a history query produced no result. `as_str` is the command's error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HistoryFailure {
    Unavailable,
    Busy,
    Cancelled,
    Deadline,
    TooManyPoints,
    InvalidRequest,
    Failed,
}

impl HistoryFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::Busy => "busy",
            Self::Cancelled => "cancelled",
            Self::Deadline => "deadline",
            Self::TooManyPoints => "tooManyPoints",
            Self::InvalidRequest => "invalidRequest",
            Self::Failed => "failed",
        }
    }

    fn from_query(error: QueryError) -> Self {
        match error {
            QueryError::Cancelled => Self::Cancelled,
            QueryError::Deadline => Self::Deadline,
            QueryError::TooManyPoints => Self::TooManyPoints,
            QueryError::InvalidRequest(_) | QueryError::UnsupportedMode => Self::InvalidRequest,
            _ => Self::Failed,
        }
    }

    fn from_host(error: HistoryHostError) -> Self {
        match error {
            HistoryHostError::Busy => Self::Busy,
            HistoryHostError::Request(error) => Self::from_query(error),
            _ => Self::Failed,
        }
    }
}

/// The cancellation of the one running query, by the caller's call ID.
#[derive(Default)]
struct CancelBook {
    current: Option<(String, CancellationToken)>,
    early: VecDeque<String>,
}

impl CancelBook {
    /// Registers `call` as the running query; `false` if it was cancelled first.
    fn begin(&mut self, call: &str, token: CancellationToken) -> bool {
        if let Some(at) = self.early.iter().position(|id| id == call) {
            self.early.remove(at);
            return false;
        }
        self.current = Some((call.to_owned(), token));
        true
    }

    fn end(&mut self, call: &str) {
        if self.current.as_ref().is_some_and(|(id, _)| id == call) {
            self.current = None;
        }
    }

    fn cancel(&mut self, call: &str) {
        match &self.current {
            Some((id, token)) if id == call => token.cancel(),
            // A repeated cancel of one call is kept once: it stops one query.
            _ if self.early.iter().any(|id| id == call) => {}
            _ => {
                if self.early.len() == EARLY_CANCELS {
                    self.early.pop_front();
                }
                self.early.push_back(call.to_owned());
            }
        }
    }
}

struct Ready {
    identity: StoreIdentityFile,
    catalog: std::sync::Mutex<Option<HistoryCatalog>>,
    history: Mutex<HistoryHost>,
    cancels: std::sync::Mutex<CancelBook>,
    // The idle Supervisor that owns the store's writer (C5-2 starts it).
    _supervisor: Mutex<RecordingSupervisor>,
}

/// The recording runtime of the desktop host, kept until the process ends.
pub struct RecordingRuntime {
    state: Result<Ready, &'static str>,
}

impl RecordingRuntime {
    /// A runtime with no store, answering every call with `reason`.
    pub fn unavailable(reason: &'static str) -> Self {
        Self { state: Err(reason) }
    }

    /// Opens the store under `data_dir`, creating it (and its identity file)
    /// on the first start. `deployment_id` is recorded only at creation.
    pub fn start(data_dir: &Path, deployment_id: &str) -> Self {
        Self {
            state: open(data_dir, deployment_id),
        }
    }

    /// `None` while ready; the fixed reason code otherwise.
    pub fn unavailable_reason(&self) -> Option<&'static str> {
        self.state.as_ref().err().copied()
    }

    /// The store identity, while ready.
    pub fn identity(&self) -> Option<&StoreIdentityFile> {
        self.state.as_ref().ok().map(|ready| &ready.identity)
    }

    /// The HistoryContext v2 for `project` (design §7.1), or `None` when the
    /// store has no applied plan or the Project's recording plan is another
    /// one: the UI then gets no History service and shows it as offline.
    pub fn history_context(&self, project: &Project) -> Result<Option<Value>, &'static str> {
        let ready = self.state.as_ref().map_err(|reason| *reason)?;
        let catalog = ready.catalog.lock().unwrap_or_else(|e| e.into_inner());
        let Some(catalog) = catalog.as_ref() else {
            return Ok(None);
        };
        if project.recording_plan_id() != Some(catalog.plan_id.as_str()) {
            return Ok(None);
        }
        Ok(Some(json!({
            "version": 2,
            "kind": "historyContext",
            "contextId": format!("applied:{}", catalog.applied_revision),
            "historianNamespace": ready.identity.historian_namespace,
            "projectId": project.id(),
            "projectRevision": project.revision(),
            "series": catalog.series.iter().map(|(series_id, label)| json!({
                "seriesId": series_id,
                "label": label,
            })).collect::<Vec<_>>(),
        })))
    }

    /// Runs one H1 history query (`start_query` → `join_query`) and returns
    /// its result document. `call` is the caller's ID for `history_cancel`.
    /// Queries run one at a time; a later one waits for the earlier one.
    pub async fn history_query(&self, call: &str, query: Value) -> Result<Value, HistoryFailure> {
        let ready = self
            .state
            .as_ref()
            .map_err(|_| HistoryFailure::Unavailable)?;
        let control =
            QueryControl::with_timeout(QUERY_TIMEOUT).map_err(|_| HistoryFailure::Failed)?;
        let mut host = ready.history.lock().await;
        // A query whose caller went away before joining still holds the one
        // request slot: cancel it and collect its reader first.
        let state = host.state();
        if let (HistoryPhase::InFlight, Some(stale)) = (state.phase, state.request) {
            let _ = host.cancel_query(&stale);
            let _ = host.join_query(&stale).await;
        }
        let token = control.cancellation.clone();
        if !lock(&ready.cancels).begin(call, token) {
            return Err(HistoryFailure::Cancelled);
        }
        let result = match host.start_query(query, control) {
            Ok(request) => match host.join_query(&request).await {
                Ok(completion) => completion
                    .result
                    .clone()
                    .map_err(HistoryFailure::from_query),
                Err(error) => Err(HistoryFailure::from_host(error)),
            },
            Err(error) => Err(HistoryFailure::from_host(error)),
        };
        lock(&ready.cancels).end(call);
        result
    }

    /// Asks the query `call` to stop. A request, not proof of cleanup: its
    /// `history_query` settles once the reader is back. A cancel that comes
    /// before its query keeps that query from running.
    pub fn history_cancel(&self, call: &str) {
        if let Ok(ready) = &self.state {
            lock(&ready.cancels).cancel(call);
        }
    }
}

fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn open(data_dir: &Path, deployment_id: &str) -> Result<Ready, &'static str> {
    // A later process waits here, then finds the first one's identity and
    // store, and stops at the store's writer lock (`store_locked`).
    let init =
        durable::open_lock_file(data_dir, STORE_INIT_LOCK_FILE).map_err(|_| INIT_LOCK_FAILED)?;
    init.lock().map_err(|_| INIT_LOCK_FAILED)?;
    let opened = open_locked(data_dir, deployment_id);
    drop(init);
    opened
}

fn open_locked(data_dir: &Path, deployment_id: &str) -> Result<Ready, &'static str> {
    let identity_path = data_dir.join(STORE_IDENTITY_FILE);
    let store_dir = data_dir.join(STORE_DIR);
    let saved = durable::read_optional(&identity_path).map_err(|_| IDENTITY_UNREADABLE)?;
    let store_exists = durable::exists(&store_dir).map_err(|_| STORE_UNAVAILABLE)?;
    let (identity, mut store) = match saved {
        Some(bytes) => {
            let identity: StoreIdentityFile =
                serde_json::from_slice(&bytes).map_err(|_| IDENTITY_INVALID)?;
            if !identity.valid() {
                return Err(IDENTITY_INVALID);
            }
            // The identity is saved before the store, so a start that stopped
            // in between creates the store with the saved identity.
            let store = if store_exists {
                SqliteStore::open_existing(&store_dir, &identity.store_identity())
            } else {
                SqliteStore::create(&store_dir, identity.store_identity())
            }
            .map_err(store_reason)?;
            (identity, store)
        }
        // A store without its identity is never adopted under a new one.
        None if store_exists => return Err(IDENTITY_MISSING),
        None => {
            let identity = StoreIdentityFile::generate(deployment_id);
            if !identity.valid() {
                return Err(IDENTITY_INVALID);
            }
            let body = serde_json::to_vec_pretty(&identity).map_err(|_| IDENTITY_UNSAVED)?;
            durable::replace(&identity_path, &body).map_err(|_| IDENTITY_UNSAVED)?;
            let store =
                SqliteStore::create(&store_dir, identity.store_identity()).map_err(store_reason)?;
            (identity, store)
        }
    };
    let control = QueryControl::with_timeout(START_READ_TIMEOUT).map_err(|_| STORE_UNAVAILABLE)?;
    let catalog =
        HistoryCatalog::from_state(store.recording_plan_state(&control).map_err(store_reason)?);
    // The History host's reader first; the Supervisor takes the other one.
    let reader = store.reader().map_err(store_reason)?;
    let supervisor = RecordingSupervisor::try_new(store).map_err(|e| store_reason(e.error))?;
    Ok(Ready {
        identity,
        catalog: std::sync::Mutex::new(catalog),
        history: Mutex::new(HistoryHost::new(reader)),
        cancels: std::sync::Mutex::default(),
        _supervisor: Mutex::new(supervisor),
    })
}

fn store_reason(error: StoreError) -> &'static str {
    match error {
        StoreError::Busy => STORE_LOCKED,
        StoreError::IdentityMismatch => IDENTITY_MISMATCH,
        StoreError::UnsupportedStore | StoreError::CorruptData => STORE_UNSUPPORTED,
        _ => STORE_UNAVAILABLE,
    }
}

#[cfg(test)]
mod tests;
