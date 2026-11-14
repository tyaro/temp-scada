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
//! Either way the session changes (login and setup installs, logout,
//! resolve, the own password change) run under the transition lock
//! ([`AuthHost::gate`]), so they never interleave: a password change
//! finishes on the session it validated.
use std::sync::Arc;

use serde::{Serialize, Serializer};
use serde_json::json;

use banto_admin_services::settings::AuthSettings;
use banto_admin_services::users::{UserIdentity, UserSummary};

use crate::auth::{BantoError, DesktopSession, LoginOutcome, Role, Verified};
use crate::auth_phase::{AuthHost, StartupError, TransitionError, Transitioned};
use crate::recording_gate::{AuthChangeError, RecordingGate};
use crate::user_admin;

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
    /// A refusal of this host's own: `{"kind": ...}`.
    /// `auth_transition_to_operational`: `not_allowed`, `busy`,
    /// `invalid_credentials`, `not_admin` or `save`. User management and
    /// `auth_config_apply`: `not_allowed` (the auth mode is switched only by
    /// the move to operation) or `busy` (the registry holds unsettled work
    /// of the principal the change would end; nothing was changed).
    Refused(&'static str),
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
            Self::Refused(kind) => json!({ "kind": kind }).serialize(serializer),
        }
    }
}

impl From<AuthChangeError> for CommandError {
    fn from(error: AuthChangeError) -> Self {
        match error {
            AuthChangeError::Unauthorized => Self::Banto(BantoError::Unauthorized),
            AuthChangeError::Forbidden => Self::Banto(BantoError::Forbidden),
            AuthChangeError::NotAllowed => Self::Refused("not_allowed"),
            AuthChangeError::Busy => Self::Refused("busy"),
            AuthChangeError::Auth(error) => Self::Banto(error),
        }
    }
}

