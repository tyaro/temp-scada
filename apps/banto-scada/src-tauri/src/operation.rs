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
//!   and view. The write key (§7) is read from the record and the keyring
//!   for every write and view (`operation_key::load`): none is
//!   `no_write_key`, one registered for another endpoint than the read
//!   connection's is `hub_mismatch`.
//! - The write key is registered and deleted, and writes resumed, by the
//!   Runtime window's terminal settings (O2c-3b-2): Admin only, login-free
//!   for the local auth-disabled Admin, in `initializing` and
//!   `operational`. One key change at a time (`key_lock`, waited for
//!   first); the phase and the Admin are then checked under the transition
//!   lock, held until the change is done (`with_operation_settings`), so a
//!   logout while waiting is never overtaken. The secret is never answered
//!   back.
//! - A record that could not be opened answers `refused` / `record_failed`
//!   with `unrecorded: true`: nothing can be recorded, so nothing is sent.
//! - `operation_view` (O3a) reads the faceplate's operation rows of one
//!   equipment (§8): the write slots, their last request and why a write
//!   would be refused now. It records nothing and takes neither the
//!   transition lock nor the send slot.
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use scada_host::desktop_auth::SettingsRefusal;
use scada_host::operation_db::{OperationDb, OperationLog, Outcome, WriteStatus};
use scada_host::operation_key::{self, WriteKey, WriteKeyStore};
use scada_host::operation_write::{
    self, check_shape, reason, HubAccess, OperationEnv, OperationView, OperationViewRequest,
    OperationWrite, OperationWriteRequest, ViewContext, WriteResult, WRITE_TIMEOUT,
};
use scada_host::recording_runtime::NO_DATA_DIR;
use serde::Serialize;
use tauri::State;

use crate::alarm::refusal;
use crate::app_mode::AppMode;
use crate::auth::AuthState;
use crate::runtime::StartupProject;
use crate::NativeHost;

/// The bound of the view's status fetch: shorter than a write's, so a Hub
/// that does not answer delays the faceplate's 2-second poll little.
const VIEW_TIMEOUT: Duration = Duration::from_secs(3);

/// The record's file name in the terminal's data dir (§9).
pub const OPERATIONS_DB: &str = "operations.db";

/// Why the record is not open (logged; the screen sees `record_failed`).
const EDITOR_MODE: &str = "editorMode";
const DB_UNAVAILABLE: &str = "operationDbUnavailable";
const CLOSED: &str = "closed";

/// Why the keyring of the write key is not there (logged; the commands
/// answer `key_store`).
const NO_KEY_STORE: &str = "noKeyStore";

/// The operation record of this process (or why it is not open) and the
/// keyring of the write key.
pub struct OperationState {
    log: Mutex<Result<Arc<OperationLog>, &'static str>>,
    keys: Result<Arc<dyn WriteKeyStore>, &'static str>,
    /// Held by a registration and a deletion of the write key, so two never
    /// interleave (the previous entry is read, then replaced). Waited for
    /// before the transition lock.
    key_lock: tokio::sync::Mutex<()>,
}

impl OperationState {
    /// Open `operations.db` under `dir` in Runtime mode. A failure does not
    /// stop the app; the command answers `record_failed`. Rows an earlier
    /// process left `pending` are finished as `uncertain` here (§9).
    pub async fn open(
        mode: &AppMode,
        dir: Result<impl AsRef<Path>, impl std::fmt::Debug>,
        keys: Result<Arc<dyn WriteKeyStore>, &'static str>,
    ) -> Self {
        if !matches!(mode, AppMode::Runtime { .. }) {
            return Self::unavailable(EDITOR_MODE);
        }
        let Ok(dir) = dir else {
            return Self::unavailable(NO_DATA_DIR);
        };
        if let Err(why) = &keys {
            eprintln!("[banto-scada] the write key store is unavailable ({why})");
        }
        let file = dir.as_ref().join(OPERATIONS_DB);
        match OperationDb::open(&file, now_ms()).await {
            Ok((db, recovered)) => {
                if recovered > 0 {
                    eprintln!(
                        "[banto-scada] operation record: {recovered} interrupted row(s) finished as uncertain"
                    );
                }
                Self {
                    log: Mutex::new(Ok(Arc::new(OperationLog::new(db)))),
                    keys,
                    key_lock: tokio::sync::Mutex::new(()),
                }
            }
            Err(error) => {
                eprintln!("[banto-scada] the operation record could not be opened: {error:?}");
                Self::unavailable(DB_UNAVAILABLE)
            }
        }
    }

