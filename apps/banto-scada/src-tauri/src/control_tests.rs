//! The recording control commands through the real IPC of a mock app:
//! registration, camelCase arguments and the result and error shapes
//! (product-owner design §5). The behavior itself is tested in
//! `scada_host::recording_control` and `scada_host::recording_runtime`.
use super::*;
use auth::AuthState;
use banto_hub_bootstrap::state::memory::{MemoryKeyStore, MemoryState};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::{InvokeRequest, WebviewWindow};
use tauri::{test::MockRuntime, App, WebviewWindowBuilder};

/// A fresh app data dir under the OS temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "banto-scada-control-{}-{}",
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

/// A first-start host (auth-disabled, synthetic Admin) with no saved Hub.
fn app(dir: &TempDir) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let (auth, recording) =
        tauri::async_runtime::block_on(AuthState::start(&dir.0, "no_recording_run"));
    let app = commands(mock_builder())
        .manage(auth)
        .manage(recording)
        .manage(RecordingRuntime::start(&dir.0, "deployment-a"))
        .manage(NativeHost {
            bootstrap: Bootstrapper::new(
                "temp-scada-test",
                "11111111-2222-4333-8444-555555555555",
                Arc::new(MemoryKeyStore::new()),
                Arc::new(MemoryState::new()),
            ),
            active: Mutex::new(Active::default()),
        })
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

fn project_json() -> String {
    let mut project: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../examples/minimal.project.json"
    )))
    .unwrap();
    project["recordingPlan"] = json!({"version":1,"kind":"recordingPlan","planId":"plan-a",
        "revision":1,"enabled":true,"group":{"groupId":"group","hubRef":"hub","periodMs":1000,
        "members":[{"memberId":"member-0","externalName":"Line1.Temperature",
            "valueType":"number"}]}});
    project.to_string()
}

#[test]
fn the_control_commands_answer_over_ipc() {
    let dir = TempDir::new();
    let (_app, webview) = app(&dir);
    let context = invoke(
        &webview,
        "recording_context",
        json!({"projectJson": project_json()}),
    )
    .unwrap();
    assert_eq!(context["kind"], "recordingManagementContext");
    assert_eq!(context["deploymentId"], "deployment-a");
    assert_eq!(
        invoke(&webview, "recording_context", json!({"projectJson": "{}"})),
        Err(json!({"kind": "invalid_project"}))
    );

    let request = json!({"version": 1, "kind": "recordingInspectionRequest",
        "requestId": "inspect-1", "context": context});
    let response = invoke(&webview, "recording_status", json!({"request": request})).unwrap();
    assert_eq!(response["kind"], "recordingInspectionResponse");
    assert_eq!(response["request"], request);
    assert_eq!(response["database"]["applied"], Value::Null);
    assert_eq!(response["host"]["phase"], "idle");
    assert_eq!(
        invoke(&webview, "recording_status", json!({"request": {}})),
        Err(json!({"kind": "invalidRequest"}))
    );

    // No Hub is saved on this host.
    assert_eq!(
        invoke(
            &webview,
            "recording_initial_setup",
            json!({"projectJson": project_json()})
        ),
        Err(json!({"kind": "hub_not_configured"}))
    );
    assert_eq!(
        invoke(
            &webview,
            "recording_resume",
            json!({"projectJson": project_json()})
        ),
        Err(json!({"kind": "hub_not_configured"}))
    );
    // No plan is applied: the first setup comes first.
    assert_eq!(
        invoke(
            &webview,
            "recording_reconfigure",
            json!({"projectJson": project_json()})
        ),
        Err(json!({"kind": "not_allowed"}))
    );

    // The slot stays empty until a recording runs, and nothing records.
    assert_eq!(
        invoke(&webview, "recording_slot", json!({})),
        Ok(json!({"state": "empty", "reason": "no_recording_run"}))
    );
    assert_eq!(
        invoke(&webview, "recording_stop", json!({})),
        Err(json!({"kind": "not_allowed"}))
    );
}

/// The confirmation before the window closes (design §6.1): an empty slot
/// asks nothing, and a question is answered once over IPC.
#[test]
fn the_close_confirmation_is_answered_over_ipc() {
    use close::{CloseGuard, Decision};
    use scada_host::recording_gate::CloseCheck;
    let dir = TempDir::new();
    let (app, webview) = app(&dir);
    let auth = app.state::<AuthState>();
    assert_eq!(
        scada_host::recording_control::close_check(auth.get().ok()),
        CloseCheck::Close
    );

    let Decision::Ask(prompt) = app.state::<CloseGuard>().request(CloseCheck::Candidate) else {
        panic!("not asked");
    };
    let reply = |id: u64, reply: &str| {
        invoke(
            &webview,
            "app_close_reply",
            json!({"id": id, "reply": reply}),
        )
    };
    assert_eq!(reply(prompt.id, "shown"), Ok(Value::Null));
    assert_eq!(reply(prompt.id, "later"), Err(json!("invalid_reply")));
    assert_eq!(reply(prompt.id + 1, "cancel"), Err(json!("stale_prompt")));
    assert_eq!(reply(prompt.id, "cancel"), Ok(Value::Null));
    assert_eq!(reply(prompt.id, "discard"), Err(json!("stale_prompt")));
}
