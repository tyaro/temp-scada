//! Tauri boundary for the one terminal-wide alarm owner.
use std::path::{Path, PathBuf};
use std::sync::Arc;

use scada_host::alarm_db::{EventRead, UnackedOccurrence};
use scada_host::alarm_service::{
    AlarmService, AlarmServiceError, AlarmSettingsView, AlarmSnapshot, AppliedSummary, ApplyMode,
    ApplyResult, HubClients,
};
use scada_host::alarm_terminal::alarm_sound::MAX_SOUND_BYTES;
use scada_host::alarm_terminal::{AlarmSettings, WavRejection};
use scada_host::auth::BantoError;
use scada_host::desktop_auth::CommandError;
use scada_host::CredentialIdentity;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::app_mode::AppMode;
use crate::auth::AuthState;
use crate::project::ProjectFileState;
use crate::NativeHost;

pub struct AlarmState {
    service: Result<Arc<AlarmService>, String>,
    credential: tokio::sync::Mutex<Option<CredentialIdentity>>,
}

impl AlarmState {
    #[cfg(test)]
    pub(crate) fn unavailable() -> Self {
        Self {
            service: Err("alarmUnavailable".into()),
            credential: tokio::sync::Mutex::new(None),
        }
    }
    pub async fn open(dir: Result<impl AsRef<Path>, impl std::fmt::Debug>) -> Self {
        let service = match dir {
            Ok(dir) => AlarmService::open_with_buzzer(dir.as_ref(), crate::buzzer::player())
                .await
                .map(Arc::new)
                .map_err(|error| reason(&error)),
            Err(_) => Err("noDataDir".into()),
        };
        Self {
            service,
            credential: tokio::sync::Mutex::new(None),
        }
    }

    pub(crate) fn get(&self) -> Result<&Arc<AlarmService>, String> {
        self.service.as_ref().map_err(Clone::clone)
    }
}

pub(crate) fn reason(error: &AlarmServiceError) -> String {
    match error {
        AlarmServiceError::Terminal(_) => "terminalUnavailable",
        AlarmServiceError::Db(_) => "alarmDbUnavailable",
        AlarmServiceError::Project(_) => "invalidProject",
        AlarmServiceError::Runtime(
            scada_host::alarm_runtime::AlarmRuntimeError::HistoryUnwritable,
        ) => "historyUnwritable",
        AlarmServiceError::Runtime(_) => "engineUnavailable",
        AlarmServiceError::NoHub => "noHub",
        AlarmServiceError::EndpointChanged => "endpointChanged",
        AlarmServiceError::NoMonitoredProject => "notApplied",
        AlarmServiceError::EngineStopped => "engineStopped",
        AlarmServiceError::ConfirmationRequired(_) => "confirmationRequired",
        AlarmServiceError::InvalidSettings => "invalidSettings",
        AlarmServiceError::InvalidSound(rejection) => return invalid_sound(*rejection),
        AlarmServiceError::BuzzerRinging => "buzzerRinging",
    }
    .into()
}

/// `invalidSound:<rejection>`, e.g. `invalidSound:tooLong`.
fn invalid_sound(rejection: WavRejection) -> String {
    let name = serde_json::to_value(rejection)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default();
    format!("invalidSound:{name}")
}

fn apply_failure_reason(error: &AlarmServiceError) -> String {
    match error {
        AlarmServiceError::Terminal(_) => "terminalStateFailed".into(),
        error => reason(error),
    }
}

fn refusal(error: CommandError) -> String {
    match error {
        CommandError::Banto(BantoError::Unauthorized) => "unauthorized",
        CommandError::Banto(BantoError::Forbidden) => "forbidden",
        CommandError::Unavailable(_) => "auth_unavailable",
        _ => "auth_failed",
    }
    .into()
}

pub(crate) async fn authorize(auth: &AuthState) -> Result<(), String> {
    auth.get()
        .map_err(refusal)?
        .authorize_project_save()
        .await
        .map_err(refusal)
}

pub(crate) async fn applied_user(auth: &AuthState) -> Result<String, String> {
    let host = auth.get().map_err(refusal)?;
    let identity = host.resolve().await.map_err(refusal)?;
    Ok(if identity.kind == Some("local") {
        "未ログイン".into()
    } else {
        identity
            .identity
            .map(|identity| identity.name)
            .ok_or("unauthorized")?
    })
}

