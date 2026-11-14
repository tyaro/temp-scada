//! `project_save` through the real IPC of a mock app: the raw frame, the
//! overwrite of a known file without a dialog, and the refusals (alarm
//! design §5.2). The file handling is tested in `scada_host::project_file`.
use super::*;
use scada_host::project_file::frame;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::{InvokeRequest, WebviewWindow};
use tauri::{test::MockRuntime, App, WebviewWindowBuilder};

/// A fresh dir under the OS temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "banto-scada-project-{}-{}",
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

fn save(webview: &WebviewWindow<MockRuntime>, body: Vec<u8>) -> Result<Value, Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: "project_save".into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: InvokeBody::Raw(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}

#[test]
fn a_known_file_is_overwritten_without_a_dialog() {
    let data = TempDir::new();
    let files = TempDir::new();
    let (app, webview) =
        app(tauri::async_runtime::block_on(AuthState::start(&data.0, "no_recording_run")).0);
    let path = files.0.join("plant.json");
    std::fs::write(&path, b"{\"old\":1}").unwrap();
    let opened = app
        .state::<project::ProjectFileState>()
        .0
        .read(&path)
        .unwrap();

    let answer = save(
        &webview,
        frame(
            &json!({"fileId": opened.file_id, "format": "json", "name": "工程", "saveAs": false}),
            b"{\"new\":1}",
        ),
    )
    .unwrap();
    assert_eq!(
        answer,
        json!({"status": "saved", "fileId": opened.file_id, "fileName": "plant.json",
            "apply": null})
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"{\"new\":1}");

    // Bytes of the other format are refused and the file stays.
    assert_eq!(
        save(
            &webview,
            frame(
                &json!({"fileId": opened.file_id, "format": "json", "name": "工程",
                    "saveAs": false}),
                b"PK\x03\x04",
            ),
        )
        .unwrap_err(),
        json!("format_mismatch")
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"{\"new\":1}");
}

#[test]
fn a_save_is_refused_without_the_permission_or_a_valid_frame() {
    let files = TempDir::new();
    let (app, webview) = app(AuthState::unavailable("auth_db_missing"));
    let path = files.0.join("plant.json");
    std::fs::write(&path, b"{\"old\":1}").unwrap();
    let opened = app
        .state::<project::ProjectFileState>()
        .0
        .read(&path)
        .unwrap();
    assert_eq!(
        save(
            &webview,
            frame(
                &json!({"fileId": opened.file_id, "format": "json", "name": "工程",
                    "saveAs": false}),
                b"{}",
            ),
        )
        .unwrap_err(),
        json!("auth_unavailable")
    );
    assert_eq!(std::fs::read(&path).unwrap(), b"{\"old\":1}");
    assert_eq!(
        save(&webview, vec![9, 0, 0, 0, b'{']).unwrap_err(),
        json!("invalid_request")
    );
}
