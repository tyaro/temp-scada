//! The recording DB, its idle Supervisor and the History host of the desktop
//! host (product-owner design §3, C5-1).
//!
//! At start the host opens (or, on the first start, creates) the store in the
//! app data dir's `historian/`, takes one `HistoryReader` for the History host
//! and hands the store to `RecordingSupervisor::try_new`, which takes the
//! other reader for its preflight. The Supervisor stays `Idle`: recording is
//! started only by an explicit operation (C5-2, C5-4). A store that cannot be
//! opened leaves the runtime `unavailable(reason)`; the app keeps running.
//!
//! C5-2 adds the recording management context and inspection
//! ([`RecordingRuntime::inspect`]) and the first setup and start
//! ([`RecordingRuntime::initial_setup`]).
use crate::durable;
use banto_tagclient::RestClient;
use scada_historian::store::query::{CancellationToken, QueryControl, QueryError};
use scada_historian::store::recording_plan::{RecordingMapping, RecordingPlanState};
use scada_historian::store::{SqliteStore, StoreError, StoreIdentity};
use scada_model::recording_management::{RecordingInspectionRequest, RecordingInspectionResponse};
use scada_model::recording_plan::validate_recording_plan;
use scada_model::Project;
use scada_runtime::history_host::{HistoryHost, HistoryHostError, HistoryPhase};
use scada_runtime::recording_host::RecordingSupervisor;
use scada_runtime::recording_host::{RecordingPhase, ResumeResolution};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::Mutex;

mod inspection;
mod owner;
mod resume;
mod sdk;
mod setup;
pub use owner::{ExitOutcome, StopFailure};
pub use resume::Reconfigured;
pub use setup::{
    default_retention_policy, SetupFailure, DEFAULT_RETENTION_MS, DEFAULT_RETENTION_POLICY_ID,
    MAX_CLOCK_SKEW_MS,
};

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
/// How long the first setup waits for an accepted recording to run.
const START_WAIT: Duration = Duration::from_secs(10);

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
    /// The app data dir: the owner epoch of each installed root is saved here.
    data_dir: PathBuf,
    identity: StoreIdentityFile,
    /// The management context of this process (contract §4): a new ID per
    /// start, so run display IDs are never reused within one context.
    context_id: String,
    catalog: std::sync::Mutex<Option<HistoryCatalog>>,
    history: Mutex<HistoryHost>,
    cancels: std::sync::Mutex<CancelBook>,
    /// The Supervisor that owns the store's writer. `None` while it is lent
    /// to an installed root's owner (`lent`), or after a setup step lost the
    /// store (it is then unavailable until restart).
    supervisor: Mutex<Option<RecordingSupervisor>>,
    /// The recording status of the Supervisor lent to an installed root.
    lent: std::sync::Mutex<Option<StatusWatch>>,
    runs: std::sync::Mutex<inspection::RunRefs>,
}

type StatusWatch = tokio::sync::watch::Receiver<
    std::sync::Arc<scada_runtime::recording_host::RecordingHostStatus>,
>;

/// Why an inspection produced no response. `as_str` is the command's error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InspectFailure {
    Unavailable,
    InvalidRequest,
    /// The request's context is not this host's current context.
    ContextMismatch,
    Failed,
}

impl InspectFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::InvalidRequest => "invalidRequest",
            Self::ContextMismatch => "contextMismatch",
            Self::Failed => "failed",
        }
    }
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

