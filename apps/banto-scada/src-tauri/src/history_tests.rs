//! The history commands through the real IPC of a mock app: registration,
//! camelCase arguments and the result and error shapes (product-owner design
//! §7.1). The behavior itself is tested in `scada_host::recording_runtime`.
use super::*;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::{InvokeRequest, WebviewWindow};
use tauri::{test::MockRuntime, App, WebviewWindowBuilder};

/// A fresh app data dir under the OS temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "banto-scada-history-{}-{}",
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

fn app(runtime: RecordingRuntime) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let app = commands(mock_builder())
        .manage(runtime)
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

fn query() -> Value {
    json!({"version":1,"kind":"query","requestId":"history-preview","seriesIds":["series-0"],
        "fromMs":0,"toMs":4000,"mode":"raw","maxPointsPerSeries":100})
}

#[test]
fn the_history_commands_answer_over_ipc_on_a_new_store() {
    let dir = TempDir::new();
    let (_app, webview) = app(RecordingRuntime::start(&dir.0, "deployment-a"));

    // A new store has no applied plan: no History service.
    assert_eq!(
        invoke(
            &webview,
            "history_context",
            json!({"projectJson": project_json()})
        ),
        Ok(Value::Null)
    );
    assert_eq!(
        invoke(&webview, "history_context", json!({"projectJson": "{}"})),
        Err(json!("invalid_project"))
    );

    // A query of an unrecorded series is a ready result, not an error.
    let result = invoke(
        &webview,
        "history_query",
        json!({"callId": "call-1", "query": query()}),
    )
    .unwrap();
    assert_eq!(result["kind"], "result");
    assert_eq!(result["query"], query());
    assert_eq!(result["series"][0]["status"], "unknownSeries");

    let mut invalid = query();
    invalid["mode"] = json!("average");
    assert_eq!(
        invoke(
            &webview,
            "history_query",
            json!({"callId": "call-2", "query": invalid}),
        ),
        Err(json!("invalidRequest"))
    );

    // A cancel before its query keeps it from running.
    assert_eq!(
        invoke(&webview, "history_cancel", json!({"callId": "call-3"})),
        Ok(Value::Null)
    );
    assert_eq!(
        invoke(
            &webview,
            "history_query",
            json!({"callId": "call-3", "query": query()}),
        ),
        Err(json!("cancelled"))
    );
}

#[test]
fn an_unavailable_store_answers_every_history_command_with_its_reason() {
    let (_app, webview) = app(RecordingRuntime::unavailable(NO_DATA_DIR));
    assert_eq!(
        invoke(
            &webview,
            "history_context",
            json!({"projectJson": project_json()})
        ),
        Err(json!("no_data_dir"))
    );
    assert_eq!(
        invoke(
            &webview,
            "history_query",
            json!({"callId": "call-1", "query": query()}),
        ),
        Err(json!("unavailable"))
    );
    assert_eq!(
        invoke(&webview, "history_cancel", json!({"callId": "call-1"})),
        Ok(Value::Null)
    );
}
