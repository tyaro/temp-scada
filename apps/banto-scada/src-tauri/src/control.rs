//! The recording control commands of the desktop host (product-owner design
//! §5): the management context, the inspection and the registry slot, the
//! first setup and start, the resume, the stopped reconfiguration, the
//! stop and the owner rebind; and the exit sequence (§6). Thin adapters
//! only: the behavior is `scada_host::recording_control`, tested there with
//! plain `cargo test`.
use crate::auth::AuthState;
use crate::NativeHost;
use scada_host::recording_control::{self, ControlError};
use scada_host::recording_runtime::{ExitOutcome, RecordingRuntime};
use scada_model::Project;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime, State};

fn project(project_json: &str) -> Result<Project, ControlError> {
    Project::from_json(project_json).map_err(|_| ControlError::Refused("invalid_project"))
}

/// The RecordingManagementContext v1 of this host for the Project (Viewer).
#[tauri::command]
pub async fn recording_context(
    auth: State<'_, AuthState>,
    runtime: State<'_, RecordingRuntime>,
    project_json: String,
) -> Result<Value, ControlError> {
    let project = project(&project_json)?;
    recording_control::context(auth.get()?, &runtime, &project).await
}

/// One RecordingInspectionResponse v1 for `request` (Viewer).
#[tauri::command]
pub async fn recording_status(
    auth: State<'_, AuthState>,
    runtime: State<'_, RecordingRuntime>,
    request: Value,
) -> Result<Value, ControlError> {
    recording_control::status(auth.get()?, &runtime, request).await
}

/// The first setup and start of the Project's recording plan (Admin). The
/// resolution and the recording each take a new client of the saved Hub;
/// neither is the read host's, and disconnecting the Hub does not stop the
/// recording (design §8-6).
#[tauri::command]
pub async fn recording_initial_setup(
    auth: State<'_, AuthState>,
    runtime: State<'_, RecordingRuntime>,
    native: State<'_, NativeHost>,
    project_json: String,
) -> Result<Value, ControlError> {
    let project = project(&project_json)?;
    let client = || native.bootstrap.rest_client().ok().flatten();
    let clients = client().zip(client());
    recording_control::initial_setup(auth.get()?, &runtime, &project, clients).await
}

/// Resume the plan the store has applied (Admin), after the registry's
/// apply or a restart: an installed root is handed off first, and the new
/// recording gets a new root. Like the first setup, the resolution and the
/// recording each take a new client of the saved Hub.
#[tauri::command]
pub async fn recording_resume(
    auth: State<'_, AuthState>,
    runtime: State<'_, RecordingRuntime>,
    native: State<'_, NativeHost>,
    project_json: String,
) -> Result<Value, ControlError> {
    let project = project(&project_json)?;
    let client = || native.bootstrap.rest_client().ok().flatten();
    let clients = client().zip(client());
    recording_control::resume(auth.get()?, &runtime, &project, clients).await
}

/// Apply the Project's recording plan while recording is stopped and no
/// root is installed (Admin). Never starts recording; the Hub is read only
/// when the plan's members need a new mapping.
#[tauri::command]
pub async fn recording_reconfigure(
    auth: State<'_, AuthState>,
    runtime: State<'_, RecordingRuntime>,
    native: State<'_, NativeHost>,
    project_json: String,
) -> Result<Value, ControlError> {
    let project = project(&project_json)?;
    let client = native.bootstrap.rest_client().ok().flatten();
    recording_control::reconfigure(auth.get()?, &runtime, &project, client).await
}

/// The registry slot (Viewer): `{"state": "installed", "generation",
/// "scope"}` or `{"state": "empty", "reason"}`.
#[tauri::command]
pub async fn recording_slot(
    auth: State<'_, AuthState>,
    runtime: State<'_, RecordingRuntime>,
) -> Result<Value, ControlError> {
    recording_control::slot(auth.get()?, &runtime).await
}

/// Stop the recording without changing the plan (Admin). An installed root
/// is handed off first; while it is unsettled the stop is `busy`.
#[tauri::command]
pub async fn recording_stop(
    auth: State<'_, AuthState>,
    runtime: State<'_, RecordingRuntime>,
) -> Result<Value, ControlError> {
    recording_control::stop(auth.get()?, &runtime).await
}

/// Give the running recording a new root whose operations context is the
/// Project's current ID and revision (Admin, design §7.2). The recording is
/// not stopped; an unsettled root is `busy`.
#[tauri::command]
pub async fn recording_owner_rebind(
    auth: State<'_, AuthState>,
    runtime: State<'_, RecordingRuntime>,
    project_json: String,
) -> Result<Value, ControlError> {
    let project = project(&project_json)?;
    recording_control::owner_rebind(auth.get()?, &runtime, &project).await
}

/// How long the exit waits for the recording to stop (design §8-3). Past
/// it the process exits and the next start finds the session interrupted.
pub const EXIT_LIMIT: Duration = Duration::from_secs(10);

/// The exit sequence of `app` (design §6): stop new registry work, hand the
/// root off and stop and join the recording, within [`EXIT_LIMIT`]. A host
/// whose auth did not start never started a recording.
pub async fn exit<R: Runtime>(app: &AppHandle<R>) -> Option<ExitOutcome> {
    let auth = app.state::<AuthState>();
    let runtime = app.state::<RecordingRuntime>();
    let auth = auth.get().ok()?;
    Some(recording_control::exit(auth, &runtime, EXIT_LIMIT).await)
}