impl RecordingRuntime {
    /// The RecordingManagementContext v1 for `project` (contract §4): this
    /// process's context ID, the store identity and the history namespace.
    pub fn management_context(&self, project: &Project) -> Result<Value, &'static str> {
        let ready = self.state.as_ref().map_err(|reason| *reason)?;
        Ok(json!({
            "version": 1,
            "kind": "recordingManagementContext",
            "contextId": ready.context_id,
            "projectId": project.id(),
            "projectRevision": project.revision(),
            "deploymentId": ready.identity.deployment_id,
            "storeId": ready.identity.store_id,
            "historianNamespace": ready.identity.historian_namespace,
        }))
    }

    /// One recording inspection (contract §5, §6): the DB view from one
    /// resume inspection of the Supervisor, and the Supervisor's status as
    /// the Host view. A DB read failure is a DB view `unavailable`, not an
    /// error. Waits while a setup step holds the Supervisor.
    pub async fn inspect(&self, request: Value) -> Result<Value, InspectFailure> {
        let ready = self
            .state
            .as_ref()
            .map_err(|_| InspectFailure::Unavailable)?;
        let request = RecordingInspectionRequest::from_value(request)
            .map_err(|_| InspectFailure::InvalidRequest)?;
        let context = &request.as_value()["context"];
        if context["contextId"] != ready.context_id.as_str()
            || context["deploymentId"] != ready.identity.deployment_id.as_str()
            || context["storeId"] != ready.identity.store_id.as_str()
            || context["historianNamespace"] != ready.identity.historian_namespace.as_str()
        {
            return Err(InspectFailure::ContextMismatch);
        }
        let mut slot = ready.supervisor.lock().await;
        let lent = lock(&ready.lent).clone();
        let (database, host) = match (slot.as_mut(), lent) {
            // Lent to an installed root's owner: the DB through the History
            // host's reader, the Host view from the recording status alone.
            (None, Some(watch)) => {
                let database = lent_database(ready).await;
                let status = watch.borrow().clone();
                let host = inspection::lent_host(&status, &mut lock(&ready.runs), setup::now_ms());
                (database, host)
            }
            (None, None) => (
                json!({"state": "unavailable", "error": "unavailable"}),
                json!({"state": "unknown"}),
            ),
            (Some(supervisor), _) => {
                let database = match supervisor.start_resume_inspection(setup::control()) {
                    Ok(run) => match supervisor.join_resume_inspection(&run).await {
                        Ok(completion) => match &completion.outcome {
                            Ok(state) => inspection::database(state),
                            Err(error) => json!({"state": "unavailable",
                                "error": inspection::store_error(error)}),
                        },
                        Err(_) => json!({"state": "unavailable", "error": "readerUnusable"}),
                    },
                    Err(_) => json!({"state": "unavailable", "error": "busy"}),
                };
                let host = inspection::host(supervisor, &mut lock(&ready.runs), setup::now_ms());
                (database, host)
            }
        };
        drop(slot);
        let response = |database: Value| {
            RecordingInspectionResponse::from_value(json!({
                "version": 1,
                "kind": "recordingInspectionResponse",
                "request": request.as_value(),
                "database": database,
                "host": host,
                "sdk": {"state": "unknown"},
            }))
        };
        match response(database) {
            Ok(response) => Ok(response.as_value().clone()),
            // A native view the contract refuses is not shown in part.
            Err(_) => response(json!({"state": "unavailable", "error": "projectionFailed"}))
                .map(|response| response.as_value().clone())
                .map_err(|_| InspectFailure::Failed),
        }
    }

    /// The first setup and start (design §5 `recording_initial_setup`):
    /// registers a mapping of the Project's recording plan with identities
    /// this host draws, applies the default retention policy and the plan,
    /// then starts recording through the explicit resume of the applied
    /// plan. `resolve` reads the Hub once for the mapping; `record` is the
    /// recording's own client. Returns the recording phase it reached
    /// (`running`, or `starting` if it did not run within the wait).
    pub async fn initial_setup(
        &self,
        project: &Project,
        resolve: RestClient,
        record: RestClient,
    ) -> Result<&'static str, SetupFailure> {
        let ready = self.state.as_ref().map_err(|_| SetupFailure::Unavailable)?;
        let desired = project
            .recording_plan()
            .ok_or(SetupFailure::NoRecordingPlan)?;
        validate_recording_plan(desired).map_err(|_| SetupFailure::InvalidPlan)?;
        if desired["enabled"] != true {
            return Err(SetupFailure::PlanDisabled);
        }
        let desired = desired.clone();
        let mut slot = ready.supervisor.lock().await;
        let Some(supervisor) = slot.as_mut() else {
            // Lent to an installed root: a recording runs.
            return Err(match lock(&ready.lent).is_some() {
                true => SetupFailure::NotAllowed,
                false => SetupFailure::Unavailable,
            });
        };
        if !matches!(
            supervisor.state().recording.phase,
            RecordingPhase::Idle | RecordingPhase::Joined
        ) {
            return Err(SetupFailure::NotAllowed);
        }
        // Decide and resolve before taking the writer: a refusal or a Hub
        // failure leaves the Supervisor as it was.
        let state = resume_state(supervisor).await?;
        let found = setup::find(
            &state.plan,
            state
                .recovery
                .applied_retention_policy
                .as_ref()
                .map(|p| p.applied_revision),
            state.latest_activation.is_some(),
            state.recovery.active_session_id.is_some() || state.recovery.active_job.is_some(),
            &desired,
        )?;
        let (mut mapping, new_mapping) = match &found.mapping {
            Some(mapping) => (mapping.clone(), false),
            None => (setup::draft(&desired)?, true),
        };
        let snapshot = setup::resolve(resolve, &mapping).await?;
        if new_mapping {
            setup::complete(&mut mapping, &snapshot, &[])?;
        }
        setup::check(&mapping, &snapshot)?;
        let store = supervisor.take_store().map_err(|_| SetupFailure::Busy)?;
        *slot = None;
        let Some((store, saved)) = blocking(store, move |store| {
            setup::save(store, &found, &mapping, new_mapping, &desired)?;
            // The History host's series follow the applied plan.
            Ok(store
                .recording_plan_state(&setup::control())
                .ok()
                .and_then(HistoryCatalog::from_state))
        })
        .await
        else {
            return Err(SetupFailure::StoreFailed);
        };
        let mut supervisor =
            RecordingSupervisor::try_new(store).map_err(|_| SetupFailure::StoreFailed)?;
        let result = match saved {
            Ok(catalog) => {
                if let Some(catalog) = catalog {
                    *lock(&ready.catalog) = Some(catalog);
                }
                start(&mut supervisor, snapshot, record).await
            }
            Err(failure) => Err(failure),
        };
        *slot = Some(supervisor);
        result
    }
}

