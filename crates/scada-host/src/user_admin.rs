//! User management and the auth settings (host-gate design §4, §6;
//! implementation order §9 step 4-3-3-1): the bodies shared by
//! [`RecordingGate`](crate::recording_gate::RecordingGate) and a host without
//! one ([`DesktopAuth`](crate::desktop_auth::DesktopAuth)).
//!
//! Every function here runs under the transition lock the caller holds
//! ([`AuthHost::gate`](crate::auth_phase::AuthHost::gate)), so the checks it
//! makes (role, quiescence) and the change it saves are of one state. The
//! caller re-validates the desktop session afterwards, so a session the
//! change ended is ended before the command returns (§5).
//!
//! `holds` answers whether the registry holds unsettled work of a principal
//! (`RecordingRegistryRoot::quiescence().holds`). A host without a registry
//! passes `|_| false`: there is nothing to strand.
use banto_admin_services::settings::AuthSettings;
use banto_admin_services::users::{UserIdentity, UserSummary};
use scada_runtime::recording_registry::RecordingPrincipal;
use serde_json::json;

use crate::auth::{DesktopSession, HostAuth, Role};
use crate::recording_gate::AuthChangeError;

/// `users_list` (Admin).
pub(crate) async fn list_users(auth: &HostAuth) -> Result<Vec<UserSummary>, AuthChangeError> {
    auth.require_role(Role::Admin, "users").await?;
    Ok(auth.users().list_users().await?)
}

/// `users_create` (Admin). A new account ends no session.
pub(crate) async fn create_user(
    auth: &HostAuth,
    username: &str,
    password: &str,
    display_name: &str,
    role: Role,
) -> Result<UserIdentity, AuthChangeError> {
    let actor = auth.require_role(Role::Admin, "users").await?;
    let created = auth
        .users()
        .create_user(username, password, display_name, role)
        .await?;
    auth.record_ok(
        actor.session.identity(),
        "create",
        "users",
        Some(&created.id.to_string()),
        Some(json!({"username": created.username, "role": created.role.as_str()})),
    )
    .await;
    Ok(created)
}

/// `users_update` (Admin): an account's display name and role. Demoting an
/// Admin is `Busy` while the registry holds unsettled work of that user's
/// principal (§4).
pub(crate) async fn update_user(
    auth: &HostAuth,
    id: i64,
    display_name: &str,
    role: Role,
    holds: impl Fn(&RecordingPrincipal) -> bool,
) -> Result<UserSummary, AuthChangeError> {
    let actor = auth.require_role(Role::Admin, "users").await?;
    let users = auth.users();
    let target = users
        .list_users()
        .await?
        .into_iter()
        .find(|user| user.id == id);
    let demotes = target.is_some_and(|user| user.role == Role::Admin && role != Role::Admin);
    if demotes && holds(&RecordingPrincipal::banto_user(id)) {
        return Err(AuthChangeError::Busy);
    }
    let updated = users.update_user(id, display_name, role).await?;
    auth.record_ok(
        actor.session.identity(),
        "update",
        "users",
        Some(&id.to_string()),
        Some(json!({"role": role.as_str()})),
    )
    .await;
    Ok(updated)
}

/// `users_reset_password` (Admin): another account's (or the caller's own)
/// password, without the current one. Banto advances the account's
/// `auth_epoch`, which ends its sessions. Never `Busy`: the principal stays
/// the same account, so after logging in with the new password it reaches
/// its workflow again.
pub(crate) async fn reset_password(
    auth: &HostAuth,
    id: i64,
    new_password: &str,
) -> Result<(), AuthChangeError> {
    let actor = auth.require_role(Role::Admin, "users").await?;
    auth.users().reset_password(id, new_password).await?;
    auth.record_ok(
        actor.session.identity(),
        "password_reset",
        "users",
        Some(&id.to_string()),
        None,
    )
    .await;
    Ok(())
}

/// `users_delete` (Admin). `Busy` while the registry holds unsettled work of
/// that user's principal (§4). Banto refuses the last Admin and the caller's
/// own account.
pub(crate) async fn delete_user(
    auth: &HostAuth,
    id: i64,
    holds: impl Fn(&RecordingPrincipal) -> bool,
) -> Result<(), AuthChangeError> {
    let actor = auth.require_role(Role::Admin, "users").await?;
    if holds(&RecordingPrincipal::banto_user(id)) {
        return Err(AuthChangeError::Busy);
    }
    // The synthetic session has no row of its own (Banto's `None`).
    let acting = match &actor.session {
        DesktopSession::Account(identity) => Some(identity.id),
        DesktopSession::AuthDisabledLocal(_) => None,
    };
    auth.users().delete_user(id, acting).await?;
    auth.record_ok(
        actor.session.identity(),
        "delete",
        "users",
        Some(&id.to_string()),
        None,
    )
    .await;
    Ok(())
}

/// `auth_config_get` (Viewer or above, Banto's): it only feeds the settings
/// screen and carries no secret.
pub(crate) async fn auth_config(auth: &HostAuth) -> Result<AuthSettings, AuthChangeError> {
    auth.require_role(Role::Viewer, "settings").await?;
    Ok(auth.settings().auth_config().await?)
}

/// `auth_config_apply`: save the auth-mode settings.
///
/// - **Who**: Admin. While auth-disabled mode is on, any role (Banto's
///   escape hatch): the synthetic session is the only one then, and with a
///   lowered `disabled_role` it could otherwise never raise it again, nor
///   make the move to operation, which needs the synthetic Admin (§6).
/// - **The mode** is not switched here (`NotAllowed`): it goes off only by
///   the move to operation and never back on (§6).
/// - **Lowering `disabled_role`** below Admin is `Busy` while the registry
///   holds unsettled work of the synthetic principal (§4).
///
/// The other settings (autologin, which this host does not offer) are kept
/// as saved. Returns the saved settings.
pub(crate) async fn set_auth_config(
    auth: &HostAuth,
    disabled: bool,
    disabled_role: Role,
    holds: impl Fn(&RecordingPrincipal) -> bool,
) -> Result<AuthSettings, AuthChangeError> {
    let saved = auth.settings().auth_config().await?;
    let config = AuthSettings {
        disabled,
        disabled_role,
        ..saved.clone()
    };
    let min = if saved.disabled {
        Role::Viewer
    } else {
        Role::Admin
    };
    let actor = auth.require_role(min, "settings").await?;
    if config.disabled != saved.disabled {
        return Err(AuthChangeError::NotAllowed);
    }
    let demotes =
        saved.disabled && saved.disabled_role == Role::Admin && config.disabled_role != Role::Admin;
    if demotes && holds(&RecordingPrincipal::auth_disabled_local()) {
        return Err(AuthChangeError::Busy);
    }
    auth.settings().set_auth_config(&config).await?;
    auth.record_ok(
        actor.session.identity(),
        "update",
        "auth_config",
        None,
        Some(json!({"disabledRole": config.disabled_role.as_str()})),
    )
    .await;
    Ok(config)
}
