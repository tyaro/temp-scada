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

/// The faceplate's operation rows (`operation_view`, O3a): the product build
/// is blocked by the Hub contract, and a recorded refusal is the slot's last
/// request.
#[test]
fn the_view_lists_the_write_slots_and_is_blocked_by_the_hub_contract() {
    let dir = TempDir::new();
    let mode = runtime_mode(&dir);
    let request = startup(&mode);
    let (_app, webview) = app(&dir, mode, "runtime");
    let view_request = json!({"request": {"equipmentId": PUMP}});

    let view = invoke(&webview, "operation_view", view_request.clone()).unwrap();
    assert_eq!(view["projectId"], request["projectId"], "{view}");
    assert_eq!(view["projectDigest"], request["projectDigest"]);
    assert_eq!(view["blocked"], "hub_unsupported");
    assert_eq!(view["phase"], "initializing");
    assert_eq!(
        view["slots"],
        json!([{"slot": "command", "latest": null}]),
        "{view}"
    );

    invoke(&webview, "operation_write", json!({"request": request})).unwrap();
    let view = invoke(&webview, "operation_view", view_request).unwrap();
    let latest = &view["slots"][0]["latest"];
    assert_eq!(latest["state"], "finished", "{view}");
    assert_eq!(latest["outcome"], "refused");
    assert_eq!(latest["reason"], "catalog_unavailable");
    assert_eq!(latest["tag"], COMMAND_TAG);
    assert_eq!(latest["value"], json!(true));
    assert_eq!(latest["auditId"], Value::Null);
}

/// The id is the only argument; an equipment the applied Project does not
/// have is an error, not a record.
#[test]
fn the_view_of_an_unknown_equipment_is_an_error() {
    let dir = TempDir::new();
    let mode = runtime_mode(&dir);
    startup(&mode);
    let (_app, webview) = app(&dir, mode, "runtime");
    assert_eq!(
        invoke(
            &webview,
            "operation_view",
            json!({"request": {"equipmentId": "nope"}})
        ),
        Err(json!("unknown_equipment"))
    );
    assert_eq!(
        invoke(
            &webview,
            "operation_view",
            json!({"request": {"equipmentId": ""}})
        ),
        Err(json!("invalid_request"))
    );
    assert!(invoke(
        &webview,
        "operation_view",
        json!({"request": {"equipmentId": PUMP, "projectId": "p"}})
    )
    .is_err());
}

/// No applied Project: nothing to list, and a write would be
/// `project_changed`. A record that is not open is `record_failed`.
#[test]
fn the_view_without_a_project_or_a_record_says_why() {
    let dir = TempDir::new();
    let mode = runtime_mode(&dir);
    startup(&mode);
    let AppMode::Runtime { project_path } = &mode else {
        unreachable!()
    };
    std::fs::write(project_path, b"{not json").unwrap();
    let (app, webview) = app(&dir, mode, "runtime");
    let view_request = json!({"request": {"equipmentId": PUMP}});

    let view = invoke(&webview, "operation_view", view_request.clone()).unwrap();
    assert_eq!(view["blocked"], "project_changed", "{view}");
    assert_eq!(view["projectId"], Value::Null);
    assert_eq!(view["slots"], json!([]));

    tauri::async_runtime::block_on(app.state::<OperationState>().close());
    let view = invoke(&webview, "operation_view", view_request).unwrap();
    assert_eq!(view["blocked"], "record_failed", "{view}");
}

/// Editor mode refuses the view by mode.
#[test]
fn editor_mode_refuses_the_view() {
    let dir = TempDir::new();
    let (_app, webview) = app(&dir, AppMode::Editor, "editor");
    assert_eq!(
        invoke(
            &webview,
            "operation_view",
            json!({"request": {"equipmentId": PUMP}})
        ),
        Err(json!("runtimeOnly"))
    );
}