    pub fn unavailable(reason: &'static str) -> Self {
        Self {
            log: Mutex::new(Err(reason)),
            keys: Err(NO_KEY_STORE),
            key_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// Hold the key lock (tests keep a key change waiting with it).
    #[cfg(test)]
    pub(crate) async fn hold_key_lock_for_test(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.key_lock.lock().await
    }

    pub(crate) fn log(&self) -> Result<Arc<OperationLog>, &'static str> {
        self.log.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The registered write key, read now from the record and the keyring.
    /// A keyring that refuses (or a key that no longer makes a client) is
    /// no key: `no_write_key`, never a write with a key not confirmed.
    fn write_key(&self, log: &OperationLog) -> Option<WriteKey> {
        let store = self.keys.as_ref().ok()?;
        match operation_key::load(store.as_ref(), log) {
            Ok(key) => key,
            Err(error) => {
                eprintln!(
                    "[banto-scada] the write key could not be read ({})",
                    error.as_str()
                );
                None
            }
        }
    }

    /// Release the SQLite handles at exit. Later commands answer
    /// `record_failed`. A send still in flight holds the log; it is then
    /// left to the process exit (a `pending` row is finished at the next
    /// start, §9).
    pub async fn close(&self) {
        let taken = std::mem::replace(
            &mut *self.log.lock().unwrap_or_else(|e| e.into_inner()),
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
    let endpoint = read_endpoint(&host);
    let write = operations.write_key(&log);
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
            // The terminal setting, read at the check (O2c-4b).
            min_interval: None,
            write,
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
    let log = operations.log().ok();
    let write = log.as_deref().and_then(|log| operations.write_key(log));
    let context = ViewContext {
        env: Arc::new(HostEnv {
            runtime: matches!(*mode, AppMode::Runtime { .. }),
        }),
        auth: auth.auth_host(),
        log,
        project: startup.applied(),
        hub: HubAccess {
            endpoint: read_endpoint(&host),
            read: read.as_ref(),
            subscribed_revision: None,
            // The terminal setting, read at the check (O2c-4b).
            min_interval: None,
            write,
            timeout: VIEW_TIMEOUT,
        },
    };
    operation_write::operation_view(&context, &request)
        .await
        .map_err(str::to_owned)
}

/// The write key and the write state for the terminal settings (§7): the
/// endpoint the key was registered for (`null` when none), the saved read
/// connection's endpoint (`null` when none; another one than the key's is
/// `hub_mismatch`) and the write state. The secret is never answered.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationKeyStatus {
    pub key_endpoint: Option<String>,
    pub hub_endpoint: Option<String>,
    pub write: WriteStatus,
    /// The minimum interval between writes in milliseconds (§7, §11-10;
    /// O2c-4b). Saved with `operation_min_interval_set`.
    pub min_interval_ms: u64,
}

fn key_status(log: &OperationLog, host: &NativeHost) -> OperationKeyStatus {
    OperationKeyStatus {
        key_endpoint: log.key_endpoint(),
        hub_endpoint: read_endpoint(host),
        write: log.write_status(),
        min_interval_ms: u64::try_from(log.min_interval().as_millis()).unwrap_or(u64::MAX),
    }
}

/// The endpoint of the saved read connection: the Hub's identity in the
/// record and the endpoint the write key is paired with (§7).
fn read_endpoint(host: &NativeHost) -> Option<String> {
    host.bootstrap
        .record()
        .ok()
        .flatten()
        .map(|record| record.endpoint)
}

/// Run `change` as the current Admin (login-free for the local
/// auth-disabled Admin), in `initializing` or `operational` (§7): checked
/// and run under the transition lock, after the caller's own waits, so a
/// logout, a user change or the move to operation is never between the
/// check and the change. The lock order is the write's (transition lock,
/// then the write state's).
async fn as_admin<T, F, Fut>(auth: &AuthState, change: F) -> Result<T, String>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    match auth
        .get()
        .map_err(refusal)?
        .with_operation_settings(change)
        .await
    {
        Ok(done) => done,
        Err(SettingsRefusal::Phase) => Err("auth_phase_unavailable".into()),
        Err(SettingsRefusal::Auth(error)) => Err(refusal(error)),
    }
}

fn open_log(operations: &OperationState) -> Result<Arc<OperationLog>, String> {
    operations.log().map_err(|why| {
        eprintln!("[banto-scada] operation settings: the record is unavailable ({why})");
        reason::RECORD_FAILED.to_owned()
    })
}

fn key_store(operations: &OperationState) -> Result<Arc<dyn WriteKeyStore>, String> {
    operations
        .keys
        .clone()
        .map_err(|_| operation_key::KeyError::KeyStore.as_str().to_owned())
}

/// `operation_key_status`: the write key and the write state (§7). Runtime
/// only; no permission (nothing secret is answered). `record_failed` when
/// the record is not open.
#[tauri::command]
pub async fn operation_key_status(
    mode: State<'_, AppMode>,
    operations: State<'_, OperationState>,
    host: State<'_, NativeHost>,
) -> Result<OperationKeyStatus, String> {
    mode.require_runtime()?;
    let log = open_log(&operations)?;
    Ok(key_status(&log, &host))
}

/// `operation_key_register`: register `secret` as the write key for the
/// saved read connection's endpoint (§7, `operation_key::register`); the
/// write state becomes `ready`. Admin only. The errors are the auth
/// refusals (`unauthorized`, `forbidden`, `auth_unavailable`,
/// `auth_failed`, `auth_phase_unavailable`), `record_failed` and
/// `KeyError::as_str` (`no_hub`, `invalid_secret`, `invalid_endpoint`,
/// `key_store`).
#[tauri::command]
pub async fn operation_key_register(
    mode: State<'_, AppMode>,
    auth: State<'_, AuthState>,
    operations: State<'_, OperationState>,
    host: State<'_, NativeHost>,
    secret: String,
) -> Result<OperationKeyStatus, String> {
    mode.require_runtime()?;
    let log = open_log(&operations)?;
    let store = key_store(&operations)?;
    let _keys = operations.key_lock.lock().await;
    as_admin(&auth, || async {
        let endpoint = read_endpoint(&host);
        operation_key::register(store.as_ref(), &log, &secret, endpoint.as_deref(), now_ms())
            .await
            .map_err(|error| error.as_str().to_owned())
    })
    .await?;
    Ok(key_status(&log, &host))
}

/// `operation_key_delete`: drop the write key from the record, then its
/// keyring entry (§7). The write state is kept. Admin only; the errors are
/// the auth refusals, `record_failed` and `key_store`.
#[tauri::command]
pub async fn operation_key_delete(
    mode: State<'_, AppMode>,
    auth: State<'_, AuthState>,
    operations: State<'_, OperationState>,
    host: State<'_, NativeHost>,
) -> Result<OperationKeyStatus, String> {
    mode.require_runtime()?;
    let log = open_log(&operations)?;
    let store = key_store(&operations)?;
    let _keys = operations.key_lock.lock().await;
    as_admin(&auth, || async {
        operation_key::delete(store.as_ref(), &log)
            .await
            .map_err(|error| error.as_str().to_owned())
    })
    .await?;
    Ok(key_status(&log, &host))
}

/// `operation_write_resume`: 「書込みを再開」 (§7). A `stopped` terminal
/// becomes `ready` once the record has it; any other state is answered as
/// it is (`key_invalid` needs the key registered again). Admin only; the
/// errors are the auth refusals and `record_failed`.
#[tauri::command]
pub async fn operation_write_resume(
    mode: State<'_, AppMode>,
    auth: State<'_, AuthState>,
    operations: State<'_, OperationState>,
    host: State<'_, NativeHost>,
) -> Result<OperationKeyStatus, String> {
    mode.require_runtime()?;
    let log = open_log(&operations)?;
    as_admin(&auth, || async {
        log.resume(now_ms()).await.map_err(|error| {
            eprintln!("[banto-scada] operation settings: the resume could not be saved: {error:?}");
            reason::RECORD_FAILED.to_owned()
        })
    })
    .await?;
    Ok(key_status(&log, &host))
}

/// `operation_min_interval_set`: save the minimum interval between writes
/// (§7, §11-10; O2c-4b) as `minIntervalMs`: 100–60,000 ms in steps of 100
/// (`operation_db::valid_min_interval`). The next write's check uses it; a
/// write already checked keeps the interval it was checked with. Admin only;
/// the errors are the auth refusals, `invalid_interval` and `record_failed`.
#[tauri::command]
pub async fn operation_min_interval_set(
    mode: State<'_, AppMode>,
    auth: State<'_, AuthState>,
    operations: State<'_, OperationState>,
    host: State<'_, NativeHost>,
    min_interval_ms: i64,
) -> Result<OperationKeyStatus, String> {
    mode.require_runtime()?;
    let log = open_log(&operations)?;
    if !scada_host::operation_db::valid_min_interval(min_interval_ms) {
        return Err(INVALID_INTERVAL.into());
    }
    as_admin(&auth, || async {
        log.set_min_interval(min_interval_ms)
            .await
            .map_err(|error| {
                eprintln!(
                    "[banto-scada] operation settings: the minimum interval could not be saved: {error:?}"
                );
                reason::RECORD_FAILED.to_owned()
            })
    })
    .await?;
    Ok(key_status(&log, &host))
}

/// A minimum interval out of its range (`operation_min_interval_set`).
const INVALID_INTERVAL: &str = "invalid_interval";