/// The DB view of one resume inspection read with the History host's
/// reader, while the Supervisor is lent to an installed root (its own reader
/// is the owner's). Waits for a running history query.
async fn lent_database(ready: &Ready) -> Value {
    let unavailable = |error: &str| json!({"state": "unavailable", "error": error});
    // A running `history_query` holds this lock until it joins, so it is
    // waited for, not cancelled. A query left in flight by a caller that
    // went away is joined (it ends by its own deadline), never cancelled
    // here: an inspection never cuts a history read short.
    let mut host = ready.history.lock().await;
    let state = host.state();
    if let (HistoryPhase::InFlight, Some(stale)) = (state.phase, state.request) {
        let _ = host.join_query(&stale).await;
    }
    let Ok(mut reader) = host.take_reader() else {
        return unavailable("readerUnusable");
    };
    let Ok(control) = QueryControl::with_timeout(START_READ_TIMEOUT) else {
        *host = HistoryHost::new(reader);
        return unavailable("internal");
    };
    match tokio::task::spawn_blocking(move || {
        let outcome = reader.recording_resume_state(&control);
        (reader, outcome)
    })
    .await
    {
        Ok((reader, outcome)) => {
            *host = HistoryHost::new(reader);
            match outcome {
                Ok(state) => inspection::database(&state),
                Err(error) => unavailable(inspection::store_error(&error)),
            }
        }
        // The reader was lost with the task: history reads stay unavailable.
        Err(_) => unavailable("readerUnusable"),
    }
}

