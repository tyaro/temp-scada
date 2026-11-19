//! One embedded read-only host. Hub services and PLC connections stay external.
mod alarm;
mod app_mode;
mod auth;
mod buzzer;
mod close;
mod control;
mod history;
mod project;
mod recording;
mod runtime;

use app_mode::AppMode;
use auth::AuthState;
use scada_host::desktop_recording::DesktopRecording;
use scada_host::recording_gate::NO_RECORDING_RUN;
use scada_host::recording_runtime::{RecordingRuntime, NO_DATA_DIR, STORE_UNAVAILABLE};
use scada_host::{local_bootstrap, local_data_dir, local_installation_id, Bootstrapper, HubStatus};
use scada_model::Project;
use scada_runtime::{CatalogHost, ReadDisplayStream, ReadHost};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, State, WindowEvent};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

struct NativeHost {
    bootstrap: Arc<Bootstrapper>,
    active: Mutex<Active>,
    alarm_operation: Mutex<()>,
    exiting: AtomicBool,
}

#[derive(Default)]
struct Active {
    connected: bool,
    owner: Option<String>,
    retired: HashSet<String>,
    read: Option<ReadHost>,
    pump: Option<JoinHandle<()>>,
}

impl Active {
    fn claim(&mut self, subscription_id: &str) -> bool {
        !self.retired.remove(subscription_id)
    }

