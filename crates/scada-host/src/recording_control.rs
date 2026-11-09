//! The host's recording control commands (product-owner design §5), outside
//! the recording registry: the management context and inspection (Viewer or
//! above) and the first setup and start (Admin, including the synthetic
//! Admin of auth-disabled mode). Each runs under the transition lock
//! ([`AuthHost::gate`](crate::auth_phase::AuthHost::gate)) after the role is
//! checked again, like user management. Tauri-independent: the commands of
//! `apps/banto-scada/src-tauri` call these and return the result unchanged.
//!
//! Errors are `{"kind": ...}`: Banto's auth errors (`unauthorized`,
//! `forbidden`, `auth_unavailable`) as the auth commands give them,
//! `{"kind": "recordingUnavailable", "reason"}` when the recording DB is not
//! open, `{"kind": "not_allowed"}` for control while the auth phase admits
//! no recording operation, and the [`SetupFailure`] / [`InspectFailure`]
//! codes otherwise.
use banto_tagclient::RestClient;
use scada_model::Project;
use serde::{Serialize, Serializer};
use serde_json::{json, Value};

use crate::auth::Role;
use crate::desktop_auth::{CommandError, DesktopAuth};
use crate::recording_runtime::{InspectFailure, RecordingRuntime, SetupFailure};

/// The audit resource of the recording control commands.
const RESOURCE: &str = "recording";

/// An error of a recording control command.
#[derive(Debug)]
pub enum ControlError {
    Auth(CommandError),
    /// `{"kind": "recordingUnavailable", "reason": ...}`.
    Unavailable(&'static str),
    /// `{"kind": ...}`.
    Refused(&'static str),
}

impl From<CommandError> for ControlError {
    fn from(error: CommandError) -> Self {
        Self::Auth(error)
    }
}

impl From<crate::auth::BantoError> for ControlError {
    fn from(error: crate::auth::BantoError) -> Self {
        Self::Auth(CommandError::Banto(error))
    }
}

impl Serialize for ControlError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Auth(error) => error.serialize(serializer),
            Self::Unavailable(reason) => {
                json!({"kind": "recordingUnavailable", "reason": reason}).serialize(serializer)
            }
            Self::Refused(kind) => json!({ "kind": kind }).serialize(serializer),
        }
    }
}

/// `recording_context(projectJson)` (Viewer): the RecordingManagementContext
/// of this process for the Project.
pub async fn context(
    auth: &DesktopAuth,
    runtime: &RecordingRuntime,
    project: &Project,
) -> Result<Value, ControlError> {
    let host = auth.auth();
    let _lock = host.gate().await;
    host.auth().require_role(Role::Viewer, RESOURCE).await?;
    runtime
        .management_context(project)
        .map_err(ControlError::Unavailable)
}

/// `recording_status(request)` (Viewer): one inspection response.
pub async fn status(
    auth: &DesktopAuth,
    runtime: &RecordingRuntime,
    request: Value,
) -> Result<Value, ControlError> {
    let host = auth.auth();
    let _lock = host.gate().await;
    host.auth().require_role(Role::Viewer, RESOURCE).await?;
    runtime
        .inspect(request)
        .await
        .map_err(|failure| match failure {
            InspectFailure::Unavailable => ControlError::Unavailable(
                runtime
                    .unavailable_reason()
                    .unwrap_or(crate::recording_runtime::STORE_UNAVAILABLE),
            ),
            failure => ControlError::Refused(failure.as_str()),
        })
}

/// `recording_initial_setup(projectJson)` (Admin): the first setup and
/// start of the Project's recording plan. `clients` are the Hub clients for
/// the resolution and the recording, `None` when no Hub is configured.
/// Answers the recording phase reached (`{"phase": "running" | "starting"}`).
/// Every accepted call is audited (`initial_setup`, ok or failed).
pub async fn initial_setup(
    auth: &DesktopAuth,
    runtime: &RecordingRuntime,
    project: &Project,
    clients: Option<(RestClient, RestClient)>,
) -> Result<Value, ControlError> {
    let host = auth.auth();
    let lock = host.gate().await;
    let actor = host.auth().require_role(Role::Admin, RESOURCE).await?;
    if !lock.phase().admits_registry() {
        return Err(ControlError::Refused("not_allowed"));
    }
    let result = match clients {
        None => Err(SetupFailure::HubNotConfigured),
        Some((resolve, record)) => runtime.initial_setup(project, resolve, record).await,
    };
    let identity = actor.session.identity();
    let plan_id = project.recording_plan_id();
    match result {
        Ok(phase) => {
            host.auth()
                .record_ok(
                    identity,
                    "initial_setup",
                    RESOURCE,
                    plan_id,
                    Some(json!({ "phase": phase })),
                )
                .await;
            Ok(json!({ "phase": phase }))
        }
        Err(failure) => {
            host.auth()
                .record(
                    identity,
                    "initial_setup",
                    RESOURCE,
                    plan_id,
                    Some(json!({ "error": failure.as_str() })),
                    "failed",
                )
                .await;
            Err(match failure {
                SetupFailure::Unavailable => ControlError::Unavailable(
                    runtime
                        .unavailable_reason()
                        .unwrap_or(crate::recording_runtime::STORE_UNAVAILABLE),
                ),
                failure => ControlError::Refused(failure.as_str()),
            })
        }
    }
}

#[cfg(test)]
mod tests;
