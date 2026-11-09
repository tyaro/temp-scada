//! The history commands of the desktop host (product-owner design §7.1): the
//! HistoryContext v2 of the applied plan, and one H1 query at a time through
//! the History host. Reading history needs no sign-in, like the Hub reads.
use scada_host::recording_runtime::RecordingRuntime;
use scada_model::Project;
use serde_json::Value;
use tauri::State;

/// The HistoryContext v2 for the Project, or `null` when the recording DB has
/// no applied plan for its recording plan (the UI then shows History offline).
/// Errors: `invalid_project`, or why the recording DB is unavailable.
#[tauri::command]
pub fn history_context(
    runtime: State<'_, RecordingRuntime>,
    project_json: String,
) -> Result<Option<Value>, String> {
    let project = Project::from_json(&project_json).map_err(|_| "invalid_project".to_owned())?;
    runtime
        .history_context(&project)
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
