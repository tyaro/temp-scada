//! The operation write command (operation stage-3 design §4, §9; O2b-2b).
//! A thin caller of `scada_host::operation_write`, which owns the checks,
//! the record and the send.
//!
//! - The record `operations.db` sits directly under the terminal's data dir
//!   (next to `alarm-terminal.json`, §9). It is opened at startup in Runtime
//!   mode only: the command is Runtime-only and refused by the mode before
//!   any request is taken, so Editor mode has nothing to record.
//! - The Hub's write contract (§11-8) is asked with the read key of the
//!   Hub connection (`GET /api/v1/status`, upstream #1223) on every write
//!   and view. The product still never sends: there is no write key (O2c),
//!   so a request that passes up to §4-4 is `hub_unsupported` on a Hub
//!   before #1201 and `no_write_key` on one with the contract.
//! - A record that could not be opened answers `refused` / `record_failed`
//!   with `unrecorded: true`: nothing can be recorded, so nothing is sent.
//! - `operation_view` (O3a) reads the faceplate's operation rows of one
//!   equipment (§8): the write slots, their last request and why a write
//!   would be refused now. It records nothing and takes neither the
//!   transition lock nor the send slot.
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use scada_host::operation_db::{OperationDb, OperationLog, Outcome};
use scada_host::operation_key::WriteKey;
use scada_host::operation_write::{
    self, check_shape, reason, HubAccess, OperationEnv, OperationView, OperationViewRequest,
    OperationWrite, OperationWriteRequest, ViewContext, WriteResult, MIN_WRITE_INTERVAL,
    WRITE_TIMEOUT,
};
use scada_host::recording_runtime::NO_DATA_DIR;
use tauri::State;

use crate::app_mode::AppMode;
use crate::auth::AuthState;
use crate::runtime::StartupProject;
use crate::NativeHost;

/// The bound of the view's status fetch: shorter than a write's, so a Hub
/// that does not answer delays the faceplate's 2-second poll little.
const VIEW_TIMEOUT: Duration = Duration::from_secs(3);

/// The write key (O2c-3b registers it); none yet, so `no_write_key`
/// behind the contract.
fn write_key() -> Option<WriteKey> {
    None
}

/// The record's file name in the terminal's data dir (§9).
pub const OPERATIONS_DB: &str = "operations.db";

/// Why the record is not open (logged; the screen sees `record_failed`).
const EDITOR_MODE: &str = "editorMode";
const DB_UNAVAILABLE: &str = "operationDbUnavailable";
const CLOSED: &str = "closed";