    fn retire(&mut self, subscription_id: &str) -> bool {
        if self.owner.as_deref() == Some(subscription_id) {
            true
        } else {
            self.retired.insert(subscription_id.to_owned());
            false
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadPacket {
    subscription_id: String,
    update: scada_runtime::ReadDisplayUpdate,
}

async fn stop_read(active: &mut Active) {
    if let Some(pump) = active.pump.take() {
        pump.abort();
        let _ = pump.await;
    }
    if let Some(mut read) = active.read.take() {
        let _ = read.stop().await;
    }
    active.owner = None;
}

/// Stops the read, reconnects with `connect` and resumes the alarm Engine
/// with the saved Hub: the one path of `hub_connect` and
/// `runtime_hub_connect`, which differ only in how they reach the Hub.
async fn reconnect<F, Fut>(
    state: &NativeHost,
    alarm: &alarm::AlarmState,
    connect: F,
) -> Result<HubStatus, String>
where
    F: FnOnce(Arc<Bootstrapper>) -> Fut,
    Fut: std::future::Future<Output = Result<HubStatus, String>>,
{
    let _alarm_operation = state.alarm_operation.lock().await;
    if state.exiting.load(Ordering::SeqCst) {
        return Err("exiting".into());
    }
    let mut active = state.active.lock().await;
    stop_read(&mut active).await;
    active.connected = false;
    let result = connect(state.bootstrap.clone()).await;
    active.connected = result.as_ref().is_ok_and(HubStatus::is_connected);
    drop(active);
    if !state.exiting.load(Ordering::SeqCst) {
        alarm::after_hub_connect(state, alarm).await;
    }
    result
}

#[tauri::command]
async fn hub_connect(
    mode: State<'_, AppMode>,
    state: State<'_, NativeHost>,
    alarm: State<'_, alarm::AlarmState>,
    endpoint: String,
) -> Result<HubStatus, String> {
    mode.require_editor()?;
    reconnect(&state, &alarm, |bootstrap| async move {
        bootstrap
            .connect(&endpoint)
            .await
            .map(|connection| connection.status)
            .map_err(|error| error.kind().as_str().to_owned())
    })
    .await
}

/// Why `runtime_hub_connect` did not connect: the saved Hub cannot be used
/// without Editor (`{"reason": "reconnectInEditor", "status"}`), or the
/// reason string of `hub_connect`.
#[derive(Debug)]
enum RuntimeHubFailure {
    ReconnectInEditor(HubStatus),
    Failed(String),
}

impl Serialize for RuntimeHubFailure {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::ReconnectInEditor(status) => {
                serde_json::json!({"reason": "reconnectInEditor", "status": status})
                    .serialize(serializer)
            }
            Self::Failed(reason) => serializer.serialize_str(reason),
        }
    }
}

/// `runtime_hub_connect`: connects with the saved endpoint and the saved key
/// and never issues a key (`Bootstrapper::status`, not `connect`, which may
/// re-issue through the commissioning grant). The saved record and the
/// keyring are left as they are. An unconfigured Hub or a key Runtime cannot
/// renew (`notConfigured`, `authFailed`, `forbidden`, `needsPairing`) is
/// `reconnectInEditor`; an unreachable Hub or a tripped key is answered as
/// its status, like `hub_connect`, and may be retried.
#[tauri::command]
async fn runtime_hub_connect(
    mode: State<'_, AppMode>,
    state: State<'_, NativeHost>,
    alarm: State<'_, alarm::AlarmState>,
) -> Result<HubStatus, app_mode::Guarded<RuntimeHubFailure>> {
    mode.require_runtime()?;
    let status = reconnect(&state, &alarm, |bootstrap| async move {
        bootstrap
            .status()
            .await
            .map_err(|error| error.kind().as_str().to_owned())
    })
    .await
    .map_err(|reason| app_mode::Guarded::Inner(RuntimeHubFailure::Failed(reason)))?;
    match status {
        HubStatus::NotConfigured
        | HubStatus::AuthFailed
        | HubStatus::Forbidden
        | HubStatus::NeedsPairing => Err(app_mode::Guarded::Inner(
            RuntimeHubFailure::ReconnectInEditor(status),
        )),
        status => Ok(status),
    }
}

#[tauri::command]
async fn hub_disconnect(state: State<'_, NativeHost>) -> Result<(), String> {
    let mut active = state.active.lock().await;
    active.connected = false;
    stop_read(&mut active).await;
    Ok(())
}

#[tauri::command]
fn hub_saved_endpoint(state: State<'_, NativeHost>) -> Result<Option<String>, String> {
    state
        .bootstrap
        .record()
        .map(|record| record.map(|record| record.endpoint))
        .map_err(|error| error.kind().as_str().to_owned())
}

#[tauri::command]
async fn hub_read_start<R: Runtime>(
    app: AppHandle<R>,
    mode: State<'_, AppMode>,
    state: State<'_, NativeHost>,
    project_json: String,
    subscription_id: String,
) -> Result<(), String> {
    mode.require_editor()?;
    let project = Project::from_json(&project_json).map_err(|_| "invalid_project".to_owned())?;
    start_read(app, &state, &project, subscription_id).await
}

/// `runtime_read_start`: `hub_read_start` with the startup Project.
#[tauri::command]
async fn runtime_read_start<R: Runtime>(
    app: AppHandle<R>,
    mode: State<'_, AppMode>,
    state: State<'_, NativeHost>,
    startup: State<'_, runtime::StartupProject>,
    subscription_id: String,
) -> Result<(), String> {
    mode.require_runtime()?;
    let project = startup.project()?;
    start_read(app, &state, project, subscription_id).await
}

/// Starts the read subscription `subscription_id` of `project` and pumps
/// its updates as `scada:read`.
async fn start_read<R: Runtime>(
    app: AppHandle<R>,
    state: &NativeHost,
    project: &Project,
    subscription_id: String,
) -> Result<(), String> {
    let mut active = state.active.lock().await;
    if !active.claim(&subscription_id) {
        return Err("subscription_retired".into());
    }
    stop_read(&mut active).await;
    if !active.connected {
        return Err("not_connected".into());
    }
    let client = state
        .bootstrap
        .rest_client()
        .map_err(|error| error.kind().as_str().to_owned())?
        .ok_or("not_configured")?;
    let mut read = ReadHost::new(project).map_err(|_| "invalid_read_plan")?;
    read.replace(project, Some(client))
        .await
        .map_err(|_| "read_start_failed")?;
    let mut receiver = read.state_watch();
    let frame = read.state();
    let mut stream = ReadDisplayStream::new(&frame);
    let update = stream.next(&frame).map_err(|_| "display_failed")?;
    app.emit(
        "scada:read",
        ReadPacket {
            subscription_id: subscription_id.clone(),
            update,
        },
    )
    .map_err(|_| "delivery_failed")?;
    let pump_id = subscription_id.clone();
    let pump = tokio::spawn(async move {
        while receiver.changed().await.is_ok() {
            let frame = receiver.borrow_and_update().clone();
            match stream.next(&frame) {
                Ok(update) => {
                    if app
                        .emit(
                            "scada:read",
                            ReadPacket {
                                subscription_id: pump_id.clone(),
                                update,
                            },
                        )
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    active.owner = Some(subscription_id);
    active.read = Some(read);
    active.pump = Some(pump);
    Ok(())
}

#[tauri::command]
async fn hub_read_stop(
    state: State<'_, NativeHost>,
    subscription_id: String,
) -> Result<(), String> {
    let mut active = state.active.lock().await;
    if active.retire(&subscription_id) {
        stop_read(&mut active).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Active;

    #[test]
    fn retired_start_cannot_replace_a_newer_owner() {
        let mut active = Active::default();
        assert!(!active.retire("old"));
        active.owner = Some("new".into());
        assert!(!active.claim("old"));
        assert_eq!(active.owner.as_deref(), Some("new"));
        assert!(active.claim("new"));
    }
}

#[cfg(test)]
mod native_tests;

#[cfg(test)]
mod auth_tests;

#[cfg(test)]
mod recording_tests;

#[cfg(test)]
mod history_tests;

#[cfg(test)]
mod control_tests;

#[cfg(test)]
mod project_tests;

#[cfg(test)]
mod mode_tests;

/// The commands by mode (`command_list.rs`, also read by `build.rs`).
#[cfg(test)]
mod command_list {
    include!("../command_list.rs");
}

#[tauri::command]
async fn hub_catalog(
    mode: State<'_, AppMode>,
    state: State<'_, NativeHost>,
    project_json: String,
) -> Result<scada_runtime::CatalogView, String> {
    mode.require_editor()?;
    let project = Project::from_json(&project_json).map_err(|_| "invalid_project".to_owned())?;
    let active = state.active.lock().await;
    if !active.connected {
        return Err("not_connected".into());
    }
    let client = state
        .bootstrap
        .rest_client()
        .map_err(|error| error.kind().as_str().to_owned())?
        .ok_or("not_configured")?;
    drop(active);
    let mut catalog = CatalogHost::new(&project);
    catalog.replace(&project, Some(client));
    let request = catalog.request().ok_or("not_connected")?;
    catalog
        .accept(request.fetch().await)
        .map_err(|_| "catalog_failed".to_owned())?
        .ok_or("obsolete_catalog".to_owned())
}

/// Every command of the desktop host, registered once for the app and its
/// IPC tests, with the page hooks that stop the recording pumps of a page
/// that is gone, and the confirmation before the window closes.
fn commands<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .manage(recording::Pages::default())
        .manage(close::CloseGuard::default())
        .manage(project::ProjectFileState::default())
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                recording::end_page(webview, webview.label());
            }
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => close::requested(window, api),
            WindowEvent::Destroyed => recording::end_page(window, window.label()),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            app_mode::app_mode,
            runtime::runtime_project,
            runtime::runtime_alarm_status,
            runtime_hub_connect,
            runtime_read_start,
            history::runtime_history_context,
            control::runtime_recording_context,
            hub_connect,
            hub_disconnect,
            hub_saved_endpoint,
            hub_read_start,
            hub_read_stop,
            hub_catalog,
            close::app_close_reply,
            project::project_open,
            project::project_save,
            alarm::alarm_apply,
            alarm::alarm_snapshot,
            alarm::alarm_ack,
            alarm::alarm_buzzer_silence,
            alarm::alarm_history,
            alarm::alarm_settings_get,
            alarm::alarm_settings_set,
            alarm::alarm_sound_import,
            alarm::alarm_sound_reset,
            alarm::alarm_sound_test,
            auth::auth_status,
            auth::auth_phase,
            auth::auth_setup,
            auth::auth_login,
            auth::auth_logout,
            auth::auth_resolve,
            auth::auth_change_password,
            auth::auth_transition_to_operational,
            auth::users_list,
            auth::users_create,
            auth::users_update,
            auth::users_reset_password,
            auth::users_delete,
            auth::auth_config_get,
            auth::auth_config_apply,
            history::history_context,
            history::history_query,
            history::history_cancel,
            control::recording_context,
            control::recording_status,
            control::recording_initial_setup,
            control::recording_slot,
            control::recording_stop,
            control::recording_resume,
            control::recording_reconfigure,
            control::recording_owner_rebind,
            recording::recording_workflow_reserve,
            recording::recording_workflow_resumption,
            recording::recording_workflow_lease,
            recording::recording_lease,
            recording::recording_admission,
            recording::recording_admission_inspection,
            recording::recording_observation,
            recording::recording_cancel,
            recording::recording_call_inspection,
            recording::recording_attach,
            recording::recording_control
        ])
}

fn main() {
    // The mode is decided first; a refused command line opens no window
    // (Runtime mode design §3).
    let cwd = std::env::current_dir().unwrap_or_default();
    let mode = match app_mode::parse_args(std::env::args_os().skip(1), &cwd) {
        Ok(mode) => mode,
        Err(error) => {
            app_mode::report_arg_error(&error);
            std::process::exit(2);
        }
    };
    let bootstrap = local_bootstrap().expect("SCADA settings store unavailable");
    // The recording DB and the History host. A store that cannot be opened
    // does not stop the app (product-owner design §3).
    let recording_runtime = match (local_data_dir(), local_installation_id()) {
        (Ok(dir), Ok(deployment)) => RecordingRuntime::start(&dir, &deployment),
        _ => RecordingRuntime::unavailable(NO_DATA_DIR),
    };
    // A failed auth start does not stop the app either: reading and editing
    // still work, and each auth command reports why (host-gate design §6).
    // The auth and the recording registry share one gate, whose slot stays
    // empty until a recording runs (product-owner design §4).
    let empty = match recording_runtime.unavailable_reason() {
        Some(_) => STORE_UNAVAILABLE,
        None => NO_RECORDING_RUN,
    };
    let (auth, recording) = match local_data_dir() {
        Ok(dir) => tauri::async_runtime::block_on(AuthState::start(&dir, empty)),
        Err(_) => (
            AuthState::unavailable(NO_DATA_DIR),
            DesktopRecording::unavailable(NO_DATA_DIR),
        ),
    };
    let alarm = tauri::async_runtime::block_on(alarm::AlarmState::open(local_data_dir()));
    // The single-instance plugin first (design §7). A second launch, whose
    // arguments were checked above, brings the first window forward and
    // exits inside `build`, before the setup below: it reads no Project.
    let builder = tauri::Builder::default().plugin(tauri_plugin_single_instance::init(
        app_mode::on_second_instance,
    ));
    commands(builder)
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let mode = app.state::<AppMode>();
            // Runtime reads its Project once, here (design §6).
            app.manage(runtime::StartupProject::load(&mode));
            app_mode::create_window(app, &mode)?;
            alarm::start_events(app.handle().clone());
            Ok(())
        })
        .manage(mode)
        .manage(NativeHost {
            bootstrap: std::sync::Arc::new(bootstrap),
            active: Mutex::new(Active::default()),
            alarm_operation: Mutex::new(()),
            exiting: AtomicBool::new(false),
        })
        .manage(auth)
        .manage(alarm)
        .manage(recording_runtime)
        .manage(recording)
        .build(tauri::generate_context!())
        .expect("SCADA desktop failed")
        .run(on_exit());
}

/// The exit (product-owner design §6): the first exit request is held while
/// the recording is stopped (at most [`control::EXIT_LIMIT`]), then the app
/// exits. Requests meanwhile are held too; the one after it proceeds.
fn on_exit<R: Runtime>() -> impl FnMut(&AppHandle<R>, RunEvent) {
    const RUNNING: u8 = 0;
    const STOPPING: u8 = 1;
    const DONE: u8 = 2;
    let state = Arc::new(AtomicU8::new(RUNNING));
    move |app, event| {
        let RunEvent::ExitRequested { api, .. } = event else {
            return;
        };
        match state.compare_exchange(RUNNING, STOPPING, Ordering::SeqCst, Ordering::SeqCst) {
            Ok(_) => {
                api.prevent_exit();
                app.state::<close::CloseGuard>().begin_exit();
                app.state::<NativeHost>()
                    .exiting
                    .store(true, Ordering::SeqCst);
                let app = app.clone();
                let state = state.clone();
                tauri::async_runtime::spawn(async move {
                    control::exit(&app).await;
                    let host = app.state::<NativeHost>();
                    let _alarm_operation = host.alarm_operation.lock().await;
                    if let Ok(alarm) = app.state::<alarm::AlarmState>().get() {
                        let _ = alarm.stop().await;
                    }
                    state.store(DONE, Ordering::SeqCst);
                    app.exit(0);
                });
            }
            Err(STOPPING) => api.prevent_exit(),
            Err(_) => {}
        }
    }
}
