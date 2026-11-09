//! Development / initial-setup phase of the host's authentication and the
//! move to operation (host-gate design §6).
//!
//! The phase is recorded in `auth-phase.json`, apart from the auth DB:
//!
//! - `bootstrapping`: the first start is creating the auth DB.
//! - `initializing`: development / initial setup. Auth-disabled mode is on
//!   (with role Admin) from the first start, so no login is needed.
//! - `transitioning`: the move to operation is in progress.
//! - `operational`: normal logins.
//!
//! [`AuthHost::start`] finishes an interrupted first start and refuses the
//! states the design rules out: an auth DB without a phase record, and a
//! missing auth DB after the first start (never re-created, so a lost DB
//! cannot reopen unauthenticated changes). [`AuthHost::transition_to_operational`]
//! is the only way from `initializing` to `operational`; every step is saved
//! before the next one and is safe to repeat, so a failure or a crash
//! anywhere resumes from `transitioning`.
//!
//! The phase lives behind [`AuthHost::gate`], the host's transition lock:
//! the recording registry's entry points take the same lock, so no request
//! is accepted between the quiescence check and the phase change.
use std::fs;
use std::path::{Path, PathBuf};

use banto_admin_services::settings::AuthSettings;
use banto_admin_services::Role;
use banto_core::BantoError;
use serde_json::{json, Value};
use tokio::sync::{Mutex, MutexGuard};

use crate::auth::{CurrentSession, DesktopSession, HostAuth, LoginOutcome, AUTH_DB_FILE};
use crate::durable;

/// File name of the phase record inside the app data dir (design §6).
pub const AUTH_PHASE_FILE: &str = "auth-phase.json";
/// Lock file held for the [`AuthHost`]'s lifetime: one host per data dir.
pub const AUTH_PHASE_LOCK_FILE: &str = "auth-phase.lock";

const FILE_VERSION: u64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthPhase {
    Bootstrapping,
    Initializing,
    Transitioning,
    Operational,
}

impl AuthPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bootstrapping => "bootstrapping",
            Self::Initializing => "initializing",
            Self::Transitioning => "transitioning",
            Self::Operational => "operational",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "bootstrapping" => Self::Bootstrapping,
            "initializing" => Self::Initializing,
            "transitioning" => Self::Transitioning,
            "operational" => Self::Operational,
            _ => return None,
        })
    }

    /// Whether the recording registry's entry points may be used in this
    /// phase. `transitioning` refuses them even while auth-disabled mode is
    /// still on (design §6).
    pub fn admits_registry(self) -> bool {
        matches!(self, Self::Initializing | Self::Operational)
    }
}

#[derive(Debug)]
pub enum StartupError {
    /// Another host holds this data dir, or its lock cannot be taken.
    InUse,
    /// The phase record exists but cannot be read.
    PhaseUnreadable,
    /// The phase record is not a valid saved phase. It is not overwritten.
    PhaseCorrupt,
    /// An auth DB exists without a phase record. The first-start order never
    /// produces this, so the record is taken as lost (design §6).
    PhaseLost,
    /// The phase is past the first start but the auth DB is missing. It is
    /// not re-created (design §6).
    AuthDbMissing(AuthPhase),
    /// The phase record could not be saved.
    Save,
    /// The auth DB could not be opened, migrated or configured.
    Auth(BantoError),
    /// Test fault injection only: the start stopped at this point, as a
    /// process kill would.
    #[cfg(test)]
    Crashed(Checkpoint),
}

#[derive(Debug)]
pub enum TransitionError {
    /// The phase or the current session does not allow the transition:
    /// `initializing` needs auth-disabled mode on, the synthetic session
    /// with role Admin, and either no account or an Admin account;
    /// `operational` is already done.
    NotAllowed,
    /// The recording registry is not quiescent; nothing was saved.
    Busy,
    /// The credentials do not verify (unknown user or wrong password).
    InvalidCredentials,
    /// The verified account is not an Admin.
    NotAdmin,
    /// The phase record could not be saved.
    Save,
    /// The auth DB failed, or the new account was refused (validation).
    Auth(BantoError),
    #[cfg(test)]
    Crashed(Checkpoint),
}