impl From<TransitionError> for CommandError {
    fn from(error: TransitionError) -> Self {
        match error {
            TransitionError::NotAllowed => Self::Refused("not_allowed"),
            TransitionError::Busy => Self::Refused("busy"),
            TransitionError::InvalidCredentials => Self::Refused("invalid_credentials"),
            TransitionError::NotAdmin => Self::Refused("not_admin"),
            TransitionError::Save => Self::Refused("save"),
            TransitionError::Auth(error) => Self::Banto(error),
            #[cfg(test)]
            TransitionError::Crashed(_) => Self::Refused("crashed"),
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

/// `users_create` (Banto's `UserIdentityResult`): the new account, without
/// its `auth_epoch`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedUser {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: Role,
}

impl From<UserIdentity> for CreatedUser {
    fn from(identity: UserIdentity) -> Self {
        Self {
            id: identity.id,
            username: identity.username,
            display_name: identity.display_name,
            role: identity.role,
        }
    }
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

    pub(crate) fn auth(&self) -> &AuthHost {
        match &self.host {
            Host::Auth(auth) => auth,
            Host::Gate(gate) => gate.auth(),
        }
    }

    /// The recording gate the auth commands go through, if this host has
    /// one: its slot holds the recording registry (product-owner design §4).
    pub fn recording_gate(&self) -> Option<&Arc<RecordingGate>> {
        match &self.host {
            Host::Auth(_) => None,
            Host::Gate(gate) => Some(gate),
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

    /// `project_save`'s permission (alarm design §5.2): writing the Project
    /// file is a setting change, so only an Admin may, checked before the
    /// file is written. In development / initial setup the auth-disabled
    /// session is the Admin, so editing needs no login; in operation the
    /// Admin must be logged in.
    pub async fn authorize_project_save(&self) -> Result<(), CommandError> {
        self.auth()
            .auth()
            .require_role(Role::Admin, "project")
            .await?;
        Ok(())
    }

    /// `auth_login`. A refusal (wrong credentials, auth-disabled mode, a
    /// superseded install) is `Ok` with `success: false`, as in Banto.
    pub async fn login(&self, username: &str, password: &str) -> Result<LoginResult, CommandError> {
        let outcome = match self.gate() {
            Some(gate) => gate.login(username, password).await?,
            None => {
                let auth = self.auth().auth();
                match auth.verify_login(username, password).await? {
                    Verified::Account {
                        identity,
                        seq_at_entry,
                    } => {
                        let _lock = self.auth().gate().await;
                        auth.install_login(seq_at_entry, identity).await?
                    }
                    Verified::Refused(outcome) => outcome,
                }
            }
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
            None => {
                let _lock = self.auth().gate().await;
                auth.install_login(seq_at_entry, identity).await?
            }
        };
        Ok(self.login_result(outcome))
    }

    /// `auth_logout`: the generation after it. A no-op in auth-disabled mode.
    pub async fn logout(&self) -> Result<LogoutResult, CommandError> {
        let seq = match self.gate() {
            Some(gate) => gate.logout().await,
            None => {
                let _lock = self.auth().gate().await;
                self.auth().auth().logout().await
            }
        };
        Ok(LogoutResult { seq })
    }

    /// `auth_resolve`: the re-validated session, and which slot write the
    /// answer is about. A generation it ended has its registry sessions and
    /// subscriptions ended before returning.
    pub async fn resolve(&self) -> Result<AuthResolveResult, CommandError> {
        let resolved = match self.gate() {
            Some(gate) => gate.resolve().await?,
            None => {
                let _lock = self.auth().gate().await;
                self.auth().auth().resolve().await?
            }
        };
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
                let _lock = self.auth().gate().await;
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
            // The administrator's own generation, not one a logout or login
            // reached after the move returned. Without a session there is
            // none to name, so the slot's.
            seq: session.map_or_else(|| self.auth().auth().seq(), |admin| admin.seq),
        })
    }

    /// `users_list` (Admin).
    pub async fn users_list(&self) -> Result<Vec<UserSummary>, CommandError> {
        let _lock = self.auth().gate().await;
        Ok(user_admin::list_users(self.auth().auth()).await?)
    }

    /// `users_create` (Admin). Ends no session.
    pub async fn users_create(
        &self,
        username: &str,
        password: &str,
        display_name: &str,
        role: Role,
    ) -> Result<CreatedUser, CommandError> {
        let _lock = self.auth().gate().await;
        let created =
            user_admin::create_user(self.auth().auth(), username, password, display_name, role)
                .await?;
        Ok(created.into())
    }

    /// `users_update` (Admin): display name and role. Demoting an Admin
    /// whose workflow is unsettled is `busy` (design §4).
    pub async fn users_update(
        &self,
        id: i64,
        display_name: &str,
        role: Role,
    ) -> Result<UserSummary, CommandError> {
        match self.gate() {
            Some(gate) => Ok(gate.update_user(id, display_name, role).await?),
            None => {
                let _lock = self.auth().gate().await;
                let updated =
                    user_admin::update_user(self.auth().auth(), id, display_name, role, |_| false)
                        .await?;
                self.settle().await;
                Ok(updated)
            }
        }
    }

    /// `users_reset_password` (Admin). The account's sessions end before
    /// returning.
    pub async fn users_reset_password(
        &self,
        id: i64,
        new_password: &str,
    ) -> Result<(), CommandError> {
        match self.gate() {
            Some(gate) => Ok(gate.reset_password(id, new_password).await?),
            None => {
                let _lock = self.auth().gate().await;
                user_admin::reset_password(self.auth().auth(), id, new_password).await?;
                self.settle().await;
                Ok(())
            }
        }
    }

    /// `users_delete` (Admin). Deleting an account whose workflow is
    /// unsettled is `busy` (design §4).
    pub async fn users_delete(&self, id: i64) -> Result<(), CommandError> {
        match self.gate() {
            Some(gate) => Ok(gate.delete_user(id).await?),
            None => {
                let _lock = self.auth().gate().await;
                user_admin::delete_user(self.auth().auth(), id, |_| false).await?;
                self.settle().await;
                Ok(())
            }
        }
    }

    /// `auth_config_get` (Viewer or above).
    pub async fn auth_config_get(&self) -> Result<AuthSettings, CommandError> {
        let _lock = self.auth().gate().await;
        Ok(user_admin::auth_config(self.auth().auth()).await?)
    }

    /// `auth_config_apply(disabled, disabledRole)`: Banto's arguments.
    /// Switching the mode is `not_allowed` (design §6); see
    /// [`user_admin::set_auth_config`] for who may call it and when it is
    /// `busy`.
    pub async fn auth_config_apply(
        &self,
        disabled: bool,
        disabled_role: Role,
    ) -> Result<AuthSettings, CommandError> {
        match self.gate() {
            Some(gate) => Ok(gate.set_auth_config(disabled, disabled_role).await?),
            None => {
                let _lock = self.auth().gate().await;
                let saved = user_admin::set_auth_config(
                    self.auth().auth(),
                    disabled,
                    disabled_role,
                    |_| false,
                )
                .await?;
                self.settle().await;
                Ok(saved)
            }
        }
    }

    /// After a change without a gate: settle the slot now, so the session
    /// the change ended is ended before the command returns. A read failure
    /// is left to the next check.
    async fn settle(&self) {
        let _ = self.auth().auth().current().await;
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