async fn verify_alarm_phase(auth: &AuthState) -> Result<(), String> {
    let phase = auth
        .get()
        .map_err(refusal)?
        .phase()
        .await
        .map_err(refusal)?;
    if matches!(phase.phase, "initializing" | "operational") {
        Ok(())
    } else {
        Err("auth_phase_unavailable".into())
    }
}

pub(crate) async fn authorized_user(auth: &AuthState) -> Result<String, String> {
    verify_alarm_phase(auth).await?;
    authorize(auth).await?;
    applied_user(auth).await
}

async fn authorized_ack_user(auth: &AuthState) -> Result<String, String> {
    verify_alarm_phase(auth).await?;
    auth.get()
        .map_err(refusal)?
        .authorize_alarm_ack()
        .await
        .map_err(refusal)?;
    applied_user(auth).await
}

async fn authorize_alarm_settings(auth: &AuthState) -> Result<(), String> {
    verify_alarm_phase(auth).await?;
    auth.get()
        .map_err(refusal)?
        .authorize_alarm_settings()
        .await
        .map_err(refusal)
}

/// The applied endpoint, the clients the Engine reads with, and the identity
/// of the stored key those clients use. The identity comes from the same
/// saved record and key as the clients (`rest_client` builds only from the
/// stored key), so start-up and reconnects compare the same thing. Callers
/// hold `host.active` so `hub_connect` cannot change the record in between.
fn hub_context(
    host: &NativeHost,
) -> Result<(String, HubClients, Option<CredentialIdentity>), String> {
    let record = host
        .bootstrap
        .record()
        .map_err(|_| "hubUnavailable")?
        .ok_or("noHub")?;
    host.bootstrap
        .rest_client()
        .map_err(|_| "hubUnavailable")?
        .ok_or("noHub")?;
    let credential = host
        .bootstrap
        .stored_credential()
        .map_err(|_| "hubUnavailable")?;
    // The Engine makes more clients later (rereads, resubscription). Each
    // one is refused once the saved Hub record names another endpoint.
    let bootstrap = host.bootstrap.clone();
    let endpoint = record.endpoint.clone();
    let clients = HubClients::new(move || {
        let current = bootstrap.record().ok()??;
        if current.endpoint != endpoint {
            return None;
        }
        bootstrap.rest_client().ok()?
    });
    Ok((record.endpoint, clients, credential))
}

pub fn start_events<R: Runtime>(app: AppHandle<R>) {
    let Ok(service) = app.state::<AlarmState>().get().cloned() else {
        return;
    };
    let mut changes = service.changes();
    let mut lagged = service.lagged();
    let events = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match changes.recv().await {
                Ok(change) => {
                    let _ = events.emit(
                        "alarm_changed",
                        serde_json::json!({
                            "session": change.session,
                            "seq": change.seq,
                            "conditions": change.conditions,
                            "engineUnavailable": change.engine_unavailable,
                            "events": change.events,
                            "applied": change.applied.as_ref().map(AppliedSummary::from),
                        }),
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let _ = events.emit("alarm_changed_lagged", ());
                }
                Err(_) => break,
            }
        }
    });
    let lag_events = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok(()) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) =
            lagged.recv().await
        {
            let _ = lag_events.emit("alarm_changed_lagged", ());
        }
    });
    tauri::async_runtime::spawn(async move {
        let host = app.state::<NativeHost>();
        let _alarm_operation = host.alarm_operation.lock().await;
        if host.exiting.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let context = {
            let _active = host.active.lock().await;
            hub_context(&host)
        };
        let alarm = app.state::<AlarmState>();
        let mut credential = alarm.credential.lock().await;
        match context {
            Ok((endpoint, client, current)) => {
                *credential = current;
                let _ = service.resume(Some(&endpoint), Some(client)).await;
            }
            Err(_) => {
                let _ = service.resume(None, None).await;
            }
        }
    });
}

