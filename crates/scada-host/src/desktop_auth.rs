//! The desktop webview's auth commands (host-gate design §5, §6;
//! implementation order §9 step 4-3-1). Tauri-independent: each command of
//! `apps/banto-scada/src-tauri` calls one method here and returns its result
//! unchanged, so the behavior is tested with plain `cargo test`.
//!
//! The results are Banto admin-template's wire shapes (`LoginResult`,
//! `LogoutResult`, `AuthResolveResult`, `ChangePasswordResult`,
//! `AuthStatusResult`), so `@banto/admin-core`'s `createTauriAuthProvider`
//! reads them unchanged. Errors are Banto's `ErrorBody` (`{"kind": ...}`);
//! only the commands Banto does not have add kinds of their own
//! ([`CommandError`]).
//!
//! With a [`RecordingGate`], every change of the desktop session goes
//! through it, so the registry sessions and subscriptions it ends are
//! revoked within the same command (§5). Without one (no recording owner on
//! this host yet), there is nothing to revoke and nothing to keep quiescent.
use std::sync::Arc;

use serde::{Serialize, Serializer};
use serde_json::json;

use crate::auth::{BantoError, DesktopSession, LoginOutcome};
use crate::auth_phase::{AuthHost, StartupError, TransitionError, Transitioned};
use crate::recording_gate::RecordingGate;

const INVALID_CREDENTIALS_MESSAGE: &str = "ユーザー名またはパスワードが違います";
const SUPERSEDED_LOGIN_MESSAGE: &str =
    "別のセッションが先に確定したため、このログインは適用されませんでした";
/// Auth-disabled mode is on only before the move to operation (design §6),
/// so the way out is that move, not a setting.
const AUTH_DISABLED_LOGIN_MESSAGE: &str =
    "初期設定中（ログイン不要モード）はアカウントでログインできません。運用への移行を行ってください";
/// Display name of the synthetic auth-disabled session (Banto's).
const LOCAL_DISPLAY_NAME: &str = "ローカルユーザー";

/// An error of a desktop auth command, serialized as Banto's `ErrorBody`.
#[derive(Debug)]
pub enum CommandError {
    /// Banto's own error, serialized as Banto serializes it.
    Banto(BantoError),
    /// The auth host did not start (design §6); no auth command is served.
    /// `{"kind": "auth_unavailable", "reason": ...}`.
    Unavailable(&'static str),
    /// `auth_transition_to_operational` refused: `{"kind": ...}` with
    /// `not_allowed`, `busy`, `invalid_credentials`, `not_admin` or `save`.
    Transition(&'static str),
}

impl From<BantoError> for CommandError {
    fn from(error: BantoError) -> Self {
        Self::Banto(error)
    }
}

impl Serialize for CommandError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Banto(error) => error.serialize(serializer),
            Self::Unavailable(reason) => {
                json!({"kind": "auth_unavailable", "reason": reason}).serialize(serializer)
            }
            Self::Transition(kind) => json!({ "kind": kind }).serialize(serializer),
        }
    }
}

impl From<TransitionError> for CommandError {
    fn from(error: TransitionError) -> Self {
        match error {
            TransitionError::NotAllowed => Self::Transition("not_allowed"),
            TransitionError::Busy => Self::Transition("busy"),
            TransitionError::InvalidCredentials => Self::Transition("invalid_credentials"),
            TransitionError::NotAdmin => Self::Transition("not_admin"),
            TransitionError::Save => Self::Transition("save"),
            TransitionError::Auth(error) => Self::Banto(error),
            #[cfg(test)]
            TransitionError::Crashed(_) => Self::Transition("crashed"),
        }
    }
}

/// The reason string of [`CommandError::Unavailable`] for a failed start.
pub fn startup_reason(error: &StartupError) -> &'static str {
    match error {
        StartupError::InUse => "in_use",
        StartupError::PhaseUnreadable => "phase_unreadable",
        StartupError::PhaseCorrupt => "phase_corrupt",
        StartupError::PhaseLost => "phase_lost",
        StartupError::AuthDbMissing(_) => "auth_db_missing",
        StartupError::Save => "save",
        StartupError::Auth(_) => "auth_db",
        #[cfg(test)]
        StartupError::Crashed(_) => "crashed",
    }
}