/// Points where the fault-injection tests stop a start or a transition.
/// Everything before the point is saved; nothing after it runs.
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Checkpoint {
    /// First start: `bootstrapping` saved.
    Bootstrapping,
    /// First start: auth DB created and migrated, settings not saved.
    Migrated,
    /// First start: auth-disabled mode saved, `initializing` not saved.
    Configured,
    /// Transition step 1: `transitioning` saved.
    Transitioning,
    /// Transition step 2: the administrator created or verified.
    AdminReady,
    /// Transition step 3: auth-disabled mode turned off.
    AuthEnabled,
    /// Transition step 4: `operational` saved, no session installed.
    Operational,
}

/// Fault injection: `false` stops at the checkpoint. Always `true` outside
/// tests.
type Faults<'a> = &'a mut (dyn FnMut(Checkpoint) -> bool + Send);

macro_rules! checkpoint {
    ($faults:expr, $point:expr, $error:ident) => {
        #[cfg(test)]
        if !($faults)($point) {
            return Err($error::Crashed($point));
        }
        #[cfg(not(test))]
        let _ = ($faults)($point);
    };
}

/// Result of a completed transition.
#[derive(Debug)]
pub struct Transitioned {
    /// The administrator's session, or `None` if another command re-bound
    /// the slot first; the phase is `operational` either way and the UI
    /// proceeds to a normal login (design §6).
    pub session: Option<CurrentSession>,
}

/// The phase, held under the transition lock.
pub struct PhaseGuard<'a> {
    phase: MutexGuard<'a, AuthPhase>,
}

impl PhaseGuard<'_> {
    pub fn phase(&self) -> AuthPhase {
        *self.phase
    }
}

/// The host's authentication: the auth DB with its desktop session, and the
/// phase it is in.
pub struct AuthHost {
    auth: HostAuth,
    phase_path: PathBuf,
    phase: Mutex<AuthPhase>,
    /// Held (locked) while the host lives; released by the OS on close.
    _lock: fs::File,
}

impl AuthHost {
    /// Open the auth of the app data dir `data_dir` (design §6):
    ///
    /// - no phase record and no auth DB: the first start. Save
    ///   `bootstrapping`, create the auth DB with auth-disabled mode on
    ///   (role Admin), then save `initializing`.
    /// - `bootstrapping`: an interrupted first start; redo it from the DB step,
    ///   whatever the DB holds.
    /// - no phase record but an auth DB: [`StartupError::PhaseLost`].
    /// - any later phase without the auth DB: [`StartupError::AuthDbMissing`].
    /// - otherwise open the DB as saved.
    pub async fn start(data_dir: &Path) -> Result<Self, StartupError> {
        Self::start_inner(data_dir, &mut |_| true).await
    }

    #[cfg(test)]
    pub(crate) async fn start_with(
        data_dir: &Path,
        faults: &mut (dyn FnMut(Checkpoint) -> bool + Send),
    ) -> Result<Self, StartupError> {
        Self::start_inner(data_dir, faults).await
    }

    async fn start_inner(data_dir: &Path, faults: Faults<'_>) -> Result<Self, StartupError> {
        let lock = durable::open_lock_file(data_dir, AUTH_PHASE_LOCK_FILE)
            .map_err(|_| StartupError::InUse)?;
        lock.try_lock().map_err(|_| StartupError::InUse)?;
        let phase_path = data_dir.join(AUTH_PHASE_FILE);
        let db_path = data_dir.join(AUTH_DB_FILE);
        let db_exists = durable::exists(&db_path).map_err(|e| StartupError::Auth(io_error(e)))?;
        let (auth, phase) = match load(&phase_path)? {
            None if db_exists => return Err(StartupError::PhaseLost),
            None => {
                save(&phase_path, AuthPhase::Bootstrapping)?;
                checkpoint!(faults, Checkpoint::Bootstrapping, StartupError);
                (
                    first_start(&db_path, &phase_path, faults).await?,
                    AuthPhase::Initializing,
                )
            }
            Some(AuthPhase::Bootstrapping) => (
                first_start(&db_path, &phase_path, faults).await?,
                AuthPhase::Initializing,
            ),
            Some(phase) if !db_exists => return Err(StartupError::AuthDbMissing(phase)),
            Some(phase) => (
                HostAuth::open(&db_path).await.map_err(StartupError::Auth)?,
                phase,
            ),
        };
        Ok(Self {
            auth,
            phase_path,
            phase: Mutex::new(phase),
            _lock: lock,
        })
    }

