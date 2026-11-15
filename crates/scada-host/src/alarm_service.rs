//! One terminal-wide owner of the alarm subscription and applied Project.
//! Callers supply only a host-resolved saved path and the protected Hub client.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use banto_tagclient::RestClient;
use scada_alarm::{AckOutcome, Session};
use serde::Serialize;
use tokio::sync::{broadcast, Mutex};
use tokio::task::JoinHandle;

use crate::alarm_db::{
    plan_apply, plan_restore, AlarmDb, AlarmDbError, AppliedDefinitions, EventRead,
    UnackedOccurrence,
};
use crate::alarm_project::{AlarmProjectError, SavedAlarmProject};
use crate::alarm_runtime::{
    AlarmChange, AlarmEvaluator, AlarmRuntime, AlarmRuntimeError, AlarmRuntimeStatus,
};
use crate::alarm_terminal::{AlarmTerminal, MonitoredProject, PendingSwitch, TerminalError};

#[derive(Debug)]
pub enum AlarmServiceError {
    Terminal(TerminalError),
    Db(AlarmDbError),
    Project(AlarmProjectError),
    Runtime(AlarmRuntimeError),
    NoHub,
    EndpointChanged,
    NoMonitoredProject,
    EngineStopped,
    ConfirmationRequired(Vec<UnackedOccurrence>),
}