pub async fn after_hub_connect(host: &NativeHost, alarm: &AlarmState) {
    let Ok(service) = alarm.get() else {
        return;
    };
    let mut credential = alarm.credential.lock().await;
    let context = {
        let _active = host.active.lock().await;
        hub_context(host)
    };
    if let Ok((endpoint, client, current)) = context {
        if *credential != current && service.stop().await.is_err() {
            return;
        }
        *credential = current;
        let _ = service.resume(Some(&endpoint), Some(client)).await;
    } else {
        let _ = service.stop().await;
        *credential = None;
        let _ = service.resume(None, None).await;
    }
}

pub async fn apply_file(
    alarm: &AlarmState,
    host: &NativeHost,
    path: &Path,
    user: &str,
    confirmed: &[UnackedOccurrence],
    explicit: bool,
    confirmed_switch_from: Option<&str>,
) -> Result<ApplyResult, String> {
    let service = alarm.get()?;
    let _alarm_operation = if explicit {
        host.alarm_operation.lock().await
    } else {
        match host.alarm_operation.try_lock() {
            Ok(guard) => guard,
            Err(_) => return Ok(ApplyResult::SkippedBusy),
        }
    };
    if host.exiting.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("exiting".into());
    }
    let context = {
        let _active = host.active.lock().await;
        hub_context(host)
    };
    let (endpoint, client, _) = match context {
        Ok(context) => context,
        Err(reason) if !explicit && reason == "noHub" => return Ok(ApplyResult::SkippedNoHub),
        Err(reason) => return Err(reason),
    };
    let mode = if explicit {
        ApplyMode::Explicit {
            confirmed_switch_from,
        }
    } else {
        ApplyMode::Saved
    };
    match service
        .apply(path, &endpoint, client, user, confirmed, mode)
        .await
    {
        Ok(result) => Ok(result),
        Err(AlarmServiceError::ConfirmationRequired(occurrences)) => {
            Ok(ApplyResult::ConfirmationRequired { occurrences })
        }
        Err(error) => Err(apply_failure_reason(&error)),
    }
}

