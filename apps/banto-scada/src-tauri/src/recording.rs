//! The recording registry commands and subscription events (host-gate design
//! §5; implementation order §9 step 4-3-2). Thin adapters only: the behavior
//! is `scada_host::desktop_recording`, tested there with plain `cargo test`.
//!
//! Each command takes the wire request JSON alone (`request`), plus the stage
//! and operation ID for `recording_workflow_lease`, and answers
//! `{"seq", "reply"}` or `{"kind": ...}`. A new subscription of
//! `recording_attach` delivers its frames as `scada:recording` events.
//! Without a recording owner (the product host until C5), every command
//! answers `{"kind": "recordingUnavailable", "reason": ...}`.
use scada_host::desktop_recording::{
    DesktopRecording, RecordingCommandError, RecordingResult, RECORDING_EVENT,
};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime, State};

type Reply = Result<RecordingResult, RecordingCommandError>;

#[tauri::command]
pub async fn recording_workflow_reserve(
    state: State<'_, DesktopRecording>,
    request: Value,
) -> Reply {
    state.workflow_reserve(request).await
}

#[tauri::command]
pub async fn recording_workflow_lease(
    state: State<'_, DesktopRecording>,
    stage: String,
    operation_id: Option<String>,
    request: Value,
) -> Reply {
    state.workflow_lease(&stage, operation_id, request).await
}

#[tauri::command]
pub async fn recording_lease(state: State<'_, DesktopRecording>, request: Value) -> Reply {
    state.lease(request).await
}

#[tauri::command]
pub async fn recording_admission(state: State<'_, DesktopRecording>, request: Value) -> Reply {
    state.admission(request).await
}

#[tauri::command]
pub async fn recording_admission_inspection(
    state: State<'_, DesktopRecording>,
    request: Value,
) -> Reply {
    state.admission_inspection(request).await
}

#[tauri::command]
pub async fn recording_observation(state: State<'_, DesktopRecording>, request: Value) -> Reply {
    state.observation(request).await
}

#[tauri::command]
pub async fn recording_cancel(state: State<'_, DesktopRecording>, request: Value) -> Reply {
    state.cancel(request).await
}

#[tauri::command]
pub async fn recording_call_inspection(
    state: State<'_, DesktopRecording>,
    request: Value,
) -> Reply {
    state.call_inspection(request).await
}

/// A new subscription's frames are emitted as `scada:recording` until it
/// ends or the app is gone.
#[tauri::command]
pub async fn recording_attach<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DesktopRecording>,
    request: Value,
) -> Reply {
    let (result, pump) = state.attach(request).await?;
    if let Some(pump) = pump {
        tauri::async_runtime::spawn(
            pump.run(move |event| app.emit(RECORDING_EVENT, event).is_ok()),
        );
    }
    Ok(result)
}

#[tauri::command]
pub async fn recording_control(state: State<'_, DesktopRecording>, request: Value) -> Reply {
    state.control(request).await
}