/// One resume inspection of the Supervisor's own reader.
async fn resume_state(
    supervisor: &mut RecordingSupervisor,
) -> Result<scada_historian::store::recording_plan::RecordingResumeState, SetupFailure> {
    let run = supervisor
        .start_resume_inspection(setup::control())
        .map_err(|_| SetupFailure::Busy)?;
    let completion = supervisor
        .join_resume_inspection(&run)
        .await
        .map_err(|_| SetupFailure::StoreFailed)?;
    completion
        .outcome
        .as_ref()
        .map(Clone::clone)
        .map_err(|_| SetupFailure::StoreFailed)
}

/// Runs `f` on the blocking pool with the store; `None` if it was lost.
async fn blocking<T: Send + 'static>(
    mut store: SqliteStore,
    f: impl FnOnce(&mut SqliteStore) -> T + Send + 'static,
) -> Option<(SqliteStore, T)> {
    tokio::task::spawn_blocking(move || {
        let result = f(&mut store);
        (store, result)
    })
    .await
    .ok()
}

/// Starts the applied plan from `snapshot` through the explicit resume, with
/// new activation, session and clock-epoch IDs, and waits until it runs.
async fn start(
    supervisor: &mut RecordingSupervisor,
    snapshot: std::sync::Arc<banto_tagclient::GenerationSnapshot>,
    client: RestClient,
) -> Result<&'static str, SetupFailure> {
    use scada_runtime::recording_host::SupervisorError;
    let run = supervisor
        .start_resume_inspection(setup::control())
        .map_err(|_| SetupFailure::Busy)?;
    supervisor
        .join_resume_inspection(&run)
        .await
        .map_err(|_| SetupFailure::StoreFailed)?;
    let ticket = supervisor
        .prepare_resume(
            &run,
            ResumeResolution {
                sdk_snapshot: snapshot,
                session_id: format!("session:{}", uuid::Uuid::new_v4()),
                clock_epoch: format!("clock:{}", uuid::Uuid::new_v4()),
                activation_id: format!("activation:{}", uuid::Uuid::new_v4()),
                slot_count: None,
                max_clock_skew_ms: MAX_CLOCK_SKEW_MS,
            },
        )
        .map_err(|error| match error {
            SupervisorError::Resolution(_) => SetupFailure::ResolutionMismatch,
            SupervisorError::ResumeBlocked(_) => SetupFailure::NotAllowed,
            _ => SetupFailure::StartFailed,
        })?;
    let mut status = supervisor.recording_watch();
    let recording = supervisor
        .resume(&ticket, setup::control(), client)
        .map_err(|_| SetupFailure::StartFailed)?;
    let settled = tokio::time::timeout(START_WAIT, async {
        loop {
            let phase = status.borrow_and_update().phase;
            if phase != RecordingPhase::Starting {
                return phase;
            }
            if status.changed().await.is_err() {
                return RecordingPhase::Faulted;
            }
        }
    })
    .await;
    match settled {
        Err(_) => Ok("starting"),
        Ok(RecordingPhase::Running) => Ok("running"),
        Ok(_) => {
            // Stopped before running: collect the worker so the writer is back.
            let _ = supervisor.join_recording(&recording).await;
            Err(SetupFailure::StartFailed)
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
        data_dir: data_dir.to_owned(),
        lent: std::sync::Mutex::default(),
        identity,
        catalog: std::sync::Mutex::new(catalog),
        history: Mutex::new(HistoryHost::new(reader)),
        cancels: std::sync::Mutex::default(),
        context_id: format!("host:{}", uuid::Uuid::new_v4()),
        supervisor: Mutex::new(Some(supervisor)),
        runs: std::sync::Mutex::default(),
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
mod setup_tests;
#[cfg(test)]
mod tests;
