//! Tauri boundary for the one terminal-wide alarm owner.
use std::path::Path;
use std::sync::Arc;

use scada_host::alarm_db::{EventRead, UnackedOccurrence};
use scada_host::alarm_service::{
    AlarmService, AlarmServiceError, AlarmSnapshot, AppliedSummary, ApplyMode, ApplyResult,
    RestClient,
};
use scada_host::auth::BantoError;
use scada_host::desktop_auth::CommandError;
use scada_host::CredentialIdentity;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

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
            Ok(dir) => AlarmService::open(dir.as_ref())
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

fn reason(error: &AlarmServiceError) -> String {
    match error {
        AlarmServiceError::Terminal(_) => "terminalUnavailable",
        AlarmServiceError::Db(_) => "alarmDbUnavailable",
        AlarmServiceError::Project(_) => "invalidProject",
        AlarmServiceError::Runtime(_) => "engineUnavailable",
        AlarmServiceError::NoHub => "noHub",
        AlarmServiceError::EndpointChanged => "endpointChanged",
        AlarmServiceError::NoMonitoredProject => "notApplied",
        AlarmServiceError::EngineStopped => "engineStopped",
        AlarmServiceError::ConfirmationRequired(_) => "confirmationRequired",
    }
    .into()
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

fn hub_context(host: &NativeHost) -> Result<(String, RestClient), String> {
    let record = host
        .bootstrap
        .record()
        .map_err(|_| "hubUnavailable")?
        .ok_or("noHub")?;
    let client = host
        .bootstrap
        .rest_client()
        .map_err(|_| "hubUnavailable")?
        .ok_or("noHub")?;
    Ok((record.endpoint, client))
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
        let (current, context) = {
            let _active = host.active.lock().await;
            (
                host.bootstrap.stored_credential().ok().flatten(),
                hub_context(&host),
            )
        };
        let alarm = app.state::<AlarmState>();
        let mut credential = alarm.credential.lock().await;
        match context {
            Ok((endpoint, client)) => {
                if service.resume(Some(&endpoint), Some(client)).await.is_ok() {
                    *credential = current;
                }
            }
            Err(_) => {
                let _ = service.resume(None, None).await;
            }
        }
    });
}

pub async fn after_hub_connect(
    host: &NativeHost,
    alarm: &AlarmState,
    judged: Option<CredentialIdentity>,
) {
    let Ok(service) = alarm.get() else {
        return;
    };
    let mut credential = alarm.credential.lock().await;
    if let Ok((endpoint, client)) = hub_context(host) {
        if *credential != judged && service.stop().await.is_err() {
            return;
        }
        if service.resume(Some(&endpoint), Some(client)).await.is_ok() {
            *credential = judged;
        }
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
    let _alarm_operation = host.alarm_operation.lock().await;
    if host.exiting.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("exiting".into());
    }
    let context = {
        let _active = host.active.lock().await;
        hub_context(host)
    };
    let (endpoint, client) = match context {
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
pub async fn alarm_apply(
    files: State<'_, ProjectFileState>,
    alarm: State<'_, AlarmState>,
    host: State<'_, NativeHost>,
    auth: State<'_, AuthState>,
    file_id: u64,
    confirmed: Vec<UnackedOccurrence>,
    confirmed_switch_from: Option<String>,
) -> Result<ApplyResult, String> {
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
                scada_host::alarm_runtime::AlarmRuntimeError::StorageFailure,
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
}