#[tauri::command]
// Each host state is a separate Tauri state argument.
#[allow(clippy::too_many_arguments)]
pub async fn alarm_apply(
    mode: State<'_, AppMode>,
    files: State<'_, ProjectFileState>,
    alarm: State<'_, AlarmState>,
    host: State<'_, NativeHost>,
    auth: State<'_, AuthState>,
    file_id: u64,
    confirmed: Vec<UnackedOccurrence>,
    confirmed_switch_from: Option<String>,
) -> Result<ApplyResult, String> {
    mode.require_editor()?;
    let user = authorized_user(&auth).await?;
    let path = files.0.path(file_id).ok_or("unknownFileId")?;
    apply_file(
        &alarm,
        &host,
        &path,
        &user,
        &confirmed,
        true,
        confirmed_switch_from.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn alarm_snapshot(alarm: State<'_, AlarmState>) -> Result<AlarmSnapshot, String> {
    alarm
        .get()?
        .snapshot()
        .await
        .map_err(|error| reason(&error))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AckRequest {
    condition_id: String,
    occurrence: String,
    recurrence: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AckResult {
    condition_id: String,
    result: serde_json::Value,
}

#[tauri::command]
pub async fn alarm_ack(
    alarm: State<'_, AlarmState>,
    auth: State<'_, AuthState>,
    items: Vec<AckRequest>,
) -> Result<Vec<AckResult>, String> {
    let user = authorized_ack_user(&auth).await?;
    let service = alarm.get()?;
    let mut results = Vec::new();
    for item in items {
        let result = match service
            .ack(
                item.condition_id.clone(),
                item.occurrence,
                item.recurrence,
                user.clone(),
            )
            .await
        {
            Ok(outcome) => serde_json::json!({"kind": outcome}),
            Err(AlarmServiceError::EngineStopped) => {
                let reason = service
                    .snapshot()
                    .await
                    .map(|snapshot| snapshot.status)
                    .unwrap_or_else(|_| "stopped".into());
                serde_json::json!({"kind":"engineStopped","reason":reason})
            }
            Err(AlarmServiceError::Runtime(
                scada_host::alarm_runtime::AlarmRuntimeError::StorageFailure
                | scada_host::alarm_runtime::AlarmRuntimeError::HistoryUnwritable,
            )) => {
                serde_json::json!({"kind":"historyUnavailable"})
            }
            Err(error) => serde_json::json!({"kind":"failed","reason":reason(&error)}),
        };
        results.push(AckResult {
            condition_id: item.condition_id,
            result,
        });
    }
    Ok(results)
}

/// Silence this terminal's buzzer (design §6). Not an ACK: no login, no
/// phase check and no `alarm_operation` lock, so it works while an apply or
/// ACK is in progress.
#[tauri::command]
pub fn alarm_buzzer_silence(
    alarm: State<'_, AlarmState>,
) -> Result<scada_host::alarm_buzzer::BuzzerStatus, String> {
    Ok(alarm.get()?.silence_buzzer())
}

#[tauri::command]
pub async fn alarm_history(
    alarm: State<'_, AlarmState>,
    before_seq: Option<i64>,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
    kind: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<EventRead>, String> {
    alarm
        .get()?
        .history(
            before_seq,
            from_ms,
            to_ms,
            kind.as_deref(),
            limit.unwrap_or(100),
        )
        .await
        .map_err(|error| reason(&error))
}

/// The alarm terminal settings with the monitored Project's retention status
/// (terminal settings design §6). No authorization; `terminalUnavailable`
/// when the terminal settings could not be opened.
#[tauri::command]
pub async fn alarm_settings_get(alarm: State<'_, AlarmState>) -> Result<AlarmSettingsView, String> {
    let service = alarm.get()?.clone();
    service
        .alarm_settings()
        .await
        .map_err(|error| reason(&error))
}

/// Save the retention and reread values. Admin only, with the same phase
/// check as ACK; refused while the terminal settings are unavailable.
#[tauri::command]
pub async fn alarm_settings_set(
    alarm: State<'_, AlarmState>,
    auth: State<'_, AuthState>,
    settings: AlarmSettings,
) -> Result<AlarmSettingsView, String> {
    let service = alarm.get()?.clone();
    authorize_alarm_settings(&auth).await?;
    service
        .set_alarm_settings(settings)
        .await
        .map_err(|error| reason(&error))
}

async fn pick_wav<R: Runtime>(window: &WebviewWindow<R>) -> Option<PathBuf> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(window)
        .set_title("警報の音を選ぶ")
        .add_filter("WAV", &["wav"])
        .pick_file(move |path| {
            let _ = sender.send(path);
        });
    receiver.await.ok().flatten()?.into_path().ok()
}

/// Read the picked file and import it (terminal settings design §5). Only
/// its file name leaves the host; a file beyond 1 MB is not read whole.
async fn import_picked(service: &AlarmService, path: PathBuf) -> Result<AlarmSettingsView, String> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let file = std::fs::File::open(&path).map_err(|_| "soundUnreadable".to_owned())?;
        let mut bytes = Vec::new();
        file.take(MAX_SOUND_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "soundUnreadable".to_owned())?;
        if bytes.len() > MAX_SOUND_BYTES {
            return Err(invalid_sound(WavRejection::TooLarge));
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| "soundUnreadable".to_owned())??;
    service
        .import_sound(name, bytes)
        .await
        .map_err(|error| reason(&error))
}

/// Pick a WAV in the host's dialog and import it as the buzzer sound. Admin
/// only like `alarm_settings_set`; refused while the terminal settings are
/// unavailable. Cancelling changes nothing (`None`). The webview never sees
/// the path.
#[tauri::command]
pub async fn alarm_sound_import<R: Runtime>(
    window: WebviewWindow<R>,
    mode: State<'_, AppMode>,
    alarm: State<'_, AlarmState>,
    auth: State<'_, AuthState>,
) -> Result<Option<AlarmSettingsView>, String> {
    mode.require_editor()?;
    let service = alarm.get()?.clone();
    authorize_alarm_settings(&auth).await?;
    let Some(path) = pick_wav(&window).await else {
        return Ok(None);
    };
    import_picked(&service, path).await.map(Some)
}

/// Back to the bundled beep. Admin only; refused while the terminal
/// settings are unavailable.
#[tauri::command]
pub async fn alarm_sound_reset(
    alarm: State<'_, AlarmState>,
    auth: State<'_, AuthState>,
) -> Result<AlarmSettingsView, String> {
    let service = alarm.get()?.clone();
    authorize_alarm_settings(&auth).await?;
    service.reset_sound().await.map_err(|error| reason(&error))
}

/// Play the current sound once. No authorization; `buzzerRinging` while the
/// buzzer rings. Without the terminal settings, the bundled beep plays.
#[tauri::command]
pub fn alarm_sound_test(alarm: State<'_, AlarmState>) -> Result<(), String> {
    test_sound(&alarm, crate::buzzer::player)
}

fn test_sound(
    alarm: &AlarmState,
    beep: impl FnOnce() -> Arc<dyn scada_host::alarm_buzzer::BuzzerPlayer>,
) -> Result<(), String> {
    match alarm.get() {
        Ok(service) => service.test_sound().map_err(|error| reason(&error)),
        Err(_) => {
            beep().play_once();
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use scada_host::alarm_terminal::TerminalError;

    #[test]
    fn terminal_failure_during_apply_is_not_an_unavailable_engine() {
        let error = AlarmServiceError::Terminal(TerminalError::Unreadable);
        assert_eq!(reason(&error), "terminalUnavailable");
        assert_eq!(apply_failure_reason(&error), "terminalStateFailed");
    }

    #[test]
    fn settings_are_refused_while_the_terminal_is_unavailable_and_checked_by_the_host() {
        let state = AlarmState {
            service: Err(reason(&AlarmServiceError::Terminal(
                TerminalError::Unreadable,
            ))),
            credential: tokio::sync::Mutex::new(None),
        };
        assert_eq!(state.get().err().as_deref(), Some("terminalUnavailable"));
        assert_eq!(
            reason(&AlarmServiceError::from(TerminalError::InvalidSettings)),
            "invalidSettings"
        );
        // The command argument uses the design's camelCase names.
        let settings: AlarmSettings = serde_json::from_value(serde_json::json!({
            "retention": {"kind": "count", "days": 365, "count": 20000},
            "reread": {"intervalSec": 10, "timeoutSec": 5, "failureLimitSec": 30, "reconnectFailures": 3},
        }))
        .unwrap();
        assert!(settings.is_valid());
    }

    #[tokio::test]
    async fn a_picked_wav_is_imported_and_a_bad_one_is_refused_by_name() {
        let dir = std::env::temp_dir().join(format!(
            "banto-scada-alarm-sound-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let service = AlarmService::open(&dir).await.unwrap();
        let picked = dir.join("bell.wav");
        std::fs::write(&picked, crate::buzzer::beep_wav()).unwrap();
        let view = import_picked(&service, picked).await.unwrap();
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["sound"]["kind"], "custom");
        assert_eq!(json["sound"]["name"], "bell.wav");
        assert_eq!(json["soundFallback"], serde_json::Value::Null);
        assert_eq!(
            serde_json::to_value(service.snapshot().await.unwrap()).unwrap()["buzzerSound"],
            serde_json::json!({"kind": "custom", "fallback": null})
        );
        let big = dir.join("big.wav");
        std::fs::write(&big, vec![0u8; MAX_SOUND_BYTES + 1]).unwrap();
        assert_eq!(
            import_picked(&service, big).await.err().as_deref(),
            Some("invalidSound:tooLarge")
        );
        let text = dir.join("note.wav");
        std::fs::write(&text, b"hello").unwrap();
        assert_eq!(
            import_picked(&service, text).await.err().as_deref(),
            Some("invalidSound:notWav")
        );
        assert_eq!(
            import_picked(&service, dir.join("missing.wav"))
                .await
                .err()
                .as_deref(),
            Some("soundUnreadable")
        );
        let view = service.reset_sound().await.unwrap();
        assert_eq!(
            serde_json::to_value(&view).unwrap()["sound"]["kind"],
            "default"
        );
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_test_sound_without_terminal_settings_plays_the_beep() {
        use scada_host::alarm_buzzer::BuzzerPlayer;
        use std::sync::atomic::{AtomicUsize, Ordering};
        #[derive(Default)]
        struct Count(AtomicUsize);
        impl BuzzerPlayer for Count {
            fn play_loop(&self) {}
            fn play_once(&self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
            fn stop(&self) {}
        }
        let count = Arc::new(Count::default());
        let player = count.clone();
        assert_eq!(
            test_sound(&AlarmState::unavailable(), move || player),
            Ok(())
        );
        assert_eq!(count.0.load(Ordering::SeqCst), 1);
        assert_eq!(reason(&AlarmServiceError::BuzzerRinging), "buzzerRinging");
    }
}
