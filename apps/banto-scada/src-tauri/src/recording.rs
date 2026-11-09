//! The recording registry commands and subscription events (host-gate design
//! §5; implementation order §9 step 4-3-2). Thin adapters only: the behavior
//! is `scada_host::desktop_recording`, tested there with plain `cargo test`.
//!
//! Each command takes the wire request JSON alone (`request`), plus the stage
//! and operation ID for `recording_workflow_lease`, and answers
//! `{"seq", "reply"}` or `{"kind": ...}`. A new subscription of
//! `recording_attach` delivers its frames as `scada:recording` events to the
//! webview that attached it, until that webview starts loading another page
//! or is destroyed ([`Pages`]).
//! Without a recording owner (the product host until C5), every command
//! answers `{"kind": "recordingUnavailable", "reason": ...}`.
use scada_host::desktop_recording::{
    DesktopRecording, RecordingCommandError, RecordingResult, RECORDING_EVENT,
};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, EventTarget, Runtime, State, Webview};
use tokio::sync::watch;

/// The current page of each webview, by label. An event emitted with no
/// listener still succeeds, so a pump cannot tell a reloaded or closed
/// webview from its emits: the page load and destroy hooks end the page
/// instead, which stops every pump it started.
#[derive(Default)]
pub struct Pages(Mutex<HashMap<String, watch::Sender<()>>>);

impl Pages {
    /// Completes when the current page of `label` ends.
    fn ended(&self, label: &str) -> impl Future<Output = ()> + Send + 'static {
        let mut receiver = self
            .0
            .lock()
            .expect("pages mutex poisoned")
            .entry(label.to_owned())
            .or_insert_with(|| watch::channel(()).0)
            .subscribe();
        async move {
            // Only the sender's drop ends it: nothing is ever sent.
            while receiver.changed().await.is_ok() {}
        }
    }

    /// End the current page of `label` (a new page load, or the webview
    /// destroyed): its pumps stop and release their subscriptions.
    pub fn end(&self, label: &str) {
        self.0.lock().expect("pages mutex poisoned").remove(label);
    }
}

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

/// A new subscription's frames are emitted as `scada:recording` to the
/// attaching webview until the subscription ends or that page does.
#[tauri::command]
pub async fn recording_attach<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    state: State<'_, DesktopRecording>,
    pages: State<'_, Pages>,
    request: Value,
) -> Reply {
    let label = webview.label().to_owned();
    // Taken before the attach: a page that ends meanwhile stops the pump
    // at once rather than leaving it to the next page.
    let ended = pages.ended(&label);
    let (result, pump) = state.attach(request).await?;
    if let Some(pump) = pump {
        let target = EventTarget::labeled(label);
        tauri::async_runtime::spawn(pump.run(
            move |event| app.emit_to(target.clone(), RECORDING_EVENT, event).is_ok(),
            ended,
        ));
    }
    Ok(result)
}

#[tauri::command]
pub async fn recording_control(state: State<'_, DesktopRecording>, request: Value) -> Reply {
    state.control(request).await
}
