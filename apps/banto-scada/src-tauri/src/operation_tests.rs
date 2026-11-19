//! The operation write command (operation stage-3 design §4, §9; O2b-2b)
//! through the IPC of a mock app: the Runtime window's requests are checked
//! and recorded in `operations.db` of the data dir, and nothing is sent (no
//! write contract and no write key in the product). The checks themselves
//! are tested in `scada_host::operation_write`.
use crate::app_mode::AppMode;
use crate::mode_tests::{app, invoke, runtime_mode, TempDir};
use crate::operation::{OperationState, OPERATIONS_DB};
use scada_host::operation_db::{Outcome, RecordState};
use serde_json::{json, Value};
use tauri::Manager;

const SCREEN: &str = "0199d301-0000-7000-8000-000000000001";
const PLACEMENT: &str = "0199d301-0000-7000-8000-000000000047";
const PUMP: &str = "0199d301-0000-7000-8000-000000000022";
const COMMAND_TAG: &str = "WWT.P101.Command";

/// The demo Project with a `command` write slot (bool buttons) on the pump
/// type, bound on the first pump.
fn project_bytes() -> Vec<u8> {
    let mut doc: Value =
        serde_json::from_str(include_str!("../../../../examples/demo-water.project.json")).unwrap();
    let pump_type = doc["equipment"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == PUMP)
        .unwrap()["typeId"]
        .clone();
    doc["equipmentTypes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|kind| kind["id"] == pump_type)
        .unwrap()["slots"]
        .as_array_mut()
        .unwrap()
        .push(
            json!({"name": "command", "type": "bool", "direction": "read",
            "write": {"label": "運転指令", "buttons": [
                {"label": "運転", "value": true}, {"label": "停止", "value": false}]}}),
        );
    doc["equipment"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|item| item["id"] == PUMP)
        .unwrap()["bindings"]
        .as_array_mut()
        .unwrap()
        .push(json!({"slotName": "command", "externalName": COMMAND_TAG}));
    serde_json::to_vec_pretty(&doc).unwrap()
}

/// Writes the startup file and returns the request of the `運転` button.
fn startup(mode: &AppMode) -> Value {
    let AppMode::Runtime { project_path } = mode else {
        unreachable!()
    };
    let bytes = project_bytes();
    std::fs::write(project_path, &bytes).unwrap();
    let doc: Value = serde_json::from_slice(&bytes).unwrap();
    json!({
        "projectId": doc["manifest"]["projectId"],
        "projectDigest": scada_host::alarm_project::file_hash(&bytes),
        "screenId": SCREEN,
        "objectId": PLACEMENT,
        "equipmentId": PUMP,
        "slotName": "command",
        "buttonIndex": 0,
        "expectedValue": true,
    })
}

fn latest(app: &tauri::App<tauri::test::MockRuntime>, request: &Value) -> RecordState {
    let log = app.state::<OperationState>().log().unwrap();
    let (row, state) = tauri::async_runtime::block_on(log.latest(
        request["projectId"].as_str().unwrap(),
        PUMP,
        "command",
    ))
    .unwrap()
    .expect("a recorded row");
    assert_eq!(row.request.slot, "command");
    state
}

/// No saved Hub: the request passes the mode, the phase and the Project and
/// stops at the catalog. The refusal is recorded; nothing is sent.
#[test]
fn a_runtime_write_without_a_hub_is_refused_and_recorded() {
    let dir = TempDir::new();
    let mode = runtime_mode(&dir);
    let request = startup(&mode);
    let (app, webview) = app(&dir, mode, "runtime");
    assert!(dir.0.join(OPERATIONS_DB).is_file());

    let result = invoke(&webview, "operation_write", json!({"request": request})).unwrap();
    assert_eq!(result["outcome"], "refused", "{result}");
    assert_eq!(result["reason"], "catalog_unavailable", "{result}");
    assert_eq!(result["tag"], COMMAND_TAG);
    assert_eq!(result["value"], json!(true));
    assert_eq!(result["unrecorded"], false);
    assert!(result["recordId"].is_string(), "{result}");
    let RecordState::Finished(finish) = latest(&app, &request) else {
        panic!("not finished");
    };
    assert_eq!(finish.outcome, Outcome::Refused);
    assert_eq!(finish.reason.as_deref(), Some("catalog_unavailable"));
}

/// The Project the webview confirmed against is not the startup file.
#[test]
fn a_write_against_another_digest_is_project_changed() {
    let dir = TempDir::new();
    let mode = runtime_mode(&dir);
    let mut request = startup(&mode);
    request["projectDigest"] = json!("0".repeat(64));
    let (app, webview) = app(&dir, mode, "runtime");

    let result = invoke(&webview, "operation_write", json!({"request": request})).unwrap();
    assert_eq!(result["reason"], "project_changed", "{result}");
    assert!(result["recordId"].is_string());
    assert!(matches!(latest(&app, &request), RecordState::Finished(_)));
}

/// A startup file that could not be read: there is no applied Project.
#[test]
fn a_write_without_a_startup_project_is_project_changed() {
    let dir = TempDir::new();
    let mode = runtime_mode(&dir);
    let request = startup(&mode);
    let AppMode::Runtime { project_path } = &mode else {
        unreachable!()
    };
    std::fs::write(project_path, b"{not json").unwrap();
    let (app, webview) = app(&dir, mode, "runtime");

    let result = invoke(&webview, "operation_write", json!({"request": request})).unwrap();
    assert_eq!(result["outcome"], "refused");
    assert_eq!(result["reason"], "project_changed", "{result}");
    assert_eq!(result["unrecorded"], false);
    assert!(matches!(latest(&app, &request), RecordState::Finished(_)));
}

/// A malformed request is refused without a record (§4-1); one that does
/// not deserialize is the IPC's error.
#[test]
fn a_malformed_request_is_not_recorded() {
    let dir = TempDir::new();
    let mode = runtime_mode(&dir);
    let mut request = startup(&mode);
    request["objectId"] = json!("");
    let (app, webview) = app(&dir, mode, "runtime");

    let result = invoke(&webview, "operation_write", json!({"request": request})).unwrap();
    assert_eq!(result["reason"], "invalid_request", "{result}");
    assert_eq!(result["recordId"], Value::Null);
    let log = app.state::<OperationState>().log().unwrap();
    assert!(tauri::async_runtime::block_on(log.latest(
        request["projectId"].as_str().unwrap(),
        PUMP,
        "command"
    ))
    .unwrap()
    .is_none());
    assert!(invoke(
        &webview,
        "operation_write",
        json!({"request": {"extra": 1}})
    )
    .is_err());
}

/// The record could not be opened: nothing can be recorded, so nothing is
/// sent, and the screen is told so.
#[test]
fn a_write_without_the_record_is_record_failed_and_unrecorded() {
    let dir = TempDir::new();
    let mode = runtime_mode(&dir);
    let request = startup(&mode);
    let (app, webview) = app(&dir, mode, "runtime");
    tauri::async_runtime::block_on(app.state::<OperationState>().close());

    let result = invoke(&webview, "operation_write", json!({"request": request})).unwrap();
    assert_eq!(result["outcome"], "refused");
    assert_eq!(result["reason"], "record_failed", "{result}");
    assert_eq!(result["unrecorded"], true);
    assert_eq!(result["recordId"], Value::Null);
}

/// Editor mode opens no record and refuses the command by mode.
#[test]
fn editor_mode_opens_no_record() {
    let dir = TempDir::new();
    let request = startup(&runtime_mode(&dir));
    let (_app, webview) = app(&dir, AppMode::Editor, "editor");
    assert!(!dir.0.join(OPERATIONS_DB).exists());
    assert_eq!(
        invoke(&webview, "operation_write", json!({"request": request})),
        Err(json!("runtimeOnly"))
    );
}