/// The operation history (`operation_history`, O4b): the applied Project's
/// rows newest first, narrowed by the request (Editor mode refuses it by
/// mode, `mode_tests`).
#[test]
fn the_history_lists_the_recorded_requests_of_the_applied_project() {
    let dir = TempDir::new();
    let mode = runtime_mode(&dir);
    let request = startup(&mode);
    let (_app, webview) = app(&dir, mode, "runtime");

    let history = invoke(&webview, "operation_history", json!({"request": {}})).unwrap();
    assert_eq!(history["projectId"], request["projectId"], "{history}");
    assert_eq!(history["rows"], json!([]));
    assert_eq!(history["nextBeforeSeq"], Value::Null);

    invoke(&webview, "operation_write", json!({"request": request})).unwrap();
    let history = invoke(&webview, "operation_history", json!({"request": {}})).unwrap();
    let row = &history["rows"][0];
    assert_eq!(row["state"], "finished", "{history}");
    assert_eq!(row["outcome"], "refused");
    assert_eq!(row["reason"], "catalog_unavailable");
    assert_eq!(row["equipmentId"], PUMP);
    assert_eq!(row["slot"], "command");
    assert_eq!(row["repeatCount"], 1);

    let narrowed = json!({"request": {"equipmentId": "other", "outcomes": ["ok"]}});
    let history = invoke(&webview, "operation_history", narrowed).unwrap();
    assert_eq!(history["rows"], json!([]), "{history}");
    assert_eq!(
        invoke(
            &webview,
            "operation_history",
            json!({"request": {"limit": 0}})
        ),
        Err(json!("invalid_request"))
    );
}

/// The terminal settings' commands (§7, O2c-3b-2): the status answers the
/// state and no secret; in development / initial setup the local Admin
/// needs no login. With no saved Hub there is no endpoint to pair a key
/// with (`no_hub`), and nothing is written to the keyring or the record.
#[test]
fn the_write_key_commands_work_login_free_before_operation() {
    let dir = TempDir::new();
    let mode = runtime_mode(&dir);
    startup(&mode);
    let (_app, webview) = app(&dir, mode, "runtime");

    let status = invoke(&webview, "operation_key_status", json!({})).unwrap();
    assert_eq!(
        status,
        json!({"keyEndpoint": null, "hubEndpoint": null,
            "write": {"state": "ready", "changedAtMs": null},
            "minIntervalMs": 1_000,
            "retention": {"days": 365, "count": 100_000}})
    );
    // The record size is its own command, not part of the polled status.
    assert_eq!(
        invoke(&webview, "operation_record_size", json!({})).unwrap(),
        json!({"rowCount": 0, "oldestRequestedAtMs": null})
    );
    assert_eq!(
        invoke(
            &webview,
            "operation_key_register",
            json!({"secret": "write-key"})
        ),
        Err(json!("no_hub"))
    );
    assert_eq!(
        invoke(&webview, "operation_key_status", json!({})).unwrap(),
        status
    );
    // Deleting no key and resuming a ready terminal change nothing.
    assert_eq!(
        invoke(&webview, "operation_key_delete", json!({})).unwrap(),
        status
    );
    assert_eq!(
        invoke(&webview, "operation_write_resume", json!({})).unwrap(),
        status
    );
    // The minimum interval (O2c-4b): out of the range or off its step is
    // refused and changes nothing; a valid one is answered and kept.
    for ms in [0, 99, 150, 60_100] {
        assert_eq!(
            invoke(
                &webview,
                "operation_min_interval_set",
                json!({"minIntervalMs": ms})
            ),
            Err(json!("invalid_interval")),
            "{ms}"
        );
    }
    let saved = invoke(
        &webview,
        "operation_min_interval_set",
        json!({"minIntervalMs": 2_500}),
    )
    .unwrap();
    assert_eq!(saved["minIntervalMs"], 2_500);
    assert_eq!(saved["write"], status["write"]);
    assert_eq!(
        invoke(&webview, "operation_key_status", json!({})).unwrap()["minIntervalMs"],
        2_500
    );
    // The retention (O4a): out of either range is refused and changes
    // nothing; a valid one is answered and kept with the interval.
    for (days, count) in [
        (0, 100_000),
        (3_651, 100_000),
        (365, 9_999),
        (365, 10_000_001),
        (-1, 100_000),
    ] {
        assert_eq!(
            invoke(
                &webview,
                "operation_retention_set",
                json!({"retentionDays": days, "retentionCount": count})
            ),
            Err(json!("invalid_retention")),
            "{days} {count}"
        );
    }
    let saved = invoke(
        &webview,
        "operation_retention_set",
        json!({"retentionDays": 30, "retentionCount": 20_000}),
    )
    .unwrap();
    assert_eq!(saved["retention"], json!({"days": 30, "count": 20_000}));
    assert_eq!(saved["minIntervalMs"], 2_500);
    assert_eq!(
        invoke(&webview, "operation_key_status", json!({})).unwrap()["retention"],
        json!({"days": 30, "count": 20_000})
    );
}