    pub fn auth(&self) -> &HostAuth {
        &self.auth
    }

    /// The current phase (waits while a transition holds the lock).
    pub async fn phase(&self) -> AuthPhase {
        *self.phase.lock().await
    }

    /// Take the transition lock. The recording registry's entry points hold
    /// it while accepting a request and refuse unless
    /// [`AuthPhase::admits_registry`].
    pub async fn gate(&self) -> PhaseGuard<'_> {
        PhaseGuard {
            phase: self.phase.lock().await,
        }
    }

    /// Move from development / initial setup to operation (design §6),
    /// `auth_transition_to_operational`.
    ///
    /// Accepted in `initializing` from the synthetic auth-disabled session
    /// with role Admin, or in `transitioning` from any session (the
    /// credentials are always verified once an administrator exists).
    /// `quiescent` is asked under the transition lock, before anything is
    /// saved; `false` refuses with [`TransitionError::Busy`].
    ///
    /// Steps, each saved before the next and each safe to repeat:
    /// 1. save `transitioning`;
    /// 2. create the first administrator if none exists (only while
    ///    auth-disabled mode is still on), else verify the credentials and
    ///    that the account is an Admin;
    /// 3. turn auth-disabled mode off;
    /// 4. save `operational` (the durable completion point);
    /// 5. install the administrator's session. Turning the mode off already
    ///    ended the synthetic session (its `seq` advanced).
    pub async fn transition_to_operational(
        &self,
        username: &str,
        password: &str,
        display_name: &str,
        quiescent: impl FnOnce() -> bool,
    ) -> Result<Transitioned, TransitionError> {
        self.transition_inner(username, password, display_name, quiescent, &mut |_| true)
            .await
    }

    #[cfg(test)]
    pub(crate) async fn transition_with(
        &self,
        username: &str,
        password: &str,
        display_name: &str,
        quiescent: impl FnOnce() -> bool,
        faults: &mut (dyn FnMut(Checkpoint) -> bool + Send),
    ) -> Result<Transitioned, TransitionError> {
        self.transition_inner(username, password, display_name, quiescent, faults)
            .await
    }

    async fn transition_inner(
        &self,
        username: &str,
        password: &str,
        display_name: &str,
        quiescent: impl FnOnce() -> bool,
        faults: Faults<'_>,
    ) -> Result<Transitioned, TransitionError> {
        let mut phase = self.phase.lock().await;
        match *phase {
            AuthPhase::Initializing => {
                let config = self.auth.settings().auth_config().await;
                let config = config.map_err(TransitionError::Auth)?;
                let current = self.auth.current().await.map_err(TransitionError::Auth)?;
                let local_admin = matches!(
                    current.as_ref().map(|c| &c.session),
                    Some(DesktopSession::AuthDisabledLocal(identity)) if identity.role == Role::Admin
                );
                if !config.disabled || !local_admin {
                    return Err(TransitionError::NotAllowed);
                }
                // Accounts without an administrator could neither create one
                // (Banto creates only the very first account) nor verify one,
                // so step 1 would leave a transition that cannot finish.
                let users = self.auth.users();
                let has_admin = users.has_admin().await.map_err(TransitionError::Auth)?;
                if !has_admin
                    && users
                        .is_initialized()
                        .await
                        .map_err(TransitionError::Auth)?
                {
                    return Err(TransitionError::NotAllowed);
                }
            }
            AuthPhase::Transitioning => {}
            AuthPhase::Bootstrapping | AuthPhase::Operational => {
                return Err(TransitionError::NotAllowed)
            }
        }
        if !quiescent() {
            return Err(TransitionError::Busy);
        }
        if *phase != AuthPhase::Transitioning {
            save(&self.phase_path, AuthPhase::Transitioning).map_err(|_| TransitionError::Save)?;
            *phase = AuthPhase::Transitioning;
        }
        checkpoint!(faults, Checkpoint::Transitioning, TransitionError);

        let config = self
            .auth
            .settings()
            .auth_config()
            .await
            .map_err(TransitionError::Auth)?;
        let has_admin = self
            .auth
            .users()
            .has_admin()
            .await
            .map_err(TransitionError::Auth)?;
        let admin = if !has_admin && config.disabled {
            let created = self
                .auth
                .users()
                .setup_first_user(username, password, display_name)
                .await
                .map_err(TransitionError::Auth)?;
            self.auth
                .record_ok(&created, "setup", "auth", None, None)
                .await;
            created
        } else {
            let verified = self
                .auth
                .users()
                .verify(username, password)
                .await
                .map_err(TransitionError::Auth)?
                .ok_or(TransitionError::InvalidCredentials)?;
            if verified.role != Role::Admin {
                return Err(TransitionError::NotAdmin);
            }
            verified
        };
        checkpoint!(faults, Checkpoint::AdminReady, TransitionError);

        if config.disabled {
            self.auth
                .set_auth_config(&AuthSettings {
                    disabled: false,
                    ..config
                })
                .await
                .map_err(TransitionError::Auth)?;
        }
        checkpoint!(faults, Checkpoint::AuthEnabled, TransitionError);

        save(&self.phase_path, AuthPhase::Operational).map_err(|_| TransitionError::Save)?;
        *phase = AuthPhase::Operational;
        self.auth
            .record_ok(&admin, "transition_to_operational", "auth", None, None)
            .await;
        checkpoint!(faults, Checkpoint::Operational, TransitionError);

        // Past the completion point nothing is undone: a failed install
        // leaves the UI to a normal login.
        let session = match self.auth.adopt(admin).await {
            Ok(LoginOutcome::LoggedIn(current)) => Some(current),
            _ => None,
        };
        Ok(Transitioned { session })
    }
}