/// `auth_status`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatusResult {
    pub initialized: bool,
    /// Always `false` in the desktop window (Banto's).
    pub viewer_public: bool,
}

/// `auth_phase` (this host's): which screen the UI shows (design §6).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPhaseResult {
    /// `initializing`, `transitioning` or `operational`.
    pub phase: &'static str,
    pub auth_disabled: bool,
    /// Checked by the backend, never a browser-stored value (design §6).
    pub has_admin: bool,
}

/// `auth_login` and `auth_setup`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LoginResult {
    pub success: bool,
    pub error: Option<String>,
    pub superseded: bool,
    pub seq: u64,
}

/// `auth_logout`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LogoutResult {
    pub seq: u64,
}

/// `auth_change_password`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChangePasswordResult {
    pub seq: u64,
}

/// `auth_transition_to_operational`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionResult {
    /// Whether the administrator's session was installed. If not, the phase
    /// is `operational` all the same and the UI proceeds to a normal login.
    pub signed_in: bool,
    pub seq: u64,
}

/// Banto's `Identity`: `id` is the username (Banto's convention).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Identity {
    pub id: String,
    pub name: String,
    pub role: String,
}

/// `auth_resolve`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AuthResolveResult {
    pub identity: Option<Identity>,
    /// `"account"` or `"local"` (the synthetic auth-disabled session).
    pub kind: Option<&'static str>,
    pub checked: u64,
    pub current: u64,
    pub stale: bool,
}

/// The desktop auth commands of one host.
pub struct DesktopAuth {
    host: Host,
}

enum Host {
    Auth(Arc<AuthHost>),
    Gate(Arc<RecordingGate>),
}

impl DesktopAuth {
    /// A host with no recording registry.
    pub fn new(auth: Arc<AuthHost>) -> Self {
        Self {
            host: Host::Auth(auth),
        }
    }

    /// A host whose desktop session changes go through `gate`.
    pub fn with_gate(gate: Arc<RecordingGate>) -> Self {
        Self {
            host: Host::Gate(gate),
        }
    }

    fn auth(&self) -> &AuthHost {
        match &self.host {
            Host::Auth(auth) => auth,
            Host::Gate(gate) => gate.auth(),
        }
    }

    fn gate(&self) -> Option<&RecordingGate> {
        match &self.host {
            Host::Auth(_) => None,
            Host::Gate(gate) => Some(gate),
        }
    }

    /// `auth_status`: whether any account exists.
    pub async fn status(&self) -> Result<AuthStatusResult, CommandError> {
        Ok(AuthStatusResult {
            initialized: self.auth().auth().users().is_initialized().await?,
            viewer_public: false,
        })
    }

    /// `auth_phase`: the phase, the mode and whether an administrator
    /// exists, so the UI chooses between the move to operation, its re-run
    /// and the login screen (design §6).
    pub async fn phase(&self) -> Result<AuthPhaseResult, CommandError> {
        let auth = self.auth().auth();
        // Under the transition lock: a move to operation holds it from its
        // first save to its last, so the three values are of one state.
        let guard = self.auth().gate().await;
        Ok(AuthPhaseResult {
            phase: guard.phase().as_str(),
            auth_disabled: auth.settings().auth_config().await?.disabled,
            has_admin: auth.users().has_admin().await?,
        })
    }

    /// `auth_login`. A refusal (wrong credentials, auth-disabled mode, a
    /// superseded install) is `Ok` with `success: false`, as in Banto.
    pub async fn login(&self, username: &str, password: &str) -> Result<LoginResult, CommandError> {
        let outcome = match self.gate() {
            Some(gate) => gate.login(username, password).await?,
            None => self.auth().auth().login(username, password).await?,
        };
        Ok(self.login_result(outcome))
    }

