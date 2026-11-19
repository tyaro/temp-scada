//! The operation write command (operation stage-3 design §4, §9; O2b-2b).
//! A thin caller of `scada_host::operation_write`, which owns the checks,
//! the record and the send.
//!
//! - The record `operations.db` sits directly under the terminal's data dir
//!   (next to `alarm-terminal.json`, §9). It is opened at startup in Runtime
//!   mode only: the command is Runtime-only and refused by the mode before
//!   any request is taken, so Editor mode has nothing to record.
//! - The product never sends to the Hub yet: `write_contract_confirmed` is
//!   `false` and there is no write key, so a request that passes the checks
//!   up to §4-4 is recorded as `hub_unsupported` (upstream #1223, O2c).
//! - A record that could not be opened answers `refused` / `record_failed`
//!   with `unrecorded: true`: nothing can be recorded, so nothing is sent.
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use scada_host::operation_db::{OperationDb, OperationLog, Outcome};
use scada_host::operation_write::{
    self, check_shape, reason, HubAccess, OperationEnv, OperationWrite, OperationWriteRequest,
    WriteResult, WRITE_TIMEOUT,
};
use scada_host::recording_runtime::NO_DATA_DIR;
use tauri::State;

use crate::app_mode::AppMode;
use crate::auth::AuthState;
use crate::runtime::StartupProject;
use crate::NativeHost;

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
    let catalog = host.bootstrap.rest_client().ok().flatten();
    let context = OperationWrite {
        env: Arc::new(HostEnv {
            runtime: matches!(*mode, AppMode::Runtime { .. }),
        }),
        auth: auth.auth_host(),
        log,
        project: startup.applied(),
        hub: HubAccess {
            endpoint,
            catalog: catalog.as_ref(),
            subscribed_revision: host.read_revision.get(),
            // Until upstream #1223 and the write key (O2c): never sent.
            write_contract_confirmed: false,
            write: None,
            timeout: WRITE_TIMEOUT,
        },
    };
    Ok(operation_write::operation_write(&context, &request).await)
}
