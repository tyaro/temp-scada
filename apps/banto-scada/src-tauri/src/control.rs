//! The recording control commands of the desktop host (product-owner design
//! §5): the management context and inspection, and the first setup and
//! start. Thin adapters only: the behavior is `scada_host::recording_control`,
//! tested there with plain `cargo test`.
use crate::auth::AuthState;
use crate::NativeHost;
use scada_host::recording_control::{self, ControlError};
use scada_host::recording_runtime::RecordingRuntime;
use scada_model::Project;
use serde_json::Value;
use tauri::State;

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
