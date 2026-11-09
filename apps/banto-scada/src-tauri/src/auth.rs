//! The desktop auth commands (host-gate design §5, §6; implementation order
//! §9 step 4-3-1). Thin adapters only: the behavior is
//! `scada_host::desktop_auth`, tested there with plain `cargo test`.
//!
//! The results and errors are Banto admin-template's wire shapes, so the
//! webview's `createTauriAuthProvider` (`@banto/admin-core`) reads them
//! unchanged. `auth_phase` and `auth_transition_to_operational` are this
//! host's own (design §6).
use std::path::Path;
use std::sync::Arc;

use scada_host::auth_phase::AuthHost;
use scada_host::desktop_auth::{
    startup_reason, AuthPhaseResult, AuthResolveResult, AuthStatusResult, ChangePasswordResult,
    CommandError, DesktopAuth, LoginResult, LogoutResult, TransitionResult,
};
use scada_host::recording_gate::RecordingGate;
use tauri::State;

/// The auth of this host, or why it did not start. A failed start is not
/// retried and nothing is re-created (design §6): every command answers
/// `{"kind": "auth_unavailable", "reason": ...}`.
pub struct AuthState(Result<DesktopAuth, &'static str>);

impl AuthState {
    pub async fn start(data_dir: &Path) -> Self {
        Self(
            AuthHost::start(data_dir)
                .await
                .map(|auth| DesktopAuth::new(Arc::new(auth)))
                .map_err(|error| startup_reason(&error)),
        )
    }

    /// The auth of a host with a recording registry: every change of the
    /// desktop session goes through `gate`, so the registry sessions and
    /// subscriptions it ends are revoked within the same command. The
    /// recording commands use the same gate.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn with_gate(gate: Arc<RecordingGate>) -> Self {
        Self(Ok(DesktopAuth::with_gate(gate)))
    }

    pub fn unavailable(reason: &'static str) -> Self {
        Self(Err(reason))
    }

    fn get(&self) -> Result<&DesktopAuth, CommandError> {
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
