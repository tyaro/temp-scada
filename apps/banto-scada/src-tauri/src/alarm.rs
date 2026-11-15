//! Tauri boundary for the one terminal-wide alarm owner.
use std::path::Path;
use std::sync::Arc;

use scada_host::alarm_db::{EventRead, UnackedOccurrence};
use scada_host::alarm_service::{
    AlarmService, AlarmServiceError, AlarmSnapshot, AppliedSummary, ApplyResult, RestClient,
};
use scada_host::auth::BantoError;
use scada_host::desktop_auth::CommandError;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::auth::AuthState;
use crate::project::ProjectFileState;
use crate::NativeHost;

pub struct AlarmState(Result<Arc<AlarmService>, String>);

impl AlarmState {
    #[cfg(test)]
    pub(crate) fn unavailable() -> Self {
        Self(Err("alarmUnavailable".into()))
    }
    pub async fn open(dir: Result<impl AsRef<Path>, impl std::fmt::Debug>) -> Self {
        match dir {
            Ok(dir) => Self(
                AlarmService::open(dir.as_ref())
                    .await
                    .map(Arc::new)
                    .map_err(|error| reason(&error)),
            ),
            Err(_) => Self(Err("noDataDir".into())),
        }
    }

    pub(crate) fn get(&self) -> Result<&Arc<AlarmService>, String> {
        self.0.as_ref().map_err(Clone::clone)
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

pub(crate) async fn authorized_user(auth: &AuthState) -> Result<String, String> {
    authorize(auth).await?;
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
        match hub_context(&host) {
            Ok((endpoint, client)) => {
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
    match hub_context(host) {
        Ok((endpoint, client)) => {
            let _ = service.stop().await;
            let _ = service.resume(Some(&endpoint), Some(client)).await;
        }
        Err(_) => {
            let _ = service.stop().await;
            let _ = service.resume(None, None).await;
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
) -> Result<ApplyResult, String> {
    let service = alarm.get()?;
    let (endpoint, client) = match hub_context(host) {
        Ok(context) => context,
        Err(reason) if !explicit && reason == "noHub" => return Ok(ApplyResult::SkippedNoHub),
        Err(reason) => return Err(reason),
    };
    match service
        .apply(path, &endpoint, client, user, confirmed, explicit)
        .await
    {
        Ok(result) => Ok(result),
        Err(AlarmServiceError::ConfirmationRequired(occurrences)) => {
            Ok(ApplyResult::ConfirmationRequired { occurrences })
        }
        Err(error) => Err(reason(&error)),
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
) -> Result<ApplyResult, String> {
    let user = authorized_user(&auth).await?;
    let path = files.0.path(file_id).ok_or("unknownFileId")?;
    apply_file(&alarm, &host, &path, &user, &confirmed, true).await
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
    let user = authorized_user(&auth).await?;
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
