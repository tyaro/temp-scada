//! The recording registry commands and subscription events (host-gate design
//! §5; implementation order §9 step 4-3-2). Thin adapters only: the behavior
//! is `scada_host::desktop_recording`, tested there with plain `cargo test`.
//!
//! Each command takes the wire request JSON alone (`request`), plus the stage
//! and operation ID for `recording_workflow_lease`, and answers
//! `{"seq", "reply"}` or `{"kind": ...}`. A new subscription of
//! `recording_attach` delivers its frames as `scada:recording` events to the
//! webview that attached it, until that webview starts loading another page
//! or is destroyed ([`Pages`]); the subscription is then ended as well.
//! Without a recording owner (the product host until C5), every command
//! answers `{"kind": "recordingUnavailable", "reason": ...}`.
use scada_host::desktop_recording::{
    DesktopRecording, RecordingCommandError, RecordingResult, RECORDING_EVENT,
};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime, State, Webview};
use tokio::sync::watch;

/// The current page of each webview, by label. An event emitted with no
/// listener still succeeds, so a pump cannot tell a reloaded or closed
/// webview from its emits: the page load and destroy hooks end the page
/// instead, which stops every pump it started and ends their subscriptions.
/// Each page gets its own ID, so a subscription attached again from the
/// next page of the same webview is taken over at once.
#[derive(Default)]
pub struct Pages(Mutex<PageTable>);

#[derive(Default)]
struct PageTable {
    next: u64,
    current: HashMap<String, Page>,
}

struct Page {
    id: u64,
    ended: watch::Sender<()>,
}

impl Pages {
    /// The current page of `label`, and a future that completes when it
    /// ends. A new page is opened in `recording` under this lock, so its
    /// begin and end are never reordered.
    fn current(
        &self,
        label: &str,
        recording: &DesktopRecording,
    ) -> (u64, impl Future<Output = ()> + Send + 'static) {
        let mut table = self.0.lock().expect("pages mutex poisoned");
        let PageTable { next, current } = &mut *table;
        let page = current.entry(label.to_owned()).or_insert_with(|| {
            *next += 1;
            recording.begin_page(*next);
            Page {
                id: *next,
                ended: watch::channel(()).0,
            }
        });
        let mut receiver = page.ended.subscribe();
        (page.id, async move {
            // Only the sender's drop ends it: nothing is ever sent.
            while receiver.changed().await.is_ok() {}
        })
    }

    /// End the current page of `label`, in `recording` too, under the same
    /// lock as [`Self::current`].
    fn end(&self, label: &str, recording: &DesktopRecording) {
        let mut table = self.0.lock().expect("pages mutex poisoned");
        if let Some(page) = table.current.remove(label) {
            recording.end_page(page.id);
        }
    }
}

/// The page of `label` ended (a new page load, or the webview destroyed):
/// its pumps stop and its subscriptions are ended, before the next page can
/// attach. Called by the page hooks of `commands`.
pub fn end_page<R: Runtime, M: Manager<R>>(manager: &M, label: &str) {
    manager
        .state::<Pages>()
        .end(label, &manager.state::<DesktopRecording>());
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
    let (page, ended) = pages.current(&label, &state);
    let (result, pump) = state.attach(request, page).await?;
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
