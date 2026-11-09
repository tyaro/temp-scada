//! The auth commands through the real IPC of a mock app: registration,
//! camelCase arguments, and Banto's result and error shapes (host-gate
//! design §5, §6). The behavior itself is tested in `scada_host::desktop_auth`.
use super::*;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::{InvokeRequest, WebviewWindow};
use tauri::{test::MockRuntime, App, WebviewWindowBuilder};

const PASSWORD: &str = "correct-horse-1";

/// A fresh app data dir under the OS temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "banto-scada-auth-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn app(auth: AuthState) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = commands(mock_builder())
        .manage(auth)
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (app, webview)
}

fn invoke(webview: &WebviewWindow<MockRuntime>, cmd: &str, args: Value) -> Result<Value, Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}

#[test]
fn the_auth_commands_answer_over_ipc_from_first_start_to_operation() {
    let dir = TempDir::new();
    let (_app, webview) =
        app(tauri::async_runtime::block_on(AuthState::start(&dir.0, "no_recording_run")).0);

    assert_eq!(
        invoke(&webview, "auth_phase", json!({})).unwrap(),
        json!({"phase": "initializing", "authDisabled": true, "hasAdmin": false})
    );
    assert_eq!(
        invoke(&webview, "auth_status", json!({})).unwrap(),
        json!({"initialized": false, "viewerPublic": false})
    );
    let local = invoke(&webview, "auth_resolve", json!({})).unwrap();
    assert_eq!(local["kind"], "local");
    assert_eq!(local["identity"]["role"], "admin");
    let refused = invoke(
        &webview,
        "auth_login",
        json!({"username": "admin", "password": PASSWORD}),
    )
    .unwrap();
    assert_eq!(refused["success"], false);

    let moved = invoke(
        &webview,
        "auth_transition_to_operational",
        json!({"username": "admin", "password": PASSWORD, "displayName": "管理者"}),
    )
    .unwrap();
    assert_eq!(moved["signedIn"], true);
    let account = invoke(&webview, "auth_resolve", json!({})).unwrap();
    assert_eq!(account["kind"], "account");
    assert_eq!(
        account["identity"],
        json!({"id": "admin", "name": "管理者", "role": "admin"})
    );
    assert_eq!(account["current"], moved["seq"]);

    let changed = invoke(
        &webview,
        "auth_change_password",
        json!({"currentPassword": PASSWORD, "newPassword": "another-horse-2"}),
    )
    .unwrap();
    assert!(changed["seq"].as_u64() > moved["seq"].as_u64());
    let logout = invoke(&webview, "auth_logout", json!({})).unwrap();
    assert!(logout["seq"].as_u64() > changed["seq"].as_u64());
    assert_eq!(
        invoke(&webview, "auth_resolve", json!({})).unwrap()["identity"],
        Value::Null
    );
    let login = invoke(
        &webview,
        "auth_login",
        json!({"username": "admin", "password": "another-horse-2"}),
    )
    .unwrap();
    assert_eq!(login["success"], true);
    // Banto's ErrorBody: a refused re-run of the move.
    assert_eq!(
        invoke(
            &webview,
            "auth_transition_to_operational",
            json!({"username": "admin", "password": PASSWORD, "displayName": "管理者"}),
        )
        .unwrap_err(),
        json!({"kind": "not_allowed"})
    );
    assert_eq!(
        invoke(
            &webview,
            "auth_setup",
            json!({"username": "other", "password": PASSWORD, "displayName": "別"}),
        )
        .unwrap()["success"],
        false
    );
}

#[test]
fn a_host_whose_auth_did_not_start_answers_why() {
    let (_app, webview) = app(AuthState::unavailable("phase_lost"));
    for cmd in ["auth_status", "auth_phase", "auth_resolve", "auth_logout"] {
        assert_eq!(
            invoke(&webview, cmd, json!({})).unwrap_err(),
            json!({"kind": "auth_unavailable", "reason": "phase_lost"}),
            "{cmd}"
        );
    }
}

#[test]
fn user_management_and_auth_settings_answer_over_ipc() {
    let dir = TempDir::new();
    let (_app, webview) =
        app(tauri::async_runtime::block_on(AuthState::start(&dir.0, "no_recording_run")).0);
    // Before the move: the mode is not switched here, the local role is.
    assert_eq!(
        invoke(
            &webview,
            "auth_config_apply",
            json!({"disabled": false, "disabledRole": "admin"}),
        )
        .unwrap_err(),
        json!({"kind": "not_allowed"})
    );
    assert_eq!(
        invoke(&webview, "auth_config_get", json!({})).unwrap(),
        json!({"disabled": true, "disabledRole": "admin", "autologinEnabled": false,
            "autologinUsername": null})
    );
    invoke(
        &webview,
        "auth_transition_to_operational",
        json!({"username": "admin", "password": PASSWORD, "displayName": "管理者"}),
    )
    .unwrap();

    let created = invoke(
        &webview,
        "users_create",
        json!({"username": "viewer", "password": PASSWORD, "displayName": "閲覧者",
            "role": "viewer"}),
    )
    .unwrap();
    let id = created["id"].clone();
    assert_eq!(
        created,
        json!({"id": id, "username": "viewer", "displayName": "閲覧者", "role": "viewer"})
    );
    let updated = invoke(
        &webview,
        "users_update",
        json!({"id": id, "displayName": "編集者", "role": "editor"}),
    )
    .unwrap();
    assert_eq!(
        (updated["displayName"].clone(), updated["role"].clone()),
        (json!("編集者"), json!("editor"))
    );
    assert_eq!(
        invoke(
            &webview,
            "users_reset_password",
            json!({"id": id, "newPassword": "reset-horse-3"}),
        )
        .unwrap(),
        Value::Null
    );
    let users = invoke(&webview, "users_list", json!({})).unwrap();
    assert_eq!(users.as_array().unwrap().len(), 2);
    assert!(users[1]["createdAt"].is_string());
    assert_eq!(
        invoke(&webview, "users_delete", json!({"id": id})).unwrap(),
        Value::Null
    );
    assert_eq!(
        invoke(&webview, "users_list", json!({}))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    invoke(&webview, "auth_logout", json!({})).unwrap();
    assert_eq!(
        invoke(&webview, "users_list", json!({})).unwrap_err(),
        json!({"kind": "unauthorized"})
    );
}
