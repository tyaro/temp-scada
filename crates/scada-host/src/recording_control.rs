//! The host's recording control commands (product-owner design §5), outside
//! the recording registry: the management context, the inspection and the
//! slot (Viewer or above), and the first setup and start and the stop
//! (Admin, including the synthetic Admin of auth-disabled mode). Each runs under the transition lock
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
use crate::recording_gate::{CloseCheck, NO_RECORDING_RUN};
use crate::recording_runtime::{InspectFailure, RecordingRuntime, SetupFailure, StopFailure};

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
/// Answers the recording phase reached and whether the registry root was
/// installed over it (`{"phase": "running" | "starting", "owner":
/// "installed" | "owner_unavailable"}`): a recording that runs gets its root
/// in the same call, and one whose root cannot be installed keeps running
/// with the slot `owner_unavailable` (design §5). Every accepted call is
/// audited (`initial_setup`, ok or failed).
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
            let owner = match auth.recording_gate() {
                Some(gate) if phase == "running" => {
                    match runtime.install_owner(gate, &lock, project).await {
                        Ok(_) => "installed",
                        Err(reason) => reason,
                    }
                }
                Some(gate) => {
                    gate.set_empty_reason(&lock, crate::recording_gate::OWNER_UNAVAILABLE);
                    crate::recording_gate::OWNER_UNAVAILABLE
                }
                None => crate::recording_gate::OWNER_UNAVAILABLE,
            };
            let detail = json!({ "phase": phase, "owner": owner });
            host.auth()
                .record_ok(
                    identity,
                    "initial_setup",
                    RESOURCE,
                    plan_id,
                    Some(detail.clone()),
                )
                .await;
            Ok(detail)
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

/// `recording_slot` (Viewer): the registry slot (design §4), as
/// `{"state": "installed", "generation": n, "scope": <wire scope>}` or `{"state": "empty",
/// "reason": "no_recording_run" | "store_unavailable" | "owner_unavailable"}`.
pub async fn slot(auth: &DesktopAuth, runtime: &RecordingRuntime) -> Result<Value, ControlError> {
    let host = auth.auth();
    let _lock = host.gate().await;
    host.auth().require_role(Role::Viewer, RESOURCE).await?;
    Ok(match auth.recording_gate().map(|gate| gate.slot()) {
        Some(Ok(installed)) => json!({"state": "installed",
            "generation": installed.generation, "scope": installed.scope}),
        Some(Err(reason)) => json!({"state": "empty", "reason": reason}),
        None => json!({"state": "empty", "reason": runtime
            .unavailable_reason()
            .unwrap_or(NO_RECORDING_RUN)}),
    })
}

/// `recording_stop` (Admin): stop the recording without changing the plan
/// (design §5). An installed root is taken back by its handoff first; while
/// it holds unsettled work the stop is `busy` and nothing changes. Answers
/// `{"phase": "joined"}`. Every accepted call is audited (`stop`).
pub async fn stop(auth: &DesktopAuth, runtime: &RecordingRuntime) -> Result<Value, ControlError> {
    let host = auth.auth();
    let lock = host.gate().await;
    let actor = host.auth().require_role(Role::Admin, RESOURCE).await?;
    if !lock.phase().admits_registry() {
        return Err(ControlError::Refused("not_allowed"));
    }
    let Some(gate) = auth.recording_gate() else {
        return Err(ControlError::Unavailable(
            runtime.unavailable_reason().unwrap_or(NO_RECORDING_RUN),
        ));
    };
    let result = runtime.stop(gate, &lock).await;
    let identity = actor.session.identity();
    let (detail, outcome) = match &result {
        Ok(phase) => (json!({ "phase": phase }), "ok"),
        Err(failure) => (json!({ "error": failure.as_str() }), "failed"),
    };
    host.auth()
        .record(identity, "stop", RESOURCE, None, Some(detail), outcome)
        .await;
    match result {
        Ok(phase) => Ok(json!({ "phase": phase })),
        Err(StopFailure::Unavailable) => Err(ControlError::Unavailable(
            runtime
                .unavailable_reason()
                .unwrap_or(crate::recording_runtime::STORE_UNAVAILABLE),
        )),
        Err(failure) => Err(ControlError::Refused(failure.as_str())),
    }
}

/// What closing the window asks of the user first (design §6.1, the
/// confirmation dialog). No role is checked and no lock taken: the window
/// closes whoever is signed in, and the exit sequence decides again by
/// itself. A host whose auth did not start has no recording gate.
pub fn close_check(auth: Option<&DesktopAuth>) -> CloseCheck {
    auth.and_then(DesktopAuth::recording_gate)
        .map_or(CloseCheck::Close, |gate| gate.close_check())
}

/// The exit sequence (design §6) within `limit`, under the transition lock
/// so no registry or control command runs meanwhile. Without a recording
/// gate or store there is nothing to stop.
pub async fn exit(
    auth: &DesktopAuth,
    runtime: &RecordingRuntime,
    limit: std::time::Duration,
) -> crate::recording_runtime::ExitOutcome {
    let lock = auth.auth().gate().await;
    runtime
        .exit(auth.recording_gate().map(|gate| &**gate), &lock, limit)
        .await
}

#[cfg(test)]
mod tests;