    /// `auth_setup`: create the very first account and log in as it. Banto
    /// refuses it while auth-disabled mode is on, so on this host the first
    /// administrator is made by the move to operation instead (design §6);
    /// this stays for `createTauriAuthProvider`'s `setup()`.
    pub async fn setup(
        &self,
        username: &str,
        password: &str,
        display_name: &str,
    ) -> Result<LoginResult, CommandError> {
        let auth = self.auth().auth();
        let seq_at_entry = auth.seq();
        if auth.settings().auth_config().await?.disabled {
            return Ok(self.login_result(LoginOutcome::AuthDisabled));
        }
        let identity = match auth
            .users()
            .setup_first_user(username, password, display_name)
            .await
        {
            Ok(identity) => identity,
            Err(error @ BantoError::Validation { .. }) => return Err(error.into()),
            Err(other) => {
                return Ok(LoginResult {
                    success: false,
                    error: Some(other.to_string()),
                    superseded: false,
                    seq: auth.seq(),
                })
            }
        };
        auth.record_ok(&identity, "setup", "auth", None, None).await;
        let outcome = match self.gate() {
            Some(gate) => gate.install_account(seq_at_entry, identity).await?,
            None => auth.install_login(seq_at_entry, identity).await?,
        };
        Ok(self.login_result(outcome))
    }

    /// `auth_logout`: the generation after it. A no-op in auth-disabled mode.
    pub async fn logout(&self) -> Result<LogoutResult, CommandError> {
        let seq = match self.gate() {
            Some(gate) => gate.logout().await,
            None => self.auth().auth().logout().await,
        };
        Ok(LogoutResult { seq })
    }

    /// `auth_resolve`: the re-validated session, and which slot write the
    /// answer is about. A generation it ended has its registry sessions and
    /// subscriptions ended before returning.
    pub async fn resolve(&self) -> Result<AuthResolveResult, CommandError> {
        let resolved = self.auth().auth().resolve().await?;
        if let Some(gate) = self.gate() {
            // Every generation before `current` has ended, so a session this
            // call cleared or re-bound ends its registry sessions and
            // subscriptions here, without a second auth DB read.
            gate.end_generations_before(resolved.current);
        }
        Ok(AuthResolveResult {
            identity: resolved.session.as_ref().map(identity_of),
            kind: resolved.session.as_ref().map(|session| match session {
                DesktopSession::Account(_) => "account",
                DesktopSession::AuthDisabledLocal(_) => "local",
            }),
            checked: resolved.checked,
            current: resolved.current,
            stale: resolved.stale,
        })
    }

    /// `auth_change_password`: the logged-in account's own password.
    pub async fn change_password(
        &self,
        current_password: &str,
        new_password: &str,
    ) -> Result<ChangePasswordResult, CommandError> {
        let seq = match self.gate() {
            Some(gate) => {
                gate.change_own_password(current_password, new_password)
                    .await?
            }
            None => {
                self.auth()
                    .auth()
                    .change_own_password(current_password, new_password)
                    .await?
            }
        };
        Ok(ChangePasswordResult { seq })
    }

    /// `auth_transition_to_operational` (design §6).
    pub async fn transition_to_operational(
        &self,
        username: &str,
        password: &str,
        display_name: &str,
    ) -> Result<TransitionResult, CommandError> {
        let Transitioned { session } = match self.gate() {
            Some(gate) => {
                gate.transition_to_operational(username, password, display_name)
                    .await?
            }
            // No registry: nothing can be left unsettled.
            None => {
                self.auth()
                    .transition_to_operational(username, password, display_name, || true)
                    .await?
            }
        };
        Ok(TransitionResult {
            signed_in: session.is_some(),
            seq: self.auth().auth().seq(),
        })
    }

    fn login_result(&self, outcome: LoginOutcome) -> LoginResult {
        let refused = |error: &str, superseded: bool| LoginResult {
            success: false,
            error: Some(error.to_owned()),
            superseded,
            seq: self.auth().auth().seq(),
        };
        match outcome {
            LoginOutcome::LoggedIn(current) => LoginResult {
                success: true,
                error: None,
                superseded: false,
                seq: current.seq,
            },
            LoginOutcome::InvalidCredentials => refused(INVALID_CREDENTIALS_MESSAGE, false),
            LoginOutcome::AuthDisabled => refused(AUTH_DISABLED_LOGIN_MESSAGE, false),
            LoginOutcome::Superseded => refused(SUPERSEDED_LOGIN_MESSAGE, true),
        }
    }
}

fn identity_of(session: &DesktopSession) -> Identity {
    let identity = session.identity();
    let name = match session {
        DesktopSession::AuthDisabledLocal(_) => LOCAL_DISPLAY_NAME.to_owned(),
        DesktopSession::Account(_) => identity.display_name.clone(),
    };
    Identity {
        id: identity.username.clone(),
        name,
        role: identity.role.as_str().to_owned(),
    }
}

#[cfg(test)]
mod tests;
