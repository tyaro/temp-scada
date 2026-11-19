//! The mode boundary (Runtime mode design §4, §5, §9 O0a):
//!
//! - the one command list against `generate_handler!` and the two
//!   capabilities, and the invariants of `runtime.json`;
//! - the host's own check: in Runtime mode every Editor-only command is
//!   refused with `"editorOnly"` before it touches anything (through the IPC
//!   of a mock app, where capabilities are not enforced);
//! - in Editor mode every Runtime-only command is refused with
//!   `"runtimeOnly"`, and the Runtime-only commands serve the startup
//!   Project, never one from the webview;
//! - the ACL of the real capabilities by window label
//!   (`tauri::generate_context!()`).
use super::*;
use crate::app_mode::AppMode;
use crate::command_list::{BOTH, EDITOR_ONLY, RUNTIME_ONLY};
use crate::runtime::StartupProject;
use banto_hub_bootstrap::state::memory::{MemoryKeyStore, MemoryState};
use scada_host::project_file::unframe;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::{InvokeRequest, WebviewWindow};
use tauri::{test::MockRuntime, App, WebviewWindowBuilder};

const CORE: [&str; 3] = [
    "core:default",
    "core:event:default",
    "core:window:allow-set-title",
];

fn manifest(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(path)
}

/// The commands of `generate_handler!` in `main.rs`, without module paths.
fn handler_commands() -> Vec<String> {
    let source = std::fs::read_to_string(manifest("src/main.rs")).unwrap();
    let start = source
        .find("generate_handler![")
        .expect("generate_handler!")
        + 18;
    let end = start + source[start..].find(']').unwrap();
    source[start..end]
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(|name| name.rsplit("::").next().unwrap().to_owned())
        .collect()
}

fn all_listed() -> Vec<&'static str> {
    EDITOR_ONLY
        .iter()
        .chain(BOTH)
        .chain(RUNTIME_ONLY)
        .copied()
        .collect()
}

fn allow(names: &[&str]) -> BTreeSet<String> {
    names
        .iter()
        .map(|name| format!("allow-{}", name.replace('_', "-")))
        .collect()
}