impl From<AlarmDbError> for AlarmServiceError {
    fn from(error: AlarmDbError) -> Self {
        match error {
            AlarmDbError::ConfirmationRequired(rows) => Self::ConfirmationRequired(rows),
            other => Self::Db(other),
        }
    }
}
impl From<TerminalError> for AlarmServiceError {
    fn from(error: TerminalError) -> Self {
        Self::Terminal(error)
    }
}
impl From<AlarmProjectError> for AlarmServiceError {
    fn from(error: AlarmProjectError) -> Self {
        Self::Project(error)
    }
}
impl From<AlarmRuntimeError> for AlarmServiceError {
    fn from(error: AlarmRuntimeError) -> Self {
        match error {
            AlarmRuntimeError::Db(AlarmDbError::ConfirmationRequired(rows)) => {
                Self::ConfirmationRequired(rows)
            }
            other => Self::Runtime(other),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmSnapshot {
    pub monitored: Option<MonitoredIdentity>,
    pub applied: Option<AppliedSummary>,
    pub engine: Option<EngineSnapshot>,
    pub status: String,
    pub pending_condition_changes: bool,
    pub pending_display_changes: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitoredIdentity {
    pub project_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedSummary {
    pub project_id: String,
    pub project_revision: u64,
    pub applied_at_ms: i64,
    pub displays: BTreeMap<String, crate::alarm_db::ConditionDisplay>,
}

impl From<&AppliedDefinitions> for AppliedSummary {
    fn from(applied: &AppliedDefinitions) -> Self {
        Self {
            project_id: applied.project_id.clone(),
            project_revision: applied.project_revision,
            applied_at_ms: applied.applied_at_ms,
            displays: applied.displays.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineSnapshot {
    pub session: Session,
    pub seq: u64,
    pub unavailable: Option<scada_alarm::EngineUnavailable>,
    pub conditions: BTreeMap<String, scada_alarm::ConditionState>,
}

impl From<scada_alarm::Engine> for EngineSnapshot {
    fn from(engine: scada_alarm::Engine) -> Self {
        Self {
            session: engine.session().clone(),
            seq: engine.seq(),
            unavailable: engine.unavailable(),
            conditions: engine
                .conditions()
                .iter()
                .map(|(id, row)| (id.clone(), row.state.clone()))
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum ApplyResult {
    Applied {
        snapshot: AlarmSnapshot,
        #[serde(skip_serializing_if = "Option::is_none")]
        warning: Option<String>,
    },
    SkippedDifferentProject,
    SkippedEndpointChanged,
    SkippedNoHub,
    SwitchConfirmationRequired {
        monitored_project_id: String,
    },
    ConfirmationRequired {
        occurrences: Vec<UnackedOccurrence>,
    },
}

#[derive(Clone, Copy)]
pub enum ApplyMode<'a> {
    Saved,
    Explicit {
        confirmed_switch_from: Option<&'a str>,
    },
}

struct Active {
    runtime: Option<AlarmRuntime>,
    db: Option<Arc<AlarmDb>>,
    project_id: Option<String>,
    applied: Option<AppliedDefinitions>,
    pump: Option<JoinHandle<()>>,
    reason: String,
}

struct PendingCache {
    path: PathBuf,
    modified: Option<std::time::SystemTime>,
    len: u64,
    applied_at_ms: i64,
    condition: bool,
    display: bool,
}

pub struct AlarmService {
    terminal: Arc<AlarmTerminal>,
    active: Mutex<Active>,
    pending_cache: Mutex<Option<PendingCache>>,
    changes: broadcast::Sender<AlarmChange>,
    lagged: broadcast::Sender<()>,
}

impl AlarmService {
    pub async fn open(data_dir: &Path) -> Result<Self, AlarmServiceError> {
        let terminal = Arc::new(AlarmTerminal::open(data_dir).await?);
        let (changes, _) = broadcast::channel(256);
        let (lagged, _) = broadcast::channel(16);
        let service = Self {
            terminal,
            active: Mutex::new(Active {
                runtime: None,
                db: None,
                project_id: None,
                applied: None,
                pump: None,
                reason: "notApplied".into(),
            }),
            pending_cache: Mutex::new(None),
            changes,
            lagged,
        };
        if service.recover_switch().await.is_err() {
            service.active.lock().await.reason = "switchRecoveryFailed".into();
        }
        Ok(service)
    }

    pub fn changes(&self) -> broadcast::Receiver<AlarmChange> {
        self.changes.subscribe()
    }

    pub fn lagged(&self) -> broadcast::Receiver<()> {
        self.lagged.subscribe()
    }

    async fn recover_switch(&self) -> Result<(), AlarmServiceError> {
        let Some(switching) = self.terminal.switching()? else {
            return Ok(());
        };
        let target_db = AlarmDb::open(self.terminal.clone(), &switching.target.project_id).await?;
        let applied = target_db.applied().await;
        target_db.close().await;
        let committed = applied?.is_some_and(|applied| {
            applied.file_hash == switching.file_hash
                && applied.applied_at_ms == switching.applied_at_ms
        });
        if committed {
            if let Some(old) = self.terminal.monitored()? {
                if old.project_id != switching.target.project_id {
                    let old_db = AlarmDb::open(self.terminal.clone(), &old.project_id).await?;
                    old_db.close_unstopped_session(wall_ms()).await?;
                    let confirmed = all_unacked(&old_db.last_states().await?)?;
                    old_db.end_monitoring(wall_ms(), &confirmed).await?;
                    old_db.close().await;
                }
            }
            self.terminal.set_monitored(Some(switching.target))?;
        } else {
            self.terminal.set_switching(None)?;
        }
        Ok(())
    }

    pub async fn resume(
        &self,
        endpoint: Option<&str>,
        client: Option<RestClient>,
    ) -> Result<AlarmSnapshot, AlarmServiceError> {
        let mut active = self.active.lock().await;
        if self.recover_switch().await.is_err() {
            active.reason = "switchRecoveryFailed".into();
            let snapshot = self.snapshot_locked(&active).await;
            let _ = self.lagged.send(());
            return snapshot;
        }
        if active.reason == "switchRecoveryFailed" {
            active.reason = "stopped".into();
        }
        if active.runtime.as_ref().is_some_and(|runtime| {
            matches!(*runtime.status().borrow(), AlarmRuntimeStatus::Running)
                && active
                    .applied
                    .as_ref()
                    .is_some_and(|applied| endpoint.is_some_and(|value| value != applied.endpoint))
        }) {
            let result = Self::stop_locked(&mut active).await;
            if let Err(error) = result {
                let _ = self.lagged.send(());
                return Err(error);
            }
        }
        if active.runtime.as_ref().is_some_and(|runtime| {
            !matches!(*runtime.status().borrow(), AlarmRuntimeStatus::Running)
        }) {
            let runtime = active.runtime.take().expect("checked runtime");
            let _ = runtime.stop().await;
            if let Some(pump) = active.pump.take() {
                pump.abort();
            }
            active.db = None;
        }
        if active.runtime.is_none() {
            if let Err(error) = self.start_locked(&mut active, endpoint, client).await {
                active.reason = stopped_reason(&error).into();
            }
        }
        let snapshot = self.snapshot_locked(&active).await;
        let _ = self.lagged.send(());
        snapshot
    }

    async fn start_locked(
        &self,
        active: &mut Active,
        endpoint: Option<&str>,
        client: Option<RestClient>,
    ) -> Result<(), AlarmServiceError> {
        let Some(monitored) = self.terminal.monitored()? else {
            active.project_id = None;
            active.applied = None;
            active.reason = "notApplied".into();
            return Ok(());
        };
        let db = Arc::new(AlarmDb::open(self.terminal.clone(), &monitored.project_id).await?);
        active.project_id = Some(monitored.project_id.clone());
        let Some(applied) = db.applied().await? else {
            active.applied = None;
            active.reason = "notApplied".into();
            return Ok(());
        };
        active.applied = Some(applied.clone());
        let Some(endpoint) = endpoint else {
            active.reason = "noHub".into();
            return Ok(());
        };
        if endpoint != applied.endpoint {
            active.reason = "endpointChanged".into();
            return Ok(());
        }
        let Some(client) = client else {
            active.reason = "noHub".into();
            return Ok(());
        };
        let saved = SavedAlarmProject::from_applied(&applied)?;
        if saved.definitions.is_empty() {
            active.reason = "noConditions".into();
            return Ok(());
        }
        let rows = db.last_states().await?;
        let at_ms = wall_ms();
        let generation = self.terminal.reserve_generation()?;
        let session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            generation,
        };
        let plan = plan_restore(
            session,
            endpoint,
            at_ms,
            &applied,
            &saved.definitions,
            &saved.disabled,
            &rows,
        )
        .map_err(|_| AlarmServiceError::Project(AlarmProjectError::InvalidFile))?;
        let engine = db.start_session_plan(plan, at_ms).await?;
        let evaluator = AlarmEvaluator::new(db.clone(), applied, engine).await?;
        let runtime = AlarmRuntime::start_with_client(evaluator, client).await?;
        self.attach(active, runtime, db, monitored.project_id);
        Ok(())
    }

    fn attach(
        &self,
        active: &mut Active,
        runtime: AlarmRuntime,
        db: Arc<AlarmDb>,
        project_id: String,
    ) {
        let mut receiver = runtime.changes();
        let mut status = runtime.status();
        let sender = self.changes.clone();
        let lagged = self.lagged.clone();
        active.pump = Some(tokio::spawn(async move {
            if !matches!(*status.borrow(), AlarmRuntimeStatus::Running) {
                let _ = lagged.send(());
                return;
            }
            loop {
                tokio::select! {
                    state = status.changed() => {
                        if state.is_err() || !matches!(*status.borrow(), AlarmRuntimeStatus::Running) {
                            let _ = lagged.send(());
                            break;
                        }
                    }
                    change = receiver.recv() => match change {
                        Ok(change) => { let _ = sender.send(change); }
                        Err(broadcast::error::RecvError::Lagged(_)) => { let _ = lagged.send(()); }
                        Err(_) => break,
                    },
                }
            }
        }));
        active.runtime = Some(runtime);
        active.db = Some(db);
        active.project_id = Some(project_id);
        active.reason = "running".into();
    }

    async fn stop_locked(active: &mut Active) -> Result<(), AlarmServiceError> {
        let result = if let Some(runtime) = active.runtime.take() {
            let running = matches!(*runtime.status().borrow(), AlarmRuntimeStatus::Running);
            let result = runtime.stop().await;
            if running {
                match result {
                    Ok(()) => Ok(()),
                    Err(error)
                        if matches!(
                            error,
                            AlarmRuntimeError::Sdk(_)
                                | AlarmRuntimeError::ConnectionFailure
                                | AlarmRuntimeError::Closed
                        ) =>
                    {
                        // A concurrent SDK exit may report its transport error after
                        // the session stop has already committed. The DB is decisive.
                        match active.db.as_ref() {
                            Some(db) if db.session().await?.is_some_and(|row| row.stopped) => {
                                Ok(())
                            }
                            _ => Err(error.into()),
                        }
                    }
                    Err(error) => Err(error.into()),
                }
            } else {
                Ok(())
            }
        } else {
            Ok(())
        };
        if let Some(pump) = active.pump.take() {
            pump.abort();
        }
        active.db = None;
        active.reason = "stopped".into();
        result
    }

    pub async fn stop(&self) -> Result<(), AlarmServiceError> {
        let mut active = self.active.lock().await;
        let result = Self::stop_locked(&mut active).await;
        let _ = self.lagged.send(());
        result
    }

    pub async fn apply(
        &self,
        path: &Path,
        endpoint: &str,
        client: RestClient,
        applied_by: &str,
        confirmed: &[UnackedOccurrence],
        mode: ApplyMode<'_>,
    ) -> Result<ApplyResult, AlarmServiceError> {
        let path = path.to_path_buf();
        let saved = tokio::task::spawn_blocking({
            let path = path.clone();
            move || SavedAlarmProject::read(&path)
        })
        .await
        .map_err(|_| AlarmServiceError::Project(AlarmProjectError::InvalidFile))??;
        let mut active = self.active.lock().await;
        if let Err(error) = self.recover_switch().await {
            active.reason = "switchRecoveryFailed".into();
            return Err(error);
        }
        if active.reason == "switchRecoveryFailed" {
            active.reason = "stopped".into();
            let _ = self.lagged.send(());
        }
        let previous = self.terminal.monitored()?;
        if matches!(mode, ApplyMode::Saved)
            && previous
                .as_ref()
                .is_some_and(|old| old.project_id != saved.project_id)
        {
            return Ok(ApplyResult::SkippedDifferentProject);
        }
        if let ApplyMode::Explicit {
            confirmed_switch_from,
        } = mode
        {
            if let Some(old) = &previous {
                if old.project_id != saved.project_id
                    && confirmed_switch_from != Some(old.project_id.as_str())
                {
                    return Ok(ApplyResult::SwitchConfirmationRequired {
                        monitored_project_id: old.project_id.clone(),
                    });
                }
            }
        }
        let mut applied = saved.applied(endpoint.into(), applied_by.into(), wall_ms());
        let same_project = previous
            .as_ref()
            .is_some_and(|old| old.project_id == saved.project_id);
        let old_applied = if let Some(old) = &previous {
            if active.project_id.as_deref() == Some(old.project_id.as_str())
                && active.applied.is_some()
            {
                active.applied.clone()
            } else {
                let db = AlarmDb::open(self.terminal.clone(), &old.project_id).await?;
                let applied = db.applied().await?;
                db.close().await;
                applied
            }
        } else {
            None
        };
        if matches!(mode, ApplyMode::Saved)
            && old_applied
                .as_ref()
                .is_some_and(|old| old.endpoint != endpoint)
        {
            return Ok(ApplyResult::SkippedEndpointChanged);
        }
        if same_project {
            if let Some(old) = &old_applied {
                applied.applied_at_ms = applied
                    .applied_at_ms
                    .max(old.applied_at_ms.saturating_add(1));
            }
        }
        if same_project
            && !saved.definitions.is_empty()
            && old_applied
                .as_ref()
                .is_some_and(|old| old.endpoint == endpoint)
        {
            if let Some(runtime) = &active.runtime {
                if !matches!(*runtime.status().borrow(), AlarmRuntimeStatus::Running) {
                    // The stopped task is reaped at the common apply boundary below.
                } else {
                    match runtime
                        .apply(
                            applied.clone(),
                            saved.definitions,
                            confirmed.to_vec(),
                            client,
                        )
                        .await
                    {
                        Ok(()) => {
                            active.applied = Some(applied);
                            let warning = self
                                .terminal
                                .set_monitored(Some(MonitoredProject {
                                    project_id: saved.project_id,
                                    path: path.to_owned(),
                                }))
                                .err()
                                .map(|error| {
                                    eprintln!(
                                        "alarm monitored path update failed after apply: {error:?}"
                                    );
                                    "monitorPathNotSaved".to_owned()
                                });
                            let snapshot = self.snapshot_locked(&active).await?;
                            let _ = self.lagged.send(());
                            return Ok(ApplyResult::Applied { snapshot, warning });
                        }
                        Err(AlarmRuntimeError::Db(AlarmDbError::ConfirmationRequired(
                            occurrences,
                        ))) => {
                            return Ok(ApplyResult::ConfirmationRequired { occurrences });
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
            }
        }
        let target_db = Arc::new(AlarmDb::open(self.terminal.clone(), &saved.project_id).await?);
        if let Some(previous_applied) = target_db.applied().await? {
            applied.applied_at_ms = applied
                .applied_at_ms
                .max(previous_applied.applied_at_ms.saturating_add(1));
        }
        let target_rows = target_db.last_states().await?;
        let target_plan = plan_apply(&target_rows, &applied, wall_ms())?;
        let mut unacked = target_plan.unacked.clone();
        let mut old_unacked = Vec::new();
        if let Some(old) = &previous {
            if old.project_id != saved.project_id {
                let old_db = AlarmDb::open(self.terminal.clone(), &old.project_id).await?;
                old_unacked = all_unacked(&old_db.last_states().await?)?;
                old_db.close().await;
                unacked.extend(old_unacked.clone());
            }
        }
        unacked.sort();
        let mut claimed = confirmed.to_vec();
        claimed.sort();
        if claimed != unacked {
            if let Ok(db) = Arc::try_unwrap(target_db) {
                db.close().await;
            }
            return Ok(ApplyResult::ConfirmationRequired {
                occurrences: unacked,
            });
        }
        let switching = previous
            .as_ref()
            .is_some_and(|old| old.project_id != saved.project_id);
        let target = MonitoredProject {
            project_id: saved.project_id.clone(),
            path: path.clone(),
        };
        if switching {
            self.terminal.set_switching(Some(PendingSwitch {
                target: target.clone(),
                file_hash: saved.file_hash.clone(),
                applied_at_ms: applied.applied_at_ms,
            }))?;
        }
        let transition: Result<(), AlarmServiceError> = async {
            Self::stop_locked(&mut active).await?;
            if let Some(old) = &previous {
                let old_db = AlarmDb::open(self.terminal.clone(), &old.project_id).await?;
                old_db.close_unstopped_session(wall_ms()).await?;
                if switching {
                    let fresh = all_unacked(&old_db.last_states().await?)?;
                    if fresh != old_unacked {
                        old_db.close().await;
                        let mut occurrences = fresh;
                        occurrences.extend(target_plan.unacked.clone());
                        occurrences.sort();
                        return Err(AlarmServiceError::ConfirmationRequired(occurrences));
                    }
                }
                old_db.close().await;
            }
            target_db.close_unstopped_session(wall_ms()).await?;
            let plan = plan_apply(&target_db.last_states().await?, &applied, wall_ms())?;
            let target_confirmed: Vec<_> = confirmed
                .iter()
                .filter(|entry| plan.unacked.contains(entry))
                .cloned()
                .collect();
            target_db
                .apply_confirmed(
                    &applied,
                    None,
                    &plan.ended,
                    &plan.survivors,
                    &target_confirmed,
                )
                .await
                .map_err(|error| match error {
                    AlarmDbError::ConfirmationRequired(mut occurrences) if switching => {
                        occurrences.extend(old_unacked.clone());
                        occurrences.sort();
                        AlarmServiceError::ConfirmationRequired(occurrences)
                    }
                    error => error.into(),
                })?;
            if switching {
                let old = previous
                    .as_ref()
                    .ok_or(AlarmServiceError::NoMonitoredProject)?;
                let old_db = AlarmDb::open(self.terminal.clone(), &old.project_id).await?;
                old_db.end_monitoring(wall_ms(), &old_unacked).await?;
                old_db.close().await;
            }
            self.terminal.set_monitored(Some(target))?;
            Ok(())
        }
        .await;
        if let Ok(db) = Arc::try_unwrap(target_db) {
            db.close().await;
        }
        if let Err(error) = transition {
            if switching {
                if let Err(recovery_error) = self.recover_switch().await {
                    active.reason = "switchRecoveryFailed".into();
                    let _ = self.lagged.send(());
                    return Err(recovery_error);
                }
            }
            let current = self.terminal.monitored()?;
            let restart = current.as_ref().is_some_and(|current| {
                (current.project_id == saved.project_id && applied.endpoint == endpoint)
                    || old_applied.as_ref().is_some_and(|old| {
                        current.project_id == old.project_id && old.endpoint == endpoint
                    })
            });
            if restart {
                if let Err(restart_error) = self
                    .start_locked(&mut active, Some(endpoint), Some(client))
                    .await
                {
                    active.reason = stopped_reason(&restart_error).into();
                }
            }
            if current
                .as_ref()
                .is_some_and(|row| row.project_id == saved.project_id)
                && active.applied.as_ref().is_some_and(|row| {
                    row.file_hash == applied.file_hash && row.applied_at_ms == applied.applied_at_ms
                })
            {
                let snapshot = self.snapshot_locked(&active).await?;
                let _ = self.lagged.send(());
                return Ok(ApplyResult::Applied {
                    snapshot,
                    warning: Some("recoveredAfterApply".into()),
                });
            }
            let _ = self.lagged.send(());
            return match error {
                AlarmServiceError::ConfirmationRequired(occurrences) => {
                    Ok(ApplyResult::ConfirmationRequired { occurrences })
                }
                error => Err(error),
            };
        }
        if let Err(error) = self
            .start_locked(&mut active, Some(endpoint), Some(client))
            .await
        {
            active.reason = stopped_reason(&error).into();
        }
        let snapshot = self.snapshot_locked(&active).await?;
        let _ = self.lagged.send(());
        Ok(ApplyResult::Applied {
            snapshot,
            warning: None,
        })
    }

    pub async fn snapshot(&self) -> Result<AlarmSnapshot, AlarmServiceError> {
        let active = self.active.lock().await;
        let mut snapshot = self.snapshot_locked(&active).await?;
        drop(active);
        if let (Some(monitored), Some(applied)) =
            (self.terminal.monitored()?, snapshot.applied.as_ref())
        {
            if monitored.project_id == applied.project_id {
                let (condition, display) = self
                    .pending_changes(&monitored.path, applied.applied_at_ms)
                    .await;
                snapshot.pending_condition_changes = condition;
                snapshot.pending_display_changes = display;
            }
        }
        Ok(snapshot)
    }

    async fn snapshot_locked(&self, active: &Active) -> Result<AlarmSnapshot, AlarmServiceError> {
        let monitored = self.terminal.monitored()?;
        if active.reason == "switchRecoveryFailed" {
            return Ok(AlarmSnapshot {
                monitored: monitored.map(|monitored| MonitoredIdentity {
                    project_id: monitored.project_id,
                }),
                applied: None,
                engine: None,
                status: active.reason.clone(),
                pending_condition_changes: false,
                pending_display_changes: false,
            });
        }
        let applied = if let Some(monitored) = &monitored {
            if active.project_id.as_deref() == Some(&monitored.project_id) {
                active.applied.clone()
            } else {
                let db = AlarmDb::open(self.terminal.clone(), &monitored.project_id).await?;
                let applied = db.applied().await;
                db.close().await;
                applied?
            }
        } else {
            None
        };
        let engine = match &active.runtime {
            Some(runtime) if matches!(*runtime.status().borrow(), AlarmRuntimeStatus::Running) => {
                match runtime.snapshot().await {
                    Ok(engine) => Some(engine.into()),
                    Err(AlarmRuntimeError::Closed) => None,
                    Err(error) => return Err(error.into()),
                }
            }
            None => None,
            Some(_) => None,
        };
        let status = match &active.runtime {
            Some(runtime) => match *runtime.status().borrow() {
                AlarmRuntimeStatus::Running if engine.is_some() => "running".into(),
                _ => "stopped".into(),
            },
            None => active.reason.clone(),
        };
        Ok(AlarmSnapshot {
            monitored: monitored.map(|monitored| MonitoredIdentity {
                project_id: monitored.project_id,
            }),
            applied: applied.as_ref().map(AppliedSummary::from),
            engine,
            status,
            pending_condition_changes: false,
            pending_display_changes: false,
        })
    }

    async fn pending_changes(&self, path: &Path, applied_at_ms: i64) -> (bool, bool) {
        let Ok(metadata) = std::fs::metadata(path) else {
            return (false, false);
        };
        let modified = metadata.modified().ok();
        let mut cache = self.pending_cache.lock().await;
        if let Some(cached) = cache.as_ref() {
            if cached.path == path
                && cached.modified == modified
                && cached.len == metadata.len()
                && cached.applied_at_ms == applied_at_ms
            {
                return (cached.condition, cached.display);
            }
        }
        let path = path.to_path_buf();
        let applied = {
            let active = self.active.lock().await;
            active.applied.clone()
        };
        let Some(applied) = applied else {
            return (false, false);
        };
        let read_path = path.clone();
        let (condition, display) =
            tokio::task::spawn_blocking(move || match SavedAlarmProject::read(&read_path) {
                Ok(saved) if saved.project_id == applied.project_id => (
                    saved
                        .applied(applied.endpoint, applied.applied_by, applied.applied_at_ms)
                        .condition_hashes
                        != applied.condition_hashes
                        || saved.disabled != applied.disabled_condition_ids,
                    saved.displays != applied.displays,
                ),
                _ => (false, false),
            })
            .await
            .unwrap_or((false, false));
        *cache = Some(PendingCache {
            path,
            modified,
            len: metadata.len(),
            applied_at_ms,
            condition,
            display,
        });
        (condition, display)
    }

    pub async fn ack(
        &self,
        condition: String,
        occurrence: String,
        recurrence: u32,
        user: String,
    ) -> Result<AckOutcome, AlarmServiceError> {
        let active = self.active.lock().await;
        let runtime = active
            .runtime
            .as_ref()
            .ok_or(AlarmServiceError::EngineStopped)?;
        if !matches!(*runtime.status().borrow(), AlarmRuntimeStatus::Running) {
            return Err(AlarmServiceError::EngineStopped);
        }
        match runtime.ack(condition, occurrence, recurrence, user).await {
            Ok(outcome) => Ok(outcome),
            Err(AlarmRuntimeError::Closed) => Err(AlarmServiceError::EngineStopped),
            Err(error) => Err(error.into()),
        }
    }

    pub async fn history(
        &self,
        before_seq: Option<i64>,
        from_ms: Option<i64>,
        to_ms: Option<i64>,
        kind: Option<&str>,
        limit: usize,
    ) -> Result<Vec<EventRead>, AlarmServiceError> {
        let monitored = self
            .terminal
            .monitored()?
            .ok_or(AlarmServiceError::NoMonitoredProject)?;
        let db = AlarmDb::open(self.terminal.clone(), &monitored.project_id).await?;
        let result = db.history(before_seq, from_ms, to_ms, kind, limit).await;
        db.close().await;
        Ok(result?)
    }
}

fn wall_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn stopped_reason(error: &AlarmServiceError) -> &'static str {
    match error {
        AlarmServiceError::Terminal(_) => "terminalUnavailable",
        AlarmServiceError::Db(_) => "alarmDbUnavailable",
        AlarmServiceError::Project(_) => "invalidAppliedDefinition",
        AlarmServiceError::Runtime(_) => "engineStartFailed",
        AlarmServiceError::NoHub => "noHub",
        AlarmServiceError::EndpointChanged => "endpointChanged",
        AlarmServiceError::NoMonitoredProject => "notApplied",
        AlarmServiceError::EngineStopped => "engineStopped",
        AlarmServiceError::ConfirmationRequired(_) => "confirmationRequired",
    }
}

fn all_unacked(
    rows: &[crate::alarm_db::LastRow],
) -> Result<Vec<UnackedOccurrence>, AlarmServiceError> {
    let mut result = Vec::new();
    for row in rows {
        if !row.state.acked {
            result.push(UnackedOccurrence {
                condition_id: row.condition_id.clone(),
                occurrence: row
                    .state
                    .occurrence
                    .clone()
                    .ok_or(AlarmServiceError::Db(AlarmDbError::InvalidRow))?,
                recurrence: row.state.recurrence,
            });
        }
    }
    result.sort();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recording_runtime::setup_tests::Hub;
    use serde_json::{json, Value};

    #[test]
    fn switch_confirmation_serializes_the_project_id_for_webview() {
        let result = ApplyResult::SwitchConfirmationRequired {
            monitored_project_id: "project-a".into(),
        };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({"status":"switchConfirmationRequired","monitoredProjectId":"project-a"})
        );
        assert_eq!(
            serde_json::to_value(ApplyResult::SkippedEndpointChanged).unwrap(),
            json!({"status":"skippedEndpointChanged"})
        );
    }

    fn project(id: &str, name: &str) -> Value {
        let mut value: Value = serde_json::from_str(include_str!(
            "../../../examples/read-presentation.project.json"
        ))
        .unwrap();
        value["manifest"]["projectId"] = json!(id);
        value["alarms"] = json!({"definitions": [{
            "id":"0199f6a1-0000-7000-8000-000000000001", "name":name, "enabled":true,
            "source":{"kind":"bit","tag":"PLANT.FLAG","activeWhen":true},
            "severity":"high", "message":"running", "ackMode":"manual"
        }]});
        value
    }

    #[tokio::test]
    async fn same_project_apply_keeps_session_and_confirms_changed_condition() {
        let hub = Hub::new(&[("PLANT.FLAG", "bit")]).await;
        let dir = std::env::temp_dir().join(format!("alarm-same-project-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.json");
        let id = uuid::Uuid::now_v7().to_string();
        let mut value = project(&id, "A");
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let service = AlarmService::open(&dir).await.unwrap();
        assert!(matches!(
            service
                .apply(
                    &path,
                    &hub.url,
                    hub.client(),
                    "未ログイン",
                    &[],
                    ApplyMode::Saved
                )
                .await
                .unwrap(),
            ApplyResult::Applied { .. }
        ));
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if service
                    .snapshot()
                    .await
                    .unwrap()
                    .engine
                    .unwrap()
                    .conditions
                    .values()
                    .any(|state| state.active)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let before = service.snapshot().await.unwrap();
        let session = before.engine.unwrap().session;
        let first_applied_at = before.applied.unwrap().applied_at_ms;
        let resumed = service
            .resume(Some(&hub.url), Some(hub.client()))
            .await
            .unwrap();
        assert_eq!(resumed.engine.unwrap().session, session);
        assert!(matches!(
            service
                .apply(
                    &path,
                    "http://changed-hub.invalid",
                    hub.client(),
                    "未ログイン",
                    &[],
                    ApplyMode::Saved
                )
                .await
                .unwrap(),
            ApplyResult::SkippedEndpointChanged
        ));
        let skipped = service.snapshot().await.unwrap();
        assert_eq!(skipped.engine.unwrap().session, session);
        assert_eq!(skipped.applied.unwrap().applied_at_ms, first_applied_at);

        value["alarms"]["definitions"][0]["name"] = json!("Renamed");
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(
            service
                .apply(
                    &path,
                    &hub.url,
                    hub.client(),
                    "未ログイン",
                    &[],
                    ApplyMode::Saved
                )
                .await
                .unwrap(),
            ApplyResult::Applied { .. }
        ));
        let renamed = service.snapshot().await.unwrap();
        assert_eq!(renamed.engine.unwrap().session, session);
        assert_eq!(renamed.monitored.unwrap().project_id, id);
        let renamed_applied_at = renamed.applied.unwrap().applied_at_ms;
        assert!(renamed_applied_at > first_applied_at);

        value["alarms"]["definitions"][0]["source"]["activeWhen"] = json!(false);
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let needed = match service
            .apply(
                &path,
                &hub.url,
                hub.client(),
                "未ログイン",
                &[],
                ApplyMode::Saved,
            )
            .await
            .unwrap()
        {
            ApplyResult::ConfirmationRequired { occurrences } => occurrences,
            _ => panic!("changed active condition must request confirmation"),
        };
        assert_eq!(needed.len(), 1);
        assert!(matches!(
            service
                .apply(
                    &path,
                    &hub.url,
                    hub.client(),
                    "未ログイン",
                    &needed,
                    ApplyMode::Saved
                )
                .await
                .unwrap(),
            ApplyResult::Applied { .. }
        ));
        let changed = service.snapshot().await.unwrap();
        assert_eq!(changed.engine.unwrap().session, session);
        assert!(changed.applied.unwrap().applied_at_ms > renamed_applied_at);
        service.stop().await.unwrap();
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn saved_apply_resumes_and_switches_only_after_confirmation() {
        let hub = Hub::new(&[("PLANT.FLAG", "bit")]).await;
        let dir = std::env::temp_dir().join(format!("alarm-service-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.json");
        let b = dir.join("b.json");
        let a_id = uuid::Uuid::now_v7().to_string();
        let b_id = uuid::Uuid::now_v7().to_string();
        std::fs::write(&a, serde_json::to_vec(&project(&a_id, "A")).unwrap()).unwrap();
        std::fs::write(&b, serde_json::to_vec(&project(&b_id, "B")).unwrap()).unwrap();
        let service = AlarmService::open(&dir).await.unwrap();
        assert!(matches!(
            service
                .apply(
                    &a,
                    &hub.url,
                    hub.client(),
                    "未ログイン",
                    &[],
                    ApplyMode::Saved
                )
                .await
                .unwrap(),
            ApplyResult::Applied { .. }
        ));
        let a_session = service.snapshot().await.unwrap().engine.unwrap().session;
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if service
                    .snapshot()
                    .await
                    .unwrap()
                    .engine
                    .unwrap()
                    .conditions
                    .values()
                    .any(|state| state.active)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(matches!(
            service
                .apply(
                    &b,
                    &hub.url,
                    hub.client(),
                    "未ログイン",
                    &[],
                    ApplyMode::Saved
                )
                .await
                .unwrap(),
            ApplyResult::SkippedDifferentProject
        ));
        assert_eq!(
            service.snapshot().await.unwrap().engine.unwrap().session,
            a_session
        );
        assert!(matches!(
            service
                .apply(&b, &hub.url, hub.client(), "未ログイン", &[], ApplyMode::Explicit { confirmed_switch_from: None })
                .await
                .unwrap(),
            ApplyResult::SwitchConfirmationRequired { monitored_project_id } if monitored_project_id == a_id
        ));
        let needed = match service
            .apply(
                &b,
                &hub.url,
                hub.client(),
                "未ログイン",
                &[],
                ApplyMode::Explicit {
                    confirmed_switch_from: Some(&a_id),
                },
            )
            .await
            .unwrap()
        {
            ApplyResult::ConfirmationRequired { occurrences } => occurrences,
            _ => panic!("active A must request confirmation"),
        };
        assert_eq!(needed.len(), 1);
        assert_eq!(
            service
                .snapshot()
                .await
                .unwrap()
                .monitored
                .unwrap()
                .project_id,
            a_id
        );
        assert!(matches!(
            service
                .apply(
                    &b,
                    &hub.url,
                    hub.client(),
                    "未ログイン",
                    &needed,
                    ApplyMode::Explicit {
                        confirmed_switch_from: Some(&a_id)
                    }
                )
                .await
                .unwrap(),
            ApplyResult::Applied { .. }
        ));
        let b_snapshot = service.snapshot().await.unwrap();
        let wire = serde_json::to_string(&b_snapshot).unwrap();
        assert!(!wire.contains("\"path\""));
        assert!(!wire.contains(&dir.to_string_lossy().to_string()));
        assert_eq!(b_snapshot.monitored.unwrap().project_id, b_id);
        let b_generation = b_snapshot.engine.unwrap().session.generation;
        assert!(b_generation > a_session.generation);
        let a_db = AlarmDb::open(service.terminal.clone(), &a_id)
            .await
            .unwrap();
        assert!(a_db.last_states().await.unwrap().is_empty());
        assert!(a_db
            .events()
            .await
            .unwrap()
            .iter()
            .any(|event| event.event.kind == "projectSwitched"));
        let page = a_db
            .history(None, None, None, Some("projectSwitched"), 1)
            .await
            .unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].event.kind, "projectSwitched");
        assert!(a_db
            .history(Some(page[0].seq), None, None, Some("projectSwitched"), 1)
            .await
            .unwrap()
            .is_empty());
        service.stop().await.unwrap();
        a_db.close().await;
        drop(service);
        let resumed = AlarmService::open(&dir).await.unwrap();
        let snapshot = resumed
            .resume(Some(&hub.url), Some(hub.client()))
            .await
            .unwrap();
        assert!(snapshot.engine.unwrap().session.generation > b_generation);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if resumed
                    .snapshot()
                    .await
                    .unwrap()
                    .engine
                    .unwrap()
                    .conditions
                    .values()
                    .any(|state| state.active)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let mut empty = project(&b_id, "B");
        empty["alarms"] = json!({"definitions": []});
        std::fs::write(&b, serde_json::to_vec(&empty).unwrap()).unwrap();
        let needed = match resumed
            .apply(
                &b,
                &hub.url,
                hub.client(),
                "未ログイン",
                &[],
                ApplyMode::Explicit {
                    confirmed_switch_from: Some(&a_id),
                },
            )
            .await
            .unwrap()
        {
            ApplyResult::ConfirmationRequired { occurrences } => occurrences,
            _ => panic!("removing an active condition needs confirmation"),
        };
        assert!(matches!(
            resumed
                .apply(
                    &b,
                    &hub.url,
                    hub.client(),
                    "未ログイン",
                    &needed,
                    ApplyMode::Explicit {
                        confirmed_switch_from: Some(&a_id)
                    }
                )
                .await
                .unwrap(),
            ApplyResult::Applied { .. }
        ));
        let stopped = resumed.snapshot().await.unwrap();
        assert_eq!(stopped.status, "noConditions");
        assert!(stopped.engine.is_none());
        drop(resumed);
        for _ in 0..20 {
            if std::fs::remove_dir_all(&dir).is_ok() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("temporary alarm DB handles were not released");
    }

    #[tokio::test]
    async fn an_empty_alarm_project_is_still_an_applied_project() {
        let hub = Hub::new(&[]).await;
        let dir = std::env::temp_dir().join(format!("alarm-empty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("empty.json");
        let mut value = project(&uuid::Uuid::now_v7().to_string(), "empty");
        value["alarms"] = json!({"definitions": []});
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let service = AlarmService::open(&dir).await.unwrap();
        assert!(matches!(
            service
                .apply(
                    &path,
                    &hub.url,
                    hub.client(),
                    "未ログイン",
                    &[],
                    ApplyMode::Saved
                )
                .await
                .unwrap(),
            ApplyResult::Applied { .. }
        ));
        assert!(service.snapshot().await.unwrap().applied.is_some());
        assert!(matches!(
            service
                .ack(
                    "missing".into(),
                    "occurrence".into(),
                    1,
                    "未ログイン".into()
                )
                .await,
            Err(AlarmServiceError::EngineStopped)
        ));
        let mut refresh = service.lagged();
        service.stop().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), refresh.recv())
            .await
            .unwrap()
            .unwrap();
        drop(service);
        for _ in 0..20 {
            if std::fs::remove_dir_all(&dir).is_ok() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("temporary alarm DB handles were not released");
    }

    #[tokio::test]
    async fn recovery_does_not_treat_a_previous_apply_of_the_same_file_as_committed() {
        let hub = Hub::new(&[]).await;
        let dir = std::env::temp_dir().join(format!("alarm-switch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a_id = uuid::Uuid::now_v7().to_string();
        let b_id = uuid::Uuid::now_v7().to_string();
        let a = dir.join("a.json");
        let b = dir.join("b.json");
        for (path, id) in [(&a, &a_id), (&b, &b_id)] {
            let mut value = project(id, "empty");
            value["alarms"] = json!({"definitions": []});
            std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
        }
        let service = AlarmService::open(&dir).await.unwrap();
        service
            .apply(
                &a,
                &hub.url,
                hub.client(),
                "未ログイン",
                &[],
                ApplyMode::Explicit {
                    confirmed_switch_from: None,
                },
            )
            .await
            .unwrap();
        let old = AlarmDb::open(service.terminal.clone(), &a_id)
            .await
            .unwrap();
        let old_applied = old.applied().await.unwrap().unwrap();
        old.close().await;
        assert!(matches!(
            service
                .apply(&b, &hub.url, hub.client(), "未ログイン", &[], ApplyMode::Explicit { confirmed_switch_from: None })
                .await
                .unwrap(),
            ApplyResult::SwitchConfirmationRequired { monitored_project_id } if monitored_project_id == a_id
        ));
        assert_eq!(
            service.terminal.monitored().unwrap().unwrap().project_id,
            a_id
        );
        assert!(matches!(
            service
                .apply(&b, &hub.url, hub.client(), "未ログイン", &[], ApplyMode::Explicit { confirmed_switch_from: Some(&b_id) })
                .await
                .unwrap(),
            ApplyResult::SwitchConfirmationRequired { monitored_project_id } if monitored_project_id == a_id
        ));
        service
            .apply(
                &b,
                &hub.url,
                hub.client(),
                "未ログイン",
                &[],
                ApplyMode::Explicit {
                    confirmed_switch_from: Some(&a_id),
                },
            )
            .await
            .unwrap();
        service
            .terminal
            .set_switching(Some(PendingSwitch {
                target: MonitoredProject {
                    project_id: a_id,
                    path: a.clone(),
                },
                file_hash: old_applied.file_hash,
                applied_at_ms: old_applied.applied_at_ms + 1,
            }))
            .unwrap();
        drop(service);
        let recovered = AlarmService::open(&dir).await.unwrap();
        assert_eq!(
            recovered.terminal.monitored().unwrap().unwrap().project_id,
            b_id
        );
        assert!(recovered.terminal.switching().unwrap().is_none());
        drop(recovered);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn failed_switch_recovery_keeps_the_service_available_for_retry() {
        let dir = std::env::temp_dir().join(format!("alarm-retry-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let terminal = AlarmTerminal::open(&dir).await.unwrap();
        terminal
            .set_switching(Some(PendingSwitch {
                target: MonitoredProject {
                    project_id: "invalid".into(),
                    path: dir.join("invalid.json"),
                },
                file_hash: "hash".into(),
                applied_at_ms: 1,
            }))
            .unwrap();
        drop(terminal);
        let service = AlarmService::open(&dir).await.unwrap();
        assert_eq!(
            service.snapshot().await.unwrap().status,
            "switchRecoveryFailed"
        );
        assert_eq!(
            service.resume(None, None).await.unwrap().status,
            "switchRecoveryFailed"
        );
        service.terminal.set_switching(None).unwrap();
        let hub = Hub::new(&[("PLANT.FLAG", "bit")]).await;
        let other_path = dir.join("other.json");
        let other_id = uuid::Uuid::now_v7().to_string();
        std::fs::write(
            &other_path,
            serde_json::to_vec(&project(&other_id, "Other")).unwrap(),
        )
        .unwrap();
        service
            .terminal
            .set_monitored(Some(MonitoredProject {
                project_id: uuid::Uuid::now_v7().to_string(),
                path: dir.join("monitored.json"),
            }))
            .unwrap();
        assert!(matches!(
            service
                .apply(
                    &other_path,
                    &hub.url,
                    hub.client(),
                    "未ログイン",
                    &[],
                    ApplyMode::Saved,
                )
                .await
                .unwrap(),
            ApplyResult::SkippedDifferentProject
        ));
        assert_eq!(service.snapshot().await.unwrap().status, "stopped");
        service.terminal.set_monitored(None).unwrap();
        assert_eq!(
            service.resume(None, None).await.unwrap().status,
            "notApplied"
        );
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
