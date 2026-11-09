//! The desktop auth commands (host-gate design §5, §6; implementation order
//! §9 step 4-3-1). Thin adapters only: the behavior is
//! `scada_host::desktop_auth`, tested there with plain `cargo test`.
//!
//! The results and errors are Banto admin-template's wire shapes, so the
//! webview's `createTauriAuthProvider` (`@banto/admin-core`) reads them
//! unchanged. `auth_phase` and `auth_transition_to_operational` are this
//! host's own (design §6). The user-management and auth-settings commands
//! (`users_*`, `auth_config_get`, `auth_config_apply`) take Banto's
//! arguments; their own refusals are `{"kind": "not_allowed" | "busy"}`.
use std::path::Path;
use std::sync::Arc;

use scada_host::auth::Role;
use scada_host::auth_phase::AuthHost;
use scada_host::desktop_auth::{
    startup_reason, AuthPhaseResult, AuthResolveResult, AuthStatusResult, ChangePasswordResult,
    CommandError, CreatedUser, DesktopAuth, LoginResult, LogoutResult, TransitionResult,
};
use scada_host::desktop_recording::DesktopRecording;
use scada_host::recording_gate::RecordingGate;
use scada_host::{AuthSettings, UserSummary};
use tauri::State;

/// The auth of this host, or why it did not start. A failed start is not
/// retried and nothing is re-created (design §6): every command answers
/// `{"kind": "auth_unavailable", "reason": ...}`.
pub struct AuthState(Result<DesktopAuth, &'static str>);

impl AuthState {
    /// The auth of `data_dir` and the recording commands, over one gate
    /// whose slot starts empty with `empty_reason` (product-owner design
    /// §4): a root is installed only once a recording runs. Without the
    /// auth, the recording commands answer `recordingUnavailable` with the
    /// auth's reason.
    pub async fn start(data_dir: &Path, empty_reason: &'static str) -> (Self, DesktopRecording) {
        match AuthHost::start(data_dir).await {
            Ok(auth) => {
                let gate = Arc::new(RecordingGate::empty(Arc::new(auth), empty_reason));
                (
                    Self(Ok(DesktopAuth::with_gate(gate.clone()))),
                    DesktopRecording::new(gate),
                )
            }
            Err(error) => {
                let reason = startup_reason(&error);
                (Self(Err(reason)), DesktopRecording::unavailable(reason))
            }
        }
    }

    /// The auth of a host with a recording registry: every change of the
    /// desktop session goes through `gate`, so the registry sessions and
    /// subscriptions it ends are revoked within the same command. The
    /// recording commands use the same gate.
    #[cfg(test)]
    pub fn with_gate(gate: Arc<RecordingGate>) -> Self {
        Self(Ok(DesktopAuth::with_gate(gate)))
    }

    pub fn unavailable(reason: &'static str) -> Self {
        Self(Err(reason))
    }

    pub(crate) fn get(&self) -> Result<&DesktopAuth, CommandError> {
        self.0
            .as_ref()
            .map_err(|reason| CommandError::Unavailable(reason))
    }
}

#[tauri::command]
pub async fn auth_status(state: State<'_, AuthState>) -> Result<AuthStatusResult, CommandError> {
    state.get()?.status().await
}

#[tauri::command]
pub async fn auth_phase(state: State<'_, AuthState>) -> Result<AuthPhaseResult, CommandError> {
    state.get()?.phase().await
}

#[tauri::command]
pub async fn auth_setup(
    state: State<'_, AuthState>,
    username: String,
    password: String,
    display_name: String,
) -> Result<LoginResult, CommandError> {
    state
        .get()?
        .setup(&username, &password, &display_name)
        .await
}

#[tauri::command]
pub async fn auth_login(
    state: State<'_, AuthState>,
    username: String,
    password: String,
) -> Result<LoginResult, CommandError> {
    state.get()?.login(&username, &password).await
}

#[tauri::command]
pub async fn auth_logout(state: State<'_, AuthState>) -> Result<LogoutResult, CommandError> {
    state.get()?.logout().await
}

#[tauri::command]
pub async fn auth_resolve(state: State<'_, AuthState>) -> Result<AuthResolveResult, CommandError> {
    state.get()?.resolve().await
}

#[tauri::command]
pub async fn auth_change_password(
    state: State<'_, AuthState>,
    current_password: String,
    new_password: String,
) -> Result<ChangePasswordResult, CommandError> {
    state
        .get()?
        .change_password(&current_password, &new_password)
        .await
}

#[tauri::command]
pub async fn auth_transition_to_operational(
    state: State<'_, AuthState>,
    username: String,
    password: String,
    display_name: String,
) -> Result<TransitionResult, CommandError> {
    state
        .get()?
        .transition_to_operational(&username, &password, &display_name)
        .await
}

#[tauri::command]
pub async fn users_list(state: State<'_, AuthState>) -> Result<Vec<UserSummary>, CommandError> {
    state.get()?.users_list().await
}

#[tauri::command]
pub async fn users_create(
    state: State<'_, AuthState>,
    username: String,
    password: String,
    display_name: String,
    role: Role,
) -> Result<CreatedUser, CommandError> {
    state
        .get()?
        .users_create(&username, &password, &display_name, role)
        .await
}

#[tauri::command]
pub async fn users_update(
    state: State<'_, AuthState>,
    id: i64,
    display_name: String,
    role: Role,
) -> Result<UserSummary, CommandError> {
    state.get()?.users_update(id, &display_name, role).await
}

#[tauri::command]
pub async fn users_reset_password(
    state: State<'_, AuthState>,
    id: i64,
    new_password: String,
) -> Result<(), CommandError> {
    state.get()?.users_reset_password(id, &new_password).await
}

#[tauri::command]
pub async fn users_delete(state: State<'_, AuthState>, id: i64) -> Result<(), CommandError> {
    state.get()?.users_delete(id).await
}

#[tauri::command]
pub async fn auth_config_get(state: State<'_, AuthState>) -> Result<AuthSettings, CommandError> {
    state.get()?.auth_config_get().await
}

#[tauri::command]
pub async fn auth_config_apply(
    state: State<'_, AuthState>,
    disabled: bool,
    disabled_role: Role,
) -> Result<AuthSettings, CommandError> {
    state
        .get()?
        .auth_config_apply(disabled, disabled_role)
        .await
}
