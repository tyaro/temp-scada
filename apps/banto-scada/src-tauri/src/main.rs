//! One embedded read-only host. Hub services and PLC connections stay external.
mod auth;

use auth::AuthState;
use scada_host::{local_bootstrap, local_data_dir, Bootstrapper, HubStatus};
use scada_model::Project;
use scada_runtime::{CatalogHost, ReadDisplayStream, ReadHost};
use serde::Serialize;
use std::collections::HashSet;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

struct NativeHost {
    bootstrap: Bootstrapper,
    active: Mutex<Active>,
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

#[tauri::command]
async fn hub_connect(state: State<'_, NativeHost>, endpoint: String) -> Result<HubStatus, String> {
    let mut active = state.active.lock().await;
    stop_read(&mut active).await;
    active.connected = false;
    let result = state
        .bootstrap
        .connect(&endpoint)
        .await
        .map_err(|error| error.kind().as_str().to_owned())?;
    active.connected = result.status.is_connected();
    Ok(result.status)
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
    state: State<'_, NativeHost>,
    project_json: String,
    subscription_id: String,
) -> Result<(), String> {
    let project = Project::from_json(&project_json).map_err(|_| "invalid_project".to_owned())?;
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
    let mut read = ReadHost::new(&project).map_err(|_| "invalid_read_plan")?;
    read.replace(&project, Some(client))
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

#[tauri::command]
async fn hub_catalog(
    state: State<'_, NativeHost>,
    project_json: String,
) -> Result<scada_runtime::CatalogView, String> {
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
/// IPC tests.
fn commands<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        hub_connect,
        hub_disconnect,
        hub_saved_endpoint,
        hub_read_start,
        hub_read_stop,
        hub_catalog,
        auth::auth_status,
        auth::auth_phase,
        auth::auth_setup,
        auth::auth_login,
        auth::auth_logout,
        auth::auth_resolve,
        auth::auth_change_password,
        auth::auth_transition_to_operational
    ])
}

fn main() {
    let bootstrap = local_bootstrap().expect("SCADA settings store unavailable");
    // A failed auth start does not stop the app: reading and editing still
    // work, and each auth command reports why (host-gate design §6).
    let auth = match local_data_dir() {
        Ok(dir) => tauri::async_runtime::block_on(AuthState::start(&dir)),
        Err(_) => AuthState::unavailable("no_data_dir"),
    };
    commands(tauri::Builder::default())
        .manage(NativeHost {
            bootstrap,
            active: Mutex::new(Active::default()),
        })
        .manage(auth)
        .run(tauri::generate_context!())
        .expect("SCADA desktop failed");
}