/// The operation record of this process, or why it is not open.
pub struct OperationState(Mutex<Result<Arc<OperationLog>, &'static str>>);

impl OperationState {
    /// Open `operations.db` under `dir` in Runtime mode. A failure does not
    /// stop the app; the command answers `record_failed`. Rows an earlier
    /// process left `pending` are finished as `uncertain` here (§9).
    pub async fn open(mode: &AppMode, dir: Result<impl AsRef<Path>, impl std::fmt::Debug>) -> Self {
        if !matches!(mode, AppMode::Runtime { .. }) {
            return Self::unavailable(EDITOR_MODE);
        }
        let Ok(dir) = dir else {
            return Self::unavailable(NO_DATA_DIR);
        };
        let file = dir.as_ref().join(OPERATIONS_DB);
        match OperationDb::open(&file, now_ms()).await {
            Ok((db, recovered)) => {
                if recovered > 0 {
                    eprintln!(
                        "[banto-scada] operation record: {recovered} interrupted row(s) finished as uncertain"
                    );
                }
                Self(Mutex::new(Ok(Arc::new(OperationLog::new(db)))))
            }
            Err(error) => {
                eprintln!("[banto-scada] the operation record could not be opened: {error:?}");
                Self::unavailable(DB_UNAVAILABLE)
            }
        }
    }

    pub fn unavailable(reason: &'static str) -> Self {
        Self(Mutex::new(Err(reason)))
    }

    pub(crate) fn log(&self) -> Result<Arc<OperationLog>, &'static str> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Release the SQLite handles at exit. Later commands answer
    /// `record_failed`. A send still in flight holds the log; it is then
    /// left to the process exit (a `pending` row is finished at the next
    /// start, §9).
    pub async fn close(&self) {
        let taken = std::mem::replace(
            &mut *self.0.lock().unwrap_or_else(|e| e.into_inner()),
            Err(CLOSED),
        );
        if let Ok(log) = taken {
            match Arc::try_unwrap(log) {
                Ok(log) => log.close().await,
                Err(_) => eprintln!("[banto-scada] the operation record is in use at exit"),
            }
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

/// The real clock and the process's mode (fixed for the run).
struct HostEnv {
    runtime: bool,
}

impl OperationEnv for HostEnv {
    fn now_ms(&self) -> i64 {
        now_ms()
    }

    fn is_runtime(&self) -> bool {
        self.runtime
    }
}

/// The answer when the record is not open: a malformed request is still
/// `invalid_request` (never recorded), anything else `record_failed`.
fn unrecordable(request: &OperationWriteRequest, why: &'static str) -> WriteResult {
    eprintln!("[banto-scada] operation write: the record is unavailable ({why})");
    let (code, unrecorded) = match check_shape(request) {
        Err(_) => (reason::INVALID_REQUEST, false),
        Ok(()) => (reason::RECORD_FAILED, true),
    };
    WriteResult {
        outcome: Outcome::Refused,
        reason: Some(code.into()),
        tag: None,
        value: None,
        audit_id: None,
        record_id: None,
        unrecorded,
    }
}

/// `operation_write`: one write request of the Runtime window (§4). The
/// answer is the `WriteResult` of §5 (`outcome`, `reason`, `tag`, `value`,
/// `auditId`, `recordId`, `unrecorded`); the only error is `"runtimeOnly"`
/// (or the IPC's own for arguments that do not deserialize). No lock of the
/// read subscription is held while the catalog is fetched.
#[tauri::command]
pub async fn operation_write(
    mode: State<'_, AppMode>,
    startup: State<'_, StartupProject>,
    auth: State<'_, AuthState>,
    operations: State<'_, OperationState>,
    host: State<'_, NativeHost>,
    request: OperationWriteRequest,
) -> Result<WriteResult, String> {
    mode.require_runtime()?;
    let log = match operations.log() {
        Ok(log) => log,
        Err(why) => return Ok(unrecordable(&request, why)),
    };
    let endpoint = host
        .bootstrap
        .record()
        .ok()
        .flatten()
        .map(|record| record.endpoint);
    let read = host.bootstrap.rest_client().ok().flatten();
    let context = OperationWrite {
        env: Arc::new(HostEnv {
            runtime: matches!(*mode, AppMode::Runtime { .. }),
        }),
        auth: auth.auth_host(),
        log,
        project: startup.applied(),
        hub: HubAccess {
            endpoint,
            read: read.as_ref(),
            subscribed_revision: host.read_revision.get(),
            // Until the write key (O2c-3): never sent.
            write: write_key(),
            min_interval: MIN_WRITE_INTERVAL,
            timeout: WRITE_TIMEOUT,
        },
    };
    Ok(operation_write::operation_write(&context, &request).await)
}

/// `operation_view`: the operation rows of one equipment for the Runtime
/// faceplate (§8, O3a). The Project is the host's applied one. The answer
/// is `OperationView` (`projectId`, `projectDigest`, `blocked`, `phase`,
/// `slots`); the errors are `"runtimeOnly"`, `"invalid_request"` (an id not
/// of 1–128 characters) and `"unknown_equipment"`. A record that is not open
/// is `blocked: "record_failed"` with the slots listed without rows.
#[tauri::command]
pub async fn operation_view(
    mode: State<'_, AppMode>,
    startup: State<'_, StartupProject>,
    auth: State<'_, AuthState>,
    operations: State<'_, OperationState>,
    host: State<'_, NativeHost>,
    request: OperationViewRequest,
) -> Result<OperationView, String> {
    mode.require_runtime()?;
    let read = host.bootstrap.rest_client().ok().flatten();
    let context = ViewContext {
        env: Arc::new(HostEnv {
            runtime: matches!(*mode, AppMode::Runtime { .. }),
        }),
        auth: auth.auth_host(),
        log: operations.log().ok(),
        project: startup.applied(),
        hub: HubAccess {
            endpoint: None,
            read: read.as_ref(),
            subscribed_revision: None,
            write: write_key(),
            min_interval: MIN_WRITE_INTERVAL,
            timeout: VIEW_TIMEOUT,
        },
    };
    operation_write::operation_view(&context, &request)
        .await
        .map_err(str::to_owned)
}