/// In operation, changing the key or resuming needs a logged-in Admin; the
/// status is still answered.
#[test]
fn the_write_key_commands_need_an_admin_in_operation() {
    let dir = TempDir::new();
    let mode = runtime_mode(&dir);
    startup(&mode);
    let (app, webview) = app(&dir, mode, "runtime");
    // The move is the Editor's command; the host's own call stands for it.
    let auth = app.state::<crate::auth::AuthState>();
    let host = auth.get().unwrap();
    tauri::async_runtime::block_on(async {
        host.transition_to_operational("chief", "Passw0rd!Passw0rd", "管理者")
            .await
            .unwrap();
        host.logout().await.unwrap();
    });
    assert_eq!(
        invoke(&webview, "auth_phase", json!({})).unwrap()["phase"],
        "operational"
    );
    for (command, args) in [
        ("operation_key_register", json!({"secret": "write-key"})),
        ("operation_key_delete", json!({})),
        ("operation_write_resume", json!({})),
        (
            "operation_min_interval_set",
            json!({"minIntervalMs": 2_000}),
        ),
        (
            "operation_retention_set",
            json!({"retentionDays": 30, "retentionCount": 20_000}),
        ),
    ] {
        assert_eq!(
            invoke(&webview, command, args),
            Err(json!("unauthorized")),
            "{command}"
        );
    }
    assert!(invoke(&webview, "operation_key_status", json!({})).is_ok());
    assert!(invoke(&webview, "operation_record_size", json!({})).is_ok());
}

/// The record could not be opened: the settings answer `record_failed`.
#[test]
fn the_write_key_commands_without_the_record_are_record_failed() {
    let dir = TempDir::new();
    let mode = runtime_mode(&dir);
    startup(&mode);
    let (app, webview) = app(&dir, mode, "runtime");
    tauri::async_runtime::block_on(app.state::<OperationState>().close());
    for (command, args) in [
        ("operation_key_status", json!({})),
        ("operation_record_size", json!({})),
        ("operation_key_register", json!({"secret": "write-key"})),
        ("operation_key_delete", json!({})),
        ("operation_write_resume", json!({})),
        (
            "operation_min_interval_set",
            json!({"minIntervalMs": 2_000}),
        ),
        (
            "operation_retention_set",
            json!({"retentionDays": 30, "retentionCount": 20_000}),
        ),
    ] {
        assert_eq!(
            invoke(&webview, command, args),
            Err(json!("record_failed")),
            "{command}"
        );
    }
}

/// #322 review: the Admin is checked after the wait for the key lock and
/// held until the change is done. A deletion that waits while the Admin
/// logs out is refused and changes nothing; one that waits while the
/// Admin stays logged in goes through (the control of the same path).
#[test]
fn a_key_change_waiting_while_the_admin_logs_out_changes_nothing() {
    for log_out in [true, false] {
        let dir = TempDir::new();
        let mode = runtime_mode(&dir);
        startup(&mode);
        let (app, webview) = app(&dir, mode, "runtime");
        let auth = app.state::<crate::auth::AuthState>();
        let host = auth.get().unwrap();
        let operations = app.state::<OperationState>();
        let log = operations.log().unwrap();
        let key = scada_host::operation_db::KeyRef {
            endpoint: "http://127.0.0.1:8722".into(),
            id: "registered".into(),
        };
        tauri::async_runtime::block_on(async {
            // The move signs the new Admin in.
            host.transition_to_operational("chief", "Passw0rd!Passw0rd", "管理者")
                .await
                .unwrap();
            log.key_registered(1_000, &key).await.unwrap();
        });
        let held = tauri::async_runtime::block_on(operations.hold_key_lock_for_test());
        let result = std::thread::scope(|scope| {
            let waiting = scope.spawn(|| invoke(&webview, "operation_key_delete", json!({})));
            // Let the deletion reach the key lock.
            std::thread::sleep(std::time::Duration::from_millis(300));
            if log_out {
                tauri::async_runtime::block_on(host.logout()).unwrap();
            }
            drop(held);
            waiting.join().unwrap()
        });
        if log_out {
            assert_eq!(result, Err(json!("unauthorized")));
            assert_eq!(log.key(), Some(key));
        } else {
            assert_eq!(result.unwrap()["keyEndpoint"], Value::Null);
            assert_eq!(log.key(), None);
        }
    }
}
