//! The history commands of the desktop host (product-owner design §7.1): the
//! HistoryContext v3 of the applied plan (with each series' live mapping,
//! historian-live-trend §1.3), and one H1 query at a time through
//! the History host. Reading history needs no sign-in, like the Hub reads.
use crate::app_mode::AppMode;
use crate::runtime::StartupProject;
use scada_host::live_trend::{LivePump, LIVE_TREND_EVENT};
use scada_host::recording_runtime::RecordingRuntime;
use scada_model::Project;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, EventTarget, Runtime, State, Webview};

/// The HistoryContext v3 for the Project, or `null` when the recording DB has
/// no applied plan for its recording plan (the UI then shows History offline).
/// Each series has `live` (segment, value type, unit, period) while the
/// recorder records the applied plan, or `liveUnavailable: recorderStopped`;
/// never the Hub endpoint, credentials, SDK run or activation pin.
/// Errors: `invalid_project`, or why the recording DB is unavailable.
#[tauri::command]
pub fn history_context(
    mode: State<'_, AppMode>,
    runtime: State<'_, RecordingRuntime>,
    project_json: String,
) -> Result<Option<Value>, String> {
    mode.require_editor()?;
    let project = Project::from_json(&project_json).map_err(|_| "invalid_project".to_owned())?;
    runtime
        .history_context(&project)
        .map_err(|reason| reason.to_owned())
}

/// `runtime_history_context`: `history_context` for the startup Project.
/// Errors: `projectUnavailable`, or why the recording DB is unavailable.
#[tauri::command]
pub fn runtime_history_context(
    mode: State<'_, AppMode>,
    startup: State<'_, StartupProject>,
    runtime: State<'_, RecordingRuntime>,
) -> Result<Option<Value>, String> {
    mode.require_runtime()?;
    runtime
        .history_context(startup.project()?)
        .map_err(|reason| reason.to_owned())
}

/// One H1 query. `callId` names it for `history_cancel`; it is the caller's
/// own ID, not the query's `requestId`. Errors: `unavailable`, `busy`,
/// `cancelled`, `deadline`, `tooManyPoints`, `invalidRequest`, `failed`.
#[tauri::command]
pub async fn history_query(
    runtime: State<'_, RecordingRuntime>,
    call_id: String,
    query: Value,
) -> Result<Value, String> {
    runtime
        .history_query(&call_id, query)
        .await
        .map_err(|failure| failure.as_str().to_owned())
}

/// Asks the query `callId` to stop; its `history_query` settles once the
/// reader is back.
#[tauri::command]
pub fn history_cancel(runtime: State<'_, RecordingRuntime>, call_id: String) {
    runtime.history_cancel(&call_id);
}

/// Subscribes the live delivery of the Project's series (historian-live-trend
/// §3.2): each committed tick of the recorder, as a batch, and break marks,
/// emitted as `scada:live-trend` to the calling webview until
/// `history_live_stop`, a later start (which replaces it), or a failed emit.
/// `request`: `{contextId, historianNamespace, seriesIds}` of the
/// HistoryContext. Returns `{subscriptionId}`. Errors: `invalid_project`,
/// why the recording DB is unavailable, `noContext`, `staleContext` (read
/// the context again), `invalidRequest`.
#[tauri::command]
pub fn history_live_start<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    mode: State<'_, AppMode>,
    runtime: State<'_, RecordingRuntime>,
    project_json: String,
    request: Value,
) -> Result<Value, String> {
    mode.require_editor()?;
    let project = Project::from_json(&project_json).map_err(|_| "invalid_project".to_owned())?;
    let pump = runtime.live_start(&project, &request)?;
    Ok(spawn_pump(app, &webview, pump))
}

/// `runtime_history_live_start`: `history_live_start` for the startup
/// Project. Errors: `projectUnavailable`, and those of `history_live_start`.
#[tauri::command]
pub fn runtime_history_live_start<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    mode: State<'_, AppMode>,
    startup: State<'_, StartupProject>,
    runtime: State<'_, RecordingRuntime>,
    request: Value,
) -> Result<Value, String> {
    mode.require_runtime()?;
    let pump = runtime.live_start(startup.project()?, &request)?;
    Ok(spawn_pump(app, &webview, pump))
}

/// Ends the live subscription `subscriptionId`; a replaced or ended one is
/// left as it is.
#[tauri::command]
pub fn history_live_stop(runtime: State<'_, RecordingRuntime>, subscription_id: String) {
    runtime.live_stop(&subscription_id);
}

fn spawn_pump<R: Runtime>(app: AppHandle<R>, webview: &Webview<R>, pump: LivePump) -> Value {
    let reply = json!({"subscriptionId": pump.subscription_id()});
    // The webview only: `labeled` would also reach the listeners of the
    // window and webview window of the same label.
    let target = EventTarget::webview(webview.label());
    tauri::async_runtime::spawn(
        pump.run(move |event| app.emit_to(target.clone(), LIVE_TREND_EVENT, event).is_ok()),
    );
    reply
}