/// First-start steps 2-3 (design §6): create (or reopen) the auth DB,
/// migrate it, save auth-disabled mode with role Admin, then save
/// `initializing`. Repeating it on any partial result gives the same DB.
async fn first_start(
    db_path: &Path,
    phase_path: &Path,
    faults: Faults<'_>,
) -> Result<HostAuth, StartupError> {
    let auth = HostAuth::open(db_path).await.map_err(StartupError::Auth)?;
    checkpoint!(faults, Checkpoint::Migrated, StartupError);
    let config = auth
        .settings()
        .auth_config()
        .await
        .map_err(StartupError::Auth)?;
    auth.set_auth_config(&AuthSettings {
        disabled: true,
        disabled_role: Role::Admin,
        ..config
    })
    .await
    .map_err(StartupError::Auth)?;
    checkpoint!(faults, Checkpoint::Configured, StartupError);
    save(phase_path, AuthPhase::Initializing)?;
    Ok(auth)
}

fn load(path: &Path) -> Result<Option<AuthPhase>, StartupError> {
    let Some(bytes) = durable::read_optional(path).map_err(|_| StartupError::PhaseUnreadable)?
    else {
        return Ok(None);
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| StartupError::PhaseCorrupt)?;
    let object = value.as_object().ok_or(StartupError::PhaseCorrupt)?;
    if object.len() != 2 || object.get("version").and_then(Value::as_u64) != Some(FILE_VERSION) {
        return Err(StartupError::PhaseCorrupt);
    }
    object
        .get("phase")
        .and_then(Value::as_str)
        .and_then(AuthPhase::parse)
        .map(Some)
        .ok_or(StartupError::PhaseCorrupt)
}

fn save(path: &Path, phase: AuthPhase) -> Result<(), StartupError> {
    let body = serde_json::to_vec(&json!({"version": FILE_VERSION, "phase": phase.as_str()}))
        .map_err(|_| StartupError::Save)?;
    durable::replace(path, &body).map_err(|_| StartupError::Save)
}

fn io_error(error: std::io::Error) -> BantoError {
    BantoError::Storage(error.to_string())
}

#[cfg(test)]
mod tests;