fn capability(name: &str) -> Value {
    let path = manifest(&format!("capabilities/{name}.json"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn permissions(capability: &Value) -> Vec<String> {
    capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|permission| permission.as_str().expect("plain permission").to_owned())
        .collect()
}

#[test]
fn the_command_list_is_generate_handler_without_gaps_or_duplicates() {
    let listed = all_listed();
    let unique: BTreeSet<&str> = listed.iter().copied().collect();
    assert_eq!(unique.len(), listed.len(), "a command is listed twice");
    let handlers = handler_commands();
    let registered: BTreeSet<&str> = handlers.iter().map(String::as_str).collect();
    assert_eq!(
        registered.len(),
        handlers.len(),
        "a handler is registered twice"
    );
    assert_eq!(registered, unique);
    // 56 commands before the mode, `app_mode`, the 6 `runtime_*` and
    // `operation_write` and `operation_view`, and the 4 of the write key
    // (`operation_key_*`, `operation_write_resume`) and the minimum interval
    // (`operation_min_interval_set`).
    assert_eq!(listed.len(), 70);
}

#[test]
fn the_capabilities_are_the_command_list() {
    let only: Vec<String> = std::fs::read_dir(manifest("capabilities"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    assert_eq!(only, ["editor.json", "runtime.json"]);

    let editor = capability("editor");
    assert_eq!(editor["windows"], json!(["editor"]));
    let runtime = capability("runtime");
    assert_eq!(runtime["windows"], json!(["runtime"]));

    for (capability, commands) in [
        (&editor, [EDITOR_ONLY, BOTH].concat()),
        (&runtime, [RUNTIME_ONLY, BOTH].concat()),
    ] {
        let permissions = permissions(capability);
        let set: BTreeSet<String> = permissions.iter().cloned().collect();
        assert_eq!(set.len(), permissions.len(), "a permission is listed twice");
        let (core, apps): (BTreeSet<String>, BTreeSet<String>) = set
            .into_iter()
            .partition(|permission| permission.contains(':'));
        // No plugin permission (`dialog:*` …) and nothing beyond today's core.
        assert_eq!(core, CORE.iter().map(|p| p.to_string()).collect());
        assert_eq!(apps, allow(&commands));
    }
}

#[test]
fn the_runtime_capability_holds_no_editor_command_and_creates_no_window() {
    let permissions = permissions(&capability("runtime"));
    let editor = allow(EDITOR_ONLY);
    for permission in &permissions {
        assert!(!editor.contains(permission), "{permission}");
        // `core:window:allow-create`, `core:webview:allow-create-webview*`.
        let core_create = permission.starts_with("core:") && permission.contains("create");
        assert!(!core_create, "{permission}");
        assert!(
            !permission.contains(':') || CORE.contains(&permission.as_str()),
            "{permission}"
        );
    }
}

/// A fresh data dir under the OS temp dir, removed on drop.
pub(crate) struct TempDir(pub(crate) PathBuf);

impl TempDir {
    pub(crate) fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "banto-scada-mode-{}-{}",
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

/// Every file under `dir` with its size and modification time.
fn fingerprint(dir: &Path) -> BTreeMap<PathBuf, (u64, std::time::SystemTime)> {
    let mut files = BTreeMap::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            let meta = entry.metadata().unwrap();
            if meta.is_dir() {
                pending.push(entry.path());
            } else {
                files.insert(entry.path(), (meta.len(), meta.modified().unwrap()));
            }
        }
    }
    files
}

/// The keyring of the write key, in memory (operation design §7).
#[derive(Default)]
pub(crate) struct MemoryWriteKeys(std::sync::Mutex<BTreeMap<String, String>>);

impl scada_host::operation_key::WriteKeyStore for MemoryWriteKeys {
    fn get(&self, id: &str) -> Result<Option<String>, scada_host::operation_key::KeyError> {
        Ok(self.0.lock().unwrap().get(id).cloned())
    }

    fn set(&self, id: &str, secret: &str) -> Result<(), scada_host::operation_key::KeyError> {
        self.0.lock().unwrap().insert(id.into(), secret.into());
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<(), scada_host::operation_key::KeyError> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

/// A first-start host with real auth, alarm and recording stores in `dir`.
pub(crate) fn app(
    dir: &TempDir,
    mode: AppMode,
    label: &str,
) -> (App<MockRuntime>, WebviewWindow<MockRuntime>) {
    let (auth, recording) =
        tauri::async_runtime::block_on(AuthState::start(&dir.0, "no_recording_run"));
    let alarm = tauri::async_runtime::block_on(alarm::AlarmState::open(Ok::<_, ()>(&dir.0)));
    let operations = tauri::async_runtime::block_on(operation::OperationState::open(
        &mode,
        Ok::<_, ()>(&dir.0),
        Ok(Arc::new(MemoryWriteKeys::default())),
    ));
    let app = commands(mock_builder())
        .manage(operations)
        .manage(StartupProject::load(&mode))
        .manage(mode)
        .manage(auth)
        .manage(recording)
        .manage(alarm)
        .manage(RecordingRuntime::start(&dir.0, "deployment-a"))
        .manage(NativeHost {
            bootstrap: Arc::new(Bootstrapper::new(
                "temp-scada-test",
                "11111111-2222-4333-8444-555555555555",
                Arc::new(MemoryKeyStore::new()),
                Arc::new(MemoryState::new()),
            )),
            active: Mutex::new(Active::default()),
            alarm_operation: Mutex::new(()),
            exiting: AtomicBool::new(false),
            read_revision: Default::default(),
        })
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, label, Default::default())
        .build()
        .unwrap();
    (app, webview)
}

pub(crate) fn invoke(
    webview: &WebviewWindow<MockRuntime>,
    cmd: &str,
    args: Value,
) -> Result<Value, Value> {
    invoke_body(webview, cmd, args).map(|body| body.deserialize::<Value>().unwrap())
}

/// The raw frame a command answers (`runtime_project`).
fn invoke_frame(webview: &WebviewWindow<MockRuntime>, cmd: &str) -> (Value, Vec<u8>) {
    let InvokeResponseBody::Raw(bytes) = invoke_body(webview, cmd, json!({})).unwrap() else {
        panic!("{cmd} answered no frame");
    };
    let (header, body) = unframe::<Value>(&bytes).expect("frame");
    (header, body.to_vec())
}

fn invoke_body(
    webview: &WebviewWindow<MockRuntime>,
    cmd: &str,
    args: Value,
) -> Result<InvokeResponseBody, Value> {
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
}

pub(crate) fn runtime_mode(dir: &TempDir) -> AppMode {
    AppMode::Runtime {
        project_path: dir.0.join("plant.project.json"),
    }
}

/// Well-formed arguments of every Editor-only command: a refusal must come
/// from the mode, not from a missing argument.
fn editor_only_calls() -> Vec<(&'static str, Value)> {
    let project = include_str!("../../../../examples/minimal.project.json");
    let request = json!({});
    let calls = vec![
        ("project_open", json!({})),
        ("project_save", json!({})),
        (
            "alarm_apply",
            json!({"fileId": 1, "confirmed": [], "confirmedSwitchFrom": null}),
        ),
        ("alarm_sound_import", json!({})),
        ("hub_connect", json!({"endpoint": "http://127.0.0.1:1"})),
        ("hub_catalog", json!({"projectJson": project})),
        (
            "hub_read_start",
            json!({"projectJson": project, "subscriptionId": "s"}),
        ),
        ("history_context", json!({"projectJson": project})),
        ("recording_context", json!({"projectJson": project})),
        ("recording_initial_setup", json!({"projectJson": project})),
        ("recording_reconfigure", json!({"projectJson": project})),
        ("recording_owner_rebind", json!({"projectJson": project})),
        ("recording_resume", json!({"projectJson": project})),
        ("recording_stop", json!({})),
        ("recording_workflow_reserve", json!({"request": request})),
        ("recording_workflow_resumption", json!({})),
        (
            "recording_workflow_lease",
            json!({"stage": "reserve", "operationId": null, "request": request}),
        ),
        ("recording_lease", json!({"request": request})),
        ("recording_admission", json!({"request": request})),
        (
            "recording_admission_inspection",
            json!({"request": request}),
        ),
        ("recording_observation", json!({"request": request})),
        ("recording_cancel", json!({"request": request})),
        ("recording_call_inspection", json!({"request": request})),
        ("recording_attach", json!({"request": request})),
        ("recording_control", json!({"request": request})),
        (
            "auth_transition_to_operational",
            json!({"username": "admin", "password": "Passw0rd!Passw0rd", "displayName": "管理者"}),
        ),
        (
            "auth_config_apply",
            json!({"disabled": false, "disabledRole": "admin"}),
        ),
    ];
    let named: BTreeSet<&str> = calls.iter().map(|(name, _)| *name).collect();
    assert_eq!(named, EDITOR_ONLY.iter().copied().collect());
    calls
}

#[test]
fn runtime_mode_refuses_every_editor_only_command_before_touching_anything() {
    let dir = TempDir::new();
    let (app, webview) = app(&dir, runtime_mode(&dir), "runtime");
    let config = invoke(&webview, "auth_config_get", json!({})).unwrap();
    let phase = invoke(&webview, "auth_phase", json!({})).unwrap();
    let slot = invoke(&webview, "recording_slot", json!({})).unwrap();
    let files = fingerprint(&dir.0);

    for (command, args) in editor_only_calls() {
        assert_eq!(
            invoke(&webview, command, args),
            Err(json!("editorOnly")),
            "{command}"
        );
    }

    // No auth, alarm or recording DB, Project file or Hub record changed.
    assert_eq!(fingerprint(&dir.0), files);
    assert_eq!(
        invoke(&webview, "auth_config_get", json!({})).unwrap(),
        config
    );
    assert_eq!(invoke(&webview, "auth_phase", json!({})).unwrap(), phase);
    assert_eq!(invoke(&webview, "recording_slot", json!({})).unwrap(), slot);
    assert_eq!(
        invoke(&webview, "hub_saved_endpoint", json!({})),
        Ok(Value::Null)
    );
    assert!(app
        .state::<NativeHost>()
        .active
        .try_lock()
        .is_ok_and(|a| !a.connected));
}

#[test]
fn runtime_mode_serves_the_shared_commands() {
    let dir = TempDir::new();
    let (_app, webview) = app(&dir, runtime_mode(&dir), "runtime");
    assert_eq!(
        invoke(&webview, "app_mode", json!({})),
        Ok(json!("runtime"))
    );
    assert!(invoke(&webview, "auth_status", json!({})).is_ok());
    assert!(invoke(&webview, "auth_config_get", json!({})).is_ok());
    assert!(invoke(&webview, "alarm_snapshot", json!({})).is_ok());
    assert!(invoke(&webview, "alarm_settings_get", json!({})).is_ok());
    assert_eq!(
        invoke(&webview, "hub_saved_endpoint", json!({})),
        Ok(Value::Null)
    );
    assert_eq!(
        invoke(&webview, "hub_disconnect", json!({})),
        Ok(Value::Null)
    );
}

#[test]
fn editor_mode_serves_the_editor_only_commands() {
    let dir = TempDir::new();
    let (_app, webview) = app(&dir, AppMode::Editor, "editor");
    assert_eq!(invoke(&webview, "app_mode", json!({})), Ok(json!("editor")));
    // Past the mode check: the command's own answer.
    assert_eq!(
        invoke(&webview, "history_context", json!({"projectJson": "{}"})),
        Err(json!("invalid_project"))
    );
    assert_eq!(
        invoke(&webview, "hub_catalog", json!({"projectJson": "{}"})),
        Err(json!("invalid_project"))
    );
    assert_eq!(
        invoke(&webview, "recording_context", json!({"projectJson": "{}"})),
        Err(json!({"kind": "invalid_project"}))
    );
    assert_eq!(
        invoke(
            &webview,
            "auth_config_apply",
            json!({"disabled": false, "disabledRole": "admin"})
        ),
        Err(json!({"kind": "not_allowed"}))
    );
    assert_ne!(
        invoke(&webview, "recording_stop", json!({})),
        Err(json!("editorOnly"))
    );
}

/// The real capabilities of `tauri.conf.json`, enforced by window label:
/// an Editor-only command from the `runtime` window is refused by the ACL
/// before the host's own check, and passes it from the `editor` window.
#[test]
fn the_acl_refuses_editor_only_commands_from_the_runtime_window() {
    let dir = TempDir::new();
    let (auth, recording) =
        tauri::async_runtime::block_on(AuthState::start(&dir.0, "no_recording_run"));
    let app = commands(mock_builder())
        // Editor: a refusal from the `runtime` window is the ACL's alone.
        .manage(AppMode::Editor)
        .manage(auth)
        .manage(recording)
        .manage(RecordingRuntime::start(&dir.0, "deployment-a"))
        .build(tauri::generate_context!())
        .unwrap();
    let editor = WebviewWindowBuilder::new(&app, "editor", Default::default())
        .build()
        .unwrap();
    let runtime = WebviewWindowBuilder::new(&app, "runtime", Default::default())
        .build()
        .unwrap();
    let project = json!({"projectJson": "{}"});

    let refused = invoke(&runtime, "history_context", project.clone()).unwrap_err();
    assert!(
        refused
            .as_str()
            .is_some_and(|message| message.contains("not allowed")),
        "{refused}"
    );
    let refused = invoke(
        &runtime,
        "auth_config_apply",
        json!({"disabled": false, "disabledRole": "admin"}),
    )
    .unwrap_err();
    assert!(
        refused
            .as_str()
            .is_some_and(|message| message.contains("not allowed")),
        "{refused}"
    );
    assert_eq!(
        invoke(&editor, "history_context", project),
        Err(json!("invalid_project"))
    );
    assert_eq!(invoke(&runtime, "app_mode", json!({})), Ok(json!("editor")));
    assert_eq!(invoke(&editor, "app_mode", json!({})), Ok(json!("editor")));
}

const MINIMAL: &str = include_str!("../../../../examples/minimal.project.json");

fn sha256_hex(bytes: &[u8]) -> String {
    scada_host::alarm_project::file_hash(bytes)
}

/// The arguments of every Runtime-only command: none but the subscription.
fn runtime_only_calls() -> Vec<(&'static str, Value)> {
    let calls = vec![
        ("runtime_project", json!({})),
        ("runtime_hub_connect", json!({})),
        ("runtime_read_start", json!({"subscriptionId": "s"})),
        ("runtime_history_context", json!({})),
        ("runtime_recording_context", json!({})),
        ("runtime_alarm_status", json!({})),
        (
            "operation_write",
            json!({"request": {
                "projectId": "p", "projectDigest": "d", "screenId": "s",
                "objectId": "o", "equipmentId": "e", "slotName": "x",
                "buttonIndex": 0, "expectedValue": true}}),
        ),
        ("operation_view", json!({"request": {"equipmentId": "e"}})),
        ("operation_key_status", json!({})),
        ("operation_key_register", json!({"secret": "s"})),
        ("operation_key_delete", json!({})),
        ("operation_write_resume", json!({})),
        (
            "operation_min_interval_set",
            json!({"minIntervalMs": 2_000}),
        ),
    ];
    let named: BTreeSet<&str> = calls.iter().map(|(name, _)| *name).collect();
    assert_eq!(named, RUNTIME_ONLY.iter().copied().collect());
    calls
}

#[test]
fn editor_mode_refuses_every_runtime_only_command() {
    let dir = TempDir::new();
    let (_app, webview) = app(&dir, AppMode::Editor, "editor");
    for (command, args) in runtime_only_calls() {
        assert_eq!(
            invoke(&webview, command, args),
            Err(json!("runtimeOnly")),
            "{command}"
        );
    }
}

#[test]
fn runtime_project_is_the_startup_file_for_the_whole_run() {
    let dir = TempDir::new();
    let mode = runtime_mode(&dir);
    let AppMode::Runtime { project_path } = &mode else {
        unreachable!()
    };
    std::fs::write(project_path, MINIMAL).unwrap();
    let (_app, webview) = app(&dir, mode.clone(), "runtime");

    let expected = json!({
        "status": "opened",
        "fileName": "plant.project.json",
        "projectDigest": sha256_hex(MINIMAL.as_bytes()),
    });
    let (header, body) = invoke_frame(&webview, "runtime_project");
    assert_eq!(header, expected);
    assert_eq!(body, MINIMAL.as_bytes());

    // Replaced on disk after startup: the answer stays the startup file.
    std::fs::write(project_path, b"{\"replaced\": true}").unwrap();
    let (header, body) = invoke_frame(&webview, "runtime_project");
    assert_eq!(header, expected);
    assert_eq!(body, MINIMAL.as_bytes());
}

#[test]
fn the_runtime_entries_take_the_startup_project_and_no_project_argument() {
    let dir = TempDir::new();
    let mode = runtime_mode(&dir);
    let AppMode::Runtime { project_path } = &mode else {
        unreachable!()
    };
    std::fs::write(project_path, MINIMAL).unwrap();
    let (app, webview) = app(&dir, mode.clone(), "runtime");

    // Past the mode and the Project: the commands' own answers.
    assert_eq!(
        invoke(
            &webview,
            "runtime_read_start",
            json!({"subscriptionId": "s"})
        ),
        Err(json!("not_connected"))
    );
    assert_eq!(
        invoke(&webview, "runtime_history_context", json!({})),
        Ok(Value::Null)
    );
    let context = invoke(&webview, "runtime_recording_context", json!({}));
    assert_ne!(context, Err(json!({"kind": "projectUnavailable"})));
    assert_ne!(context, Err(json!("runtimeOnly")));
    assert_eq!(
        invoke(&webview, "runtime_alarm_status", json!({})),
        Ok(json!("notApplied"))
    );
    // A Project from the webview is not a parameter: it changes nothing.
    assert_eq!(
        invoke(
            &webview,
            "runtime_history_context",
            json!({"projectJson": "{}"})
        ),
        Ok(Value::Null)
    );

    // No saved Hub: nothing is issued, Editor must connect first.
    assert_eq!(
        invoke(&webview, "runtime_hub_connect", json!({})),
        Err(json!({"reason": "reconnectInEditor", "status": {"state": "notConfigured"}}))
    );
    assert_eq!(
        invoke(&webview, "hub_saved_endpoint", json!({})),
        Ok(Value::Null)
    );
    assert!(app
        .state::<NativeHost>()
        .active
        .try_lock()
        .is_ok_and(|a| !a.connected));
}

#[test]
fn a_startup_project_that_failed_is_shown_and_serves_nothing() {
    let dir = TempDir::new();
    // Missing: unreadable.
    let (_app, webview) = app(&dir, runtime_mode(&dir), "runtime");
    let (header, body) = invoke_frame(&webview, "runtime_project");
    assert_eq!(
        header,
        json!({
            "status": "failed",
            "fileName": "plant.project.json",
            "reason": "unreadable",
            "detail": "not_found",
        })
    );
    assert!(body.is_empty());
    assert_eq!(
        invoke(
            &webview,
            "runtime_read_start",
            json!({"subscriptionId": "s"})
        ),
        Err(json!("projectUnavailable"))
    );
    assert_eq!(
        invoke(&webview, "runtime_history_context", json!({})),
        Err(json!("projectUnavailable"))
    );
    assert_eq!(
        invoke(&webview, "runtime_recording_context", json!({})),
        Err(json!({"kind": "projectUnavailable"}))
    );
    assert_eq!(
        invoke(&webview, "runtime_alarm_status", json!({})),
        Err(json!("projectUnavailable"))
    );

    // Not a Project: invalid format.
    for (name, content) in [
        ("broken.json", "{not json"),
        ("empty.json", "{}"),
        ("plant.txt", MINIMAL),
    ] {
        let path = dir.0.join(name);
        std::fs::write(&path, content).unwrap();
        let StartupProject::Failed(failure) =
            StartupProject::load(&AppMode::Runtime { project_path: path })
        else {
            panic!("{name} loaded");
        };
        assert_eq!(failure.reason, "invalidFormat", "{name}");
        assert_eq!(failure.file_name, name);
    }
}

/// The real capabilities again, in Runtime mode: a Runtime-only command is
/// refused by the ACL from the `editor` window and served to `runtime`.
#[test]
fn the_acl_refuses_runtime_only_commands_from_the_editor_window() {
    let dir = TempDir::new();
    let mode = runtime_mode(&dir);
    let AppMode::Runtime { project_path } = &mode else {
        unreachable!()
    };
    std::fs::write(project_path, MINIMAL).unwrap();
    let app = commands(mock_builder())
        .manage(StartupProject::load(&mode))
        .manage(mode)
        .build(tauri::generate_context!())
        .unwrap();
    let editor = WebviewWindowBuilder::new(&app, "editor", Default::default())
        .build()
        .unwrap();
    let runtime = WebviewWindowBuilder::new(&app, "runtime", Default::default())
        .build()
        .unwrap();

    let refused = invoke(&editor, "runtime_project", json!({})).unwrap_err();
    assert!(
        refused
            .as_str()
            .is_some_and(|message| message.contains("not allowed")),
        "{refused}"
    );
    for command in ["operation_write", "operation_view"] {
        let refused = invoke(&editor, command, json!({"request": {}})).unwrap_err();
        assert!(
            refused
                .as_str()
                .is_some_and(|message| message.contains("not allowed")),
            "{command}: {refused}"
        );
    }
    let (header, _) = invoke_frame(&runtime, "runtime_project");
    assert_eq!(header["status"], "opened");
    assert_eq!(header["projectDigest"], sha256_hex(MINIMAL.as_bytes()));
}
