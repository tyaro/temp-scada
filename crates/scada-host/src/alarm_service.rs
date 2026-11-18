//! One terminal-wide owner of the alarm subscription and applied Project.
//! Callers supply only a host-resolved saved path and the protected Hub client.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use crate::alarm_runtime::HubClients;
pub use banto_tagclient::RestClient;
use scada_alarm::{AckOutcome, Session};
use serde::Serialize;
use tokio::sync::{broadcast, Mutex};
use tokio::task::JoinHandle;

use crate::alarm_buzzer::{
    BuzzerDriver, BuzzerPlayer, BuzzerRinging, BuzzerStatus, LogBuzzerPlayer,
};
use crate::alarm_db::{
    plan_apply, plan_restore, AlarmDb, AlarmDbError, AppliedDefinitions, EventRead,
    RetentionStatus, UnackedOccurrence,
};
use crate::alarm_project::{AlarmProjectError, SavedAlarmProject};
use crate::alarm_runtime::{
    AlarmChange, AlarmEvaluator, AlarmRuntime, AlarmRuntimeError, AlarmRuntimeStatus,
    AlarmStopReason,
};
use crate::alarm_terminal::{
    AlarmSettings, AlarmSettingsWarning, AlarmTerminal, MonitoredProject, PendingSwitch,
    ResolvedSound, SoundFallback, SoundKind, SoundSetting, TerminalError, WavRejection,
};

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
    /// An alarm terminal setting is outside its range or relation.
    InvalidSettings,
    /// The WAV to import fails the check (terminal settings design §5).
    InvalidSound(WavRejection),
    /// A test sound is refused while the buzzer rings (design §5).
    BuzzerRinging,
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
        match error {
            TerminalError::InvalidSettings => Self::InvalidSettings,
            TerminalError::InvalidSound(rejection) => Self::InvalidSound(rejection),
            other => Self::Terminal(other),
        }
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

/// `alarm_settings_get` (terminal settings design §6).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmSettingsView {
    #[serde(flatten)]
    pub settings: AlarmSettings,
    /// The saved sound: `default`, or `custom` with the imported file's
    /// original name, size and hash (display only; no path).
    pub sound: SoundSetting,
    /// Why the saved sound is not played now (the beep plays instead).
    pub sound_fallback: Option<SoundFallback>,
    /// Groups reset to defaults when the terminal settings were read.
    pub warnings: Vec<AlarmSettingsWarning>,
    /// The monitored Project's alarm DB; `None` without a monitored Project
    /// or when that DB cannot be read now.
    pub retention_status: Option<RetentionStatus>,
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
    /// The monitored Project's saved file cannot be read as that Project
    /// (moved, unreadable, broken or now another Project), so whether it has
    /// unapplied changes is unknown. Both flags above are false meanwhile.
    pub pending_unknown: bool,
    /// The running Engine cannot write its history (design §5.3). ACK and
    /// apply are refused until a retry records the unrecorded period.
    pub history_write_failure: Option<crate::alarm_runtime::HistoryWriteFailure>,
    /// Rereads of the current values keep failing (design §4.5). Evaluation
    /// continues until the streak exceeds its limit (ReceiveLost).
    pub reread_failure: Option<crate::alarm_runtime::RereadFailure>,
    /// The terminal buzzer (design §6): ringing, silenced or quiet.
    pub buzzer: BuzzerStatus,
    /// The sound the buzzer plays (terminal settings design §5).
    pub buzzer_sound: BuzzerSound,
}

/// `alarm_snapshot.buzzerSound`: the saved kind and why the beep plays
/// instead of it, if it does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuzzerSound {
    pub kind: SoundKind,
    pub fallback: Option<SoundFallback>,
}

impl From<&ResolvedSound> for BuzzerSound {
    fn from(sound: &ResolvedSound) -> Self {
        Self {
            kind: sound.kind,
            fallback: sound.fallback,
        }
    }
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
        snapshot: Box<AlarmSnapshot>,
        initial_monitoring: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        warning: Option<String>,
    },
    SkippedDifferentProject,
    SkippedEndpointChanged,
    SkippedNoHub,
    SkippedBusy,
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
    buzzer: Arc<BuzzerDriver>,
}

struct PendingCache {
    path: PathBuf,
    modified: Option<std::time::SystemTime>,
    len: u64,
    applied_at_ms: i64,
    pending: Pending,
}

/// Unapplied changes in the monitored Project's saved file.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Pending {
    condition: bool,
    display: bool,
    /// The file could not be read as the applied Project.
    unknown: bool,
}

impl Pending {
    const UNKNOWN: Self = Self {
        condition: false,
        display: false,
        unknown: true,
    };
}

pub struct AlarmService {
    terminal: Arc<AlarmTerminal>,
    active: Mutex<Active>,
    pending_cache: Mutex<Option<PendingCache>>,
    changes: broadcast::Sender<AlarmChange>,
    lagged: broadcast::Sender<()>,
    buzzer: Arc<BuzzerDriver>,
    /// The sound handed to the buzzer; set together with the player so the
    /// snapshot names what plays.
    buzzer_sound: std::sync::Mutex<BuzzerSound>,
    /// Serializes a whole sound change (persisting and handing the sound to
    /// the player), so an earlier change cannot reinstall its sound after a
    /// later one.
    sound_change: Mutex<()>,
}

impl AlarmService {
    /// Open without audio; the buzzer only logs.
    pub async fn open(data_dir: &Path) -> Result<Self, AlarmServiceError> {
        Self::open_with_buzzer(data_dir, Arc::new(LogBuzzerPlayer)).await
    }

    /// Open with the terminal's buzzer player (design §6).
    pub async fn open_with_buzzer(
        data_dir: &Path,
        player: Arc<dyn BuzzerPlayer>,
    ) -> Result<Self, AlarmServiceError> {
        let terminal = Arc::new(AlarmTerminal::open(data_dir).await?);
        let (changes, _) = broadcast::channel(256);
        let (lagged, _) = broadcast::channel(16);
        // A buzzer status change is not an Engine change: viewers refetch the
        // snapshot as for `lagged`, which keeps the generation/seq rules intact.
        let buzzer = Arc::new(BuzzerDriver::new(player, lagged.clone()));
        let sound = {
            let terminal = terminal.clone();
            tokio::task::spawn_blocking(move || terminal.resolve_sound())
                .await
                .map_err(|_| AlarmServiceError::Terminal(TerminalError::Unreadable))??
        };
        buzzer.set_sound(sound.wav.clone());
        let service = Self {
            terminal,
            active: Mutex::new(Active {
                runtime: None,
                db: None,
                project_id: None,
                applied: None,
                pump: None,
                reason: "notApplied".into(),
                buzzer: buzzer.clone(),
            }),
            pending_cache: Mutex::new(None),
            changes,
            lagged,
            buzzer,
            buzzer_sound: std::sync::Mutex::new(BuzzerSound::from(&sound)),
            sound_change: Mutex::new(()),
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
        client: Option<HubClients>,
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
            active.buzzer.halt();
            if let Some(db) = active.db.take() {
                if let Ok(db) = Arc::try_unwrap(db) {
                    db.close().await;
                }
            }
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
        client: Option<HubClients>,
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
        let (settings, _) = self.terminal.alarm_settings()?;
        let evaluator = AlarmEvaluator::new(db.clone(), applied, engine)
            .await?
            .with_retention(settings.retention.limit());
        let runtime =
            AlarmRuntime::start_with_config(evaluator, client, settings.reread.freshness()).await?;
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
        let mut history = runtime.history();
        let mut reread = runtime.reread_failure();
        let sender = self.changes.clone();
        let lagged = self.lagged.clone();
        let buzzer = active.buzzer.clone();
        let token = buzzer.begin();
        let snapshots = runtime.snapshots();
        active.pump = Some(tokio::spawn(async move {
            if !matches!(*status.borrow(), AlarmRuntimeStatus::Running) {
                let _ = lagged.send(());
                return;
            }
            // The receiver is already subscribed; changes up to the snapshot's
            // seq are skipped as duplicates by the buzzer.
            let resync = || async {
                if let Ok(engine) = snapshots.snapshot().await {
                    buzzer.sync(token, &engine);
                }
            };
            resync().await;
            loop {
                tokio::select! {
                    state = status.changed() => {
                        if state.is_err() || !matches!(*status.borrow(), AlarmRuntimeStatus::Running) {
                            buzzer.engine_stopped(token);
                            let _ = lagged.send(());
                            break;
                        }
                    }
                    // A write outage starting or ending is not an Engine
                    // change; viewers fetch a new snapshot instead.
                    Ok(()) = history.changed() => { let _ = lagged.send(()); }
                    Ok(()) = reread.changed() => { let _ = lagged.send(()); }
                    change = receiver.recv() => match change {
                        Ok(change) => {
                            let synced = buzzer.apply(token, &change);
                            let _ = sender.send(change);
                            if !synced { resync().await; }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            let _ = lagged.send(());
                            resync().await;
                        }
                        Err(_) => { buzzer.engine_stopped(token); break; }
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
        active.buzzer.halt();
        if let Some(db) = active.db.take() {
            if let Ok(db) = Arc::try_unwrap(db) {
                db.close().await;
            }
        }
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
        client: HubClients,
        applied_by: &str,
        confirmed: &[UnackedOccurrence],
        mode: ApplyMode<'_>,
    ) -> Result<ApplyResult, AlarmServiceError> {
        let path = path.to_path_buf();
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
        if matches!(mode, ApplyMode::Saved) && previous.is_some() {
            let read_path = path.clone();
            let project_id =
                tokio::task::spawn_blocking(move || SavedAlarmProject::read_project_id(&read_path))
                    .await
                    .map_err(|_| AlarmServiceError::Project(AlarmProjectError::InvalidFile))??;
            if previous
                .as_ref()
                .is_some_and(|old| old.project_id != project_id)
            {
                return Ok(ApplyResult::SkippedDifferentProject);
            }
        }
        let read_path = path.clone();
        let saved = tokio::task::spawn_blocking(move || SavedAlarmProject::read(&read_path))
            .await
            .map_err(|_| AlarmServiceError::Project(AlarmProjectError::InvalidFile))??;
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
        // Refuse before any stop/restart path: stopping a runtime whose
        // history cannot be written would end monitoring instead of merely
        // refusing the definition change (design §5.3).
        if active.runtime.as_ref().is_some_and(|runtime| {
            matches!(*runtime.status().borrow(), AlarmRuntimeStatus::Running)
                && runtime.history().borrow().is_some()
        }) {
            return Err(AlarmRuntimeError::HistoryUnwritable.into());
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
                            saved.definitions.clone(),
                            confirmed.to_vec(),
                            client.clone(),
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
                            return Ok(ApplyResult::Applied {
                                snapshot: Box::new(snapshot),
                                initial_monitoring: false,
                                warning,
                            });
                        }
                        Err(AlarmRuntimeError::Db(AlarmDbError::ConfirmationRequired(
                            occurrences,
                        ))) => {
                            return Ok(ApplyResult::ConfirmationRequired { occurrences });
                        }
                        // The task ended after the status check above. Reap it
                        // and re-plan from the DB on the common path below.
                        Err(AlarmRuntimeError::Closed) => {}
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
                    snapshot: Box::new(snapshot),
                    initial_monitoring: previous.is_none(),
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
            snapshot: Box::new(snapshot),
            initial_monitoring: previous.is_none(),
            warning: None,
        })
    }

    pub async fn snapshot(&self) -> Result<AlarmSnapshot, AlarmServiceError> {
        let active = self.active.lock().await;
        let (mut snapshot, applied) = self.snapshot_locked_with_applied(&active).await?;
        drop(active);
        if let (Some(monitored), Some(applied)) = (self.terminal.monitored()?, applied.as_ref()) {
            if monitored.project_id == applied.project_id {
                let pending = self.pending_changes(&monitored.path, applied).await;
                snapshot.pending_condition_changes = pending.condition;
                snapshot.pending_display_changes = pending.display;
                snapshot.pending_unknown = pending.unknown;
            }
        }
        Ok(snapshot)
    }

    async fn snapshot_locked(&self, active: &Active) -> Result<AlarmSnapshot, AlarmServiceError> {
        Ok(self.snapshot_locked_with_applied(active).await?.0)
    }

    async fn snapshot_locked_with_applied(
        &self,
        active: &Active,
    ) -> Result<(AlarmSnapshot, Option<AppliedDefinitions>), AlarmServiceError> {
        let monitored = self.terminal.monitored()?;
        if active.reason == "switchRecoveryFailed" {
            return Ok((
                AlarmSnapshot {
                    monitored: monitored.map(|monitored| MonitoredIdentity {
                        project_id: monitored.project_id,
                    }),
                    applied: None,
                    engine: None,
                    status: active.reason.clone(),
                    pending_condition_changes: false,
                    pending_display_changes: false,
                    pending_unknown: false,
                    history_write_failure: None,
                    reread_failure: None,
                    buzzer: self.buzzer.status(),
                    buzzer_sound: self.buzzer_sound(),
                },
                None,
            ));
        }
        let applied = if let Some(monitored) = &monitored {
            if active.project_id.as_deref() == Some(&monitored.project_id) {
                active.applied.clone()
            } else {
                match AlarmDb::open_read(self.terminal.clone(), &monitored.project_id).await? {
                    Some(db) => {
                        let applied = db.applied().await;
                        db.close().await;
                        applied?
                    }
                    None => None,
                }
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
        let (history_write_failure, reread_failure) = match (&active.runtime, &engine) {
            (Some(runtime), Some(_)) => (
                *runtime.history().borrow(),
                *runtime.reread_failure().borrow(),
            ),
            _ => (None, None),
        };
        let status = match &active.runtime {
            Some(runtime) => match *runtime.status().borrow() {
                AlarmRuntimeStatus::Running if engine.is_some() => "running".into(),
                AlarmRuntimeStatus::Stopped { reason } => stop_status(reason).into(),
                AlarmRuntimeStatus::Running => "stopped".into(),
            },
            None => active.reason.clone(),
        };
        Ok((
            AlarmSnapshot {
                monitored: monitored.map(|monitored| MonitoredIdentity {
                    project_id: monitored.project_id,
                }),
                applied: applied.as_ref().map(AppliedSummary::from),
                engine,
                status,
                pending_condition_changes: false,
                pending_display_changes: false,
                pending_unknown: false,
                history_write_failure,
                reread_failure,
                buzzer: self.buzzer.status(),
                buzzer_sound: self.buzzer_sound(),
            },
            applied,
        ))
    }

    async fn pending_changes(&self, path: &Path, applied: &AppliedDefinitions) -> Pending {
        let Ok(metadata) = std::fs::metadata(path) else {
            return Pending::UNKNOWN;
        };
        let modified = metadata.modified().ok();
        let mut cache = self.pending_cache.lock().await;
        if let Some(cached) = cache.as_ref() {
            if cached.path == path
                && cached.modified == modified
                && cached.len == metadata.len()
                && cached.applied_at_ms == applied.applied_at_ms
            {
                return cached.pending;
            }
        }
        let path = path.to_path_buf();
        let applied_at_ms = applied.applied_at_ms;
        let applied = applied.clone();
        let read_path = path.clone();
        let pending =
            tokio::task::spawn_blocking(move || match SavedAlarmProject::read(&read_path) {
                Ok(saved) if saved.project_id == applied.project_id => Pending {
                    condition: saved
                        .applied(applied.endpoint, applied.applied_by, applied.applied_at_ms)
                        .condition_hashes
                        != applied.condition_hashes
                        || saved.disabled != applied.disabled_condition_ids,
                    display: saved.displays != applied.displays,
                    unknown: false,
                },
                _ => Pending::UNKNOWN,
            })
            .await
            .unwrap_or(Pending::UNKNOWN);
        *cache = Some(PendingCache {
            path,
            modified,
            len: metadata.len(),
            applied_at_ms,
            pending,
        });
        pending
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

    /// The alarm terminal settings (terminal settings design §6). Needs no
    /// authorization.
    pub async fn alarm_settings(&self) -> Result<AlarmSettingsView, AlarmServiceError> {
        let (settings, warnings) = self.terminal.alarm_settings()?;
        Ok(AlarmSettingsView {
            settings,
            sound: self.terminal.sound_setting()?,
            sound_fallback: self.buzzer_sound().fallback,
            warnings,
            retention_status: self.retention_status().await,
        })
    }

    /// Read on its own connection like `history`, so the settings stay
    /// readable while the DB is busy or broken (the Engine reports that).
    async fn retention_status(&self) -> Option<RetentionStatus> {
        let monitored = self.terminal.monitored().ok()??;
        let db = match AlarmDb::open_read(self.terminal.clone(), &monitored.project_id).await {
            Ok(Some(db)) => db,
            Ok(None) => return None,
            Err(error) => {
                eprintln!("alarm retention status unavailable: {error:?}");
                return None;
            }
        };
        let status = db.retention_status().await;
        db.close().await;
        status
            .inspect_err(|error| eprintln!("alarm retention status unavailable: {error:?}"))
            .ok()
    }

    /// Save the alarm terminal settings; the caller has authorized the
    /// change. Saved reread values apply to a running Engine at once (§4);
    /// otherwise the next session starts with them. Viewers refetch.
    pub async fn set_alarm_settings(
        &self,
        settings: AlarmSettings,
    ) -> Result<AlarmSettingsView, AlarmServiceError> {
        if !settings.is_valid() {
            return Err(AlarmServiceError::InvalidSettings);
        }
        // Held across the save so a session starting meanwhile cannot
        // read the old values after the running one was reconfigured.
        let active = self.active.lock().await;
        let terminal = self.terminal.clone();
        tokio::task::spawn_blocking(move || terminal.set_alarm(settings))
            .await
            .map_err(|_| AlarmServiceError::Terminal(TerminalError::Save))??;
        if let Some(runtime) = active.runtime.as_ref() {
            // A stopped or failing Engine reports through its status; the
            // saved values are used by its next session.
            let _ = runtime
                .reconfigure(settings.reread.freshness(), settings.retention.limit())
                .await;
        }
        drop(active);
        let _ = self.lagged.send(());
        self.alarm_settings().await
    }

    /// Import a WAV as the buzzer sound (terminal settings design §5); the
    /// caller has authorized the change and read the file the user picked.
    /// The file is checked and put in place before the setting is saved.
    pub async fn import_sound(
        &self,
        name: String,
        bytes: Vec<u8>,
    ) -> Result<AlarmSettingsView, AlarmServiceError> {
        let terminal = self.terminal.clone();
        self.change_sound(move || terminal.import_sound(&name, &bytes))
            .await
    }

    /// Back to the bundled beep: the setting is saved, then the file removed.
    pub async fn reset_sound(&self) -> Result<AlarmSettingsView, AlarmServiceError> {
        let terminal = self.terminal.clone();
        self.change_sound(move || terminal.reset_sound()).await
    }

    async fn change_sound(
        &self,
        change: impl FnOnce() -> Result<ResolvedSound, TerminalError> + Send + 'static,
    ) -> Result<AlarmSettingsView, AlarmServiceError> {
        let serial = self.sound_change.lock().await;
        let sound = tokio::task::spawn_blocking(change)
            .await
            .map_err(|_| AlarmServiceError::Terminal(TerminalError::Save))??;
        self.use_sound(&sound);
        drop(serial);
        let _ = self.lagged.send(());
        self.alarm_settings().await
    }

    fn use_sound(&self, sound: &ResolvedSound) {
        let mut current = self
            .buzzer_sound
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.buzzer.set_sound(sound.wav.clone());
        *current = BuzzerSound::from(sound);
    }

    fn buzzer_sound(&self) -> BuzzerSound {
        *self
            .buzzer_sound
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Play the current sound once (terminal settings design §5). Needs no
    /// authorization; refused while the buzzer rings.
    pub fn test_sound(&self) -> Result<(), AlarmServiceError> {
        self.buzzer
            .play_test()
            .map_err(|BuzzerRinging| AlarmServiceError::BuzzerRinging)
    }

    /// Silence this terminal's buzzer (design §6). Not an ACK, and needs no
    /// authorization or Engine lock: a new or reoccurred unacked occurrence
    /// sounds again.
    pub fn silence_buzzer(&self) -> BuzzerStatus {
        self.buzzer.silence()
    }

    pub fn buzzer_status(&self) -> BuzzerStatus {
        self.buzzer.status()
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
        // Its own read connection (`open_read`): the Engine's writes and the
        // retention's deletes keep the shared one busy.
        let Some(db) = AlarmDb::open_read(self.terminal.clone(), &monitored.project_id).await?
        else {
            return Ok(Vec::new());
        };
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

/// `alarm_snapshot.status` for an Engine that ended by itself, so the screen
/// can tell an expired credential (design §5.1) from other stops.
fn stop_status(reason: AlarmStopReason) -> &'static str {
    match reason {
        AlarmStopReason::Requested => "stopped",
        AlarmStopReason::Unauthorized => "authExpired",
        AlarmStopReason::ConnectionFailure => "connectionFailed",
        AlarmStopReason::StorageFailure => "alarmDbFailed",
        AlarmStopReason::InvalidDefinition => "invalidAppliedDefinition",
        AlarmStopReason::InternalError => "engineFailed",
    }
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
        AlarmServiceError::InvalidSettings => "invalidSettings",
        AlarmServiceError::InvalidSound(_) => "invalidSound",
        AlarmServiceError::BuzzerRinging => "buzzerRinging",
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
                    hub.clients(),
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
            .resume(Some(&hub.url), Some(hub.clients()))
            .await
            .unwrap();
        assert_eq!(resumed.engine.unwrap().session, session);
        assert!(matches!(
            service
                .apply(
                    &path,
                    "http://changed-hub.invalid",
                    hub.clients(),
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
                    hub.clients(),
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
                hub.clients(),
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
                    hub.clients(),
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
    async fn same_project_apply_restarts_when_the_runtime_closed_after_the_status_check() {
        let hub = Hub::new(&[("PLANT.FLAG", "bit")]).await;
        let dir = std::env::temp_dir().join(format!("alarm-closed-apply-{}", uuid::Uuid::new_v4()));
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
                    hub.clients(),
                    "未ログイン",
                    &[],
                    ApplyMode::Saved
                )
                .await
                .unwrap(),
            ApplyResult::Applied { .. }
        ));
        let before = service.snapshot().await.unwrap();
        let session = before.engine.unwrap().session;
        let first_applied_at = before.applied.unwrap().applied_at_ms;
        {
            let mut active = service.active.lock().await;
            let runtime = active.runtime.as_mut().unwrap();
            runtime.close_for_test().await;
            assert!(matches!(
                *runtime.status().borrow(),
                AlarmRuntimeStatus::Running
            ));
        }

        value["alarms"]["definitions"][0]["name"] = json!("Renamed");
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(
            service
                .apply(
                    &path,
                    &hub.url,
                    hub.clients(),
                    "未ログイン",
                    &[],
                    ApplyMode::Saved
                )
                .await
                .unwrap(),
            ApplyResult::Applied { .. }
        ));
        let after = service.snapshot().await.unwrap();
        assert_eq!(after.status, "running");
        assert_ne!(after.engine.unwrap().session, session);
        assert!(after.applied.unwrap().applied_at_ms > first_applied_at);
        service.stop().await.unwrap();
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[derive(Default)]
    struct Played(std::sync::Mutex<Vec<&'static str>>);
    impl BuzzerPlayer for Played {
        fn play_loop(&self) {
            self.0.lock().unwrap().push("loop");
        }
        fn play_once(&self) {
            self.0.lock().unwrap().push("once");
        }
        fn stop(&self) {
            self.0.lock().unwrap().push("stop");
        }
    }

    #[tokio::test]
    async fn sound_import_and_reset_reach_the_player_and_the_snapshot() {
        use crate::alarm_terminal::alarm_sound::{tests::wav, SOUND_FILE};
        #[derive(Default)]
        struct Sounds(std::sync::Mutex<Vec<Option<usize>>>);
        impl BuzzerPlayer for Sounds {
            fn play_loop(&self) {}
            fn play_once(&self) {}
            fn stop(&self) {}
            fn set_sound(&self, wav: Option<Arc<[u8]>>) {
                self.0.lock().unwrap().push(wav.map(|wav| wav.len()));
            }
        }
        let dir = std::env::temp_dir().join(format!("alarm-sound-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sounds = Arc::new(Sounds::default());
        let service = AlarmService::open_with_buzzer(&dir, sounds.clone())
            .await
            .unwrap();
        let beep = BuzzerSound {
            kind: SoundKind::Default,
            fallback: None,
        };
        assert_eq!(service.snapshot().await.unwrap().buzzer_sound, beep);
        let mut notified = service.lagged();
        assert!(matches!(
            service
                .import_sound("x.wav".into(), b"not a wav".to_vec())
                .await,
            Err(AlarmServiceError::InvalidSound(WavRejection::NotWav))
        ));
        let bytes = wav(8, 1, 8_000, 100);
        let view = service
            .import_sound("bell.wav".into(), bytes.clone())
            .await
            .unwrap();
        assert!(matches!(view.sound, SoundSetting::Custom { ref name, .. } if name == "bell.wav"));
        assert_eq!(view.sound_fallback, None);
        assert!(notified.try_recv().is_ok());
        let custom = BuzzerSound {
            kind: SoundKind::Custom,
            fallback: None,
        };
        assert_eq!(service.snapshot().await.unwrap().buzzer_sound, custom);
        service.test_sound().unwrap();
        // Opened again with the file replaced: the beep, with the reason.
        drop(service);
        std::fs::write(dir.join(SOUND_FILE), wav(8, 1, 8_000, 200)).unwrap();
        let service = AlarmService::open_with_buzzer(&dir, sounds.clone())
            .await
            .unwrap();
        let snapshot = serde_json::to_value(service.snapshot().await.unwrap()).unwrap();
        assert_eq!(
            snapshot["buzzerSound"],
            serde_json::json!({"kind": "custom", "fallback": "hashMismatch"})
        );
        assert_eq!(snapshot["buzzer"], "quiet");
        let view = service.reset_sound().await.unwrap();
        assert_eq!(
            (view.sound, view.sound_fallback),
            (SoundSetting::Default, None)
        );
        assert!(!dir.join(SOUND_FILE).exists());
        assert_eq!(service.snapshot().await.unwrap().buzzer_sound, beep);
        assert_eq!(
            *sounds.0.lock().unwrap(),
            vec![None, Some(bytes.len()), None, None]
        );
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Two overlapping sound changes (#234 review): the import saves first,
    /// then the reset saves. Were a change not serialized up to `use_sound`,
    /// the reset could reach the player while the import has yet to resume,
    /// and the import would then install its stale sound. The import waits
    /// for the reset to reach the player: with serialization it never does,
    /// and the saved setting, the snapshot and the player all end on the
    /// reset.
    #[tokio::test]
    async fn overlapping_sound_changes_leave_the_saved_sound_in_the_player() {
        use crate::alarm_terminal::alarm_sound::tests::wav;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::mpsc::{channel, Sender};
        use std::time::Duration;
        /// Tells the import when the beep reaches the player.
        #[derive(Default)]
        struct Sounds {
            set: std::sync::Mutex<Vec<Option<usize>>>,
            beep_reached: std::sync::Mutex<Option<Sender<()>>>,
        }
        impl BuzzerPlayer for Sounds {
            fn play_loop(&self) {}
            fn play_once(&self) {}
            fn stop(&self) {}
            fn set_sound(&self, wav: Option<Arc<[u8]>>) {
                if wav.is_none() {
                    if let Some(tx) = &*self.beep_reached.lock().unwrap() {
                        let _ = tx.send(());
                    }
                }
                self.set.lock().unwrap().push(wav.map(|wav| wav.len()));
            }
        }
        let dir = std::env::temp_dir().join(format!("alarm-sound-race-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sounds = Arc::new(Sounds::default());
        let service = AlarmService::open_with_buzzer(&dir, sounds.clone())
            .await
            .unwrap();
        // Armed after opening, so the beep handed over at open does not count.
        let (beep_tx, beep_rx) = channel::<()>();
        *sounds.beep_reached.lock().unwrap() = Some(beep_tx);
        // Only lets the import go on when serialization holds the reset back.
        let wait = Duration::from_millis(500);
        let (imported_tx, imported_rx) = channel::<()>();
        let raced = Arc::new(AtomicBool::new(false));
        let bytes = wav(8, 1, 8_000, 100);
        let terminal = service.terminal.clone();
        let import_raced = raced.clone();
        let import = service.change_sound(move || {
            let sound = terminal.import_sound("bell.wav", &bytes);
            let _ = imported_tx.send(());
            if beep_rx.recv_timeout(wait).is_ok() {
                import_raced.store(true, Ordering::SeqCst);
            }
            sound
        });
        let terminal = service.terminal.clone();
        let reset = service.change_sound(move || {
            let _ = imported_rx.recv_timeout(wait);
            terminal.reset_sound()
        });
        let (import, reset) = tokio::join!(import, reset);
        assert!(
            !raced.load(Ordering::SeqCst),
            "the reset reached the player before the import had finished"
        );
        import.unwrap();
        let view = reset.unwrap();
        assert_eq!(view.sound, SoundSetting::Default);
        assert_eq!(
            service.alarm_settings().await.unwrap().sound,
            SoundSetting::Default
        );
        assert_eq!(
            service.snapshot().await.unwrap().buzzer_sound,
            BuzzerSound {
                kind: SoundKind::Default,
                fallback: None,
            }
        );
        assert_eq!(sounds.set.lock().unwrap().last(), Some(&None));
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }

    async fn wait_buzzer(service: &AlarmService, want: BuzzerStatus) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while service.snapshot().await.unwrap().buzzer != want {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("buzzer never became {want:?}"));
    }

    #[tokio::test]
    async fn buzzer_rings_for_an_unacked_occurrence_and_silence_is_not_ack() {
        let hub = Hub::new(&[("PLANT.FLAG", "bit")]).await;
        let dir = std::env::temp_dir().join(format!("alarm-buzzer-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.json");
        let id = uuid::Uuid::now_v7().to_string();
        std::fs::write(&path, serde_json::to_vec(&project(&id, "A")).unwrap()).unwrap();
        let played = Arc::new(Played::default());
        let service = AlarmService::open_with_buzzer(&dir, played.clone())
            .await
            .unwrap();
        assert_eq!(service.buzzer_status(), BuzzerStatus::Quiet);
        let mut notified = service.lagged();
        assert!(matches!(
            service
                .apply(
                    &path,
                    &hub.url,
                    hub.clients(),
                    "未ログイン",
                    &[],
                    ApplyMode::Saved
                )
                .await
                .unwrap(),
            ApplyResult::Applied { .. }
        ));
        wait_buzzer(&service, BuzzerStatus::Ringing).await;
        assert!(notified.try_recv().is_ok());
        assert!(matches!(
            service.test_sound(),
            Err(AlarmServiceError::BuzzerRinging)
        ));
        assert_eq!(service.silence_buzzer(), BuzzerStatus::Silenced);
        let snapshot = service.snapshot().await.unwrap();
        assert_eq!(snapshot.buzzer, BuzzerStatus::Silenced);
        let (condition, state) = snapshot
            .engine
            .unwrap()
            .conditions
            .into_iter()
            .next()
            .unwrap();
        assert!(!state.acked, "silence must not ACK");
        assert_eq!(
            service
                .ack(
                    condition,
                    state.occurrence.unwrap(),
                    state.recurrence,
                    "未ログイン".into()
                )
                .await
                .unwrap(),
            AckOutcome::Accepted
        );
        wait_buzzer(&service, BuzzerStatus::Quiet).await;
        service.stop().await.unwrap();
        assert_eq!(service.buzzer_status(), BuzzerStatus::Quiet);
        assert_eq!(*played.0.lock().unwrap(), vec!["loop", "stop"]);
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
                    hub.clients(),
                    "未ログイン",
                    &[],
                    ApplyMode::Saved
                )
                .await
                .unwrap(),
            ApplyResult::Applied {
                initial_monitoring: true,
                ..
            }
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
        let valid_b = serde_json::to_vec(&project(&b_id, "B")).unwrap();
        let mut invalid_b = project(&b_id, "B");
        invalid_b["alarms"]["definitions"][0]["severity"] = json!("invalid");
        std::fs::write(&b, serde_json::to_vec(&invalid_b).unwrap()).unwrap();
        assert!(matches!(
            service
                .apply(
                    &b,
                    &hub.url,
                    hub.clients(),
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
        std::fs::write(&b, valid_b).unwrap();
        assert!(matches!(
            service
                .apply(&b, &hub.url, hub.clients(), "未ログイン", &[], ApplyMode::Explicit { confirmed_switch_from: None })
                .await
                .unwrap(),
            ApplyResult::SwitchConfirmationRequired { monitored_project_id } if monitored_project_id == a_id
        ));
        let needed = match service
            .apply(
                &b,
                &hub.url,
                hub.clients(),
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
                    hub.clients(),
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
            .resume(Some(&hub.url), Some(hub.clients()))
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
                hub.clients(),
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
                    hub.clients(),
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
    async fn apply_during_a_history_outage_keeps_the_running_session() {
        let hub = Hub::new(&[("PLANT.FLAG", "bit")]).await;
        let dir = std::env::temp_dir().join(format!("alarm-outage-apply-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.json");
        let mut value = project(&uuid::Uuid::now_v7().to_string(), "A");
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let service = AlarmService::open(&dir).await.unwrap();
        assert!(matches!(
            service
                .apply(
                    &path,
                    &hub.url,
                    hub.clients(),
                    "未ログイン",
                    &[],
                    ApplyMode::Saved
                )
                .await
                .unwrap(),
            ApplyResult::Applied { .. }
        ));
        let (id, state) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let engine = service.snapshot().await.unwrap().engine.unwrap();
                if let Some((id, state)) = engine
                    .conditions
                    .into_iter()
                    .find(|(_, state)| state.active)
                {
                    break (id, state);
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let db = service.active.lock().await.db.clone().unwrap();
        db.execute_for_test("PRAGMA query_only = 1;").await;
        // The ACK write fails, which starts the outage.
        assert!(matches!(
            service
                .ack(
                    id,
                    state.occurrence.unwrap(),
                    state.recurrence,
                    "未ログイン".into()
                )
                .await,
            Err(AlarmServiceError::Runtime(
                AlarmRuntimeError::HistoryUnwritable
            ))
        ));
        let session = service.snapshot().await.unwrap().engine.unwrap().session;
        // Removing the last definition would take the stop/restart path.
        value["alarms"] = json!({"definitions": []});
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(
            service
                .apply(
                    &path,
                    &hub.url,
                    hub.clients(),
                    "未ログイン",
                    &[],
                    ApplyMode::Saved
                )
                .await,
            Err(AlarmServiceError::Runtime(
                AlarmRuntimeError::HistoryUnwritable
            ))
        ));
        let snapshot = service.snapshot().await.unwrap();
        assert_eq!(snapshot.status, "running");
        assert_eq!(snapshot.engine.unwrap().session, session);
        assert!(snapshot.history_write_failure.is_some());
        db.execute_for_test("PRAGMA query_only = 0;").await;
        drop(db);
        service.stop().await.unwrap();
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn alarm_settings_are_read_checked_saved_and_applied_to_the_engine() {
        let hub = Hub::new(&[("PLANT.FLAG", "bit")]).await;
        let dir = std::env::temp_dir().join(format!("alarm-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.json");
        let value = project(&uuid::Uuid::now_v7().to_string(), "a");
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let service = AlarmService::open(&dir).await.unwrap();
        assert_eq!(
            serde_json::to_value(service.alarm_settings().await.unwrap()).unwrap(),
            json!({
                "retention": {"kind": "days", "days": 365, "count": 1_000_000},
                "reread": {
                    "intervalSec": 10,
                    "timeoutSec": 5,
                    "failureLimitSec": 30,
                    "reconnectFailures": 3,
                },
                "sound": {"kind": "default"},
                "soundFallback": null,
                "warnings": [],
                "retentionStatus": null,
            })
        );
        assert!(matches!(
            service
                .apply(
                    &path,
                    &hub.url,
                    hub.clients(),
                    "未ログイン",
                    &[],
                    ApplyMode::Saved
                )
                .await
                .unwrap(),
            ApplyResult::Applied { .. }
        ));
        let mut lagged = service.lagged();
        let mut settings = AlarmSettings::default();
        settings.reread.failure_limit_sec = settings.reread.interval_sec * 2 - 1;
        assert!(matches!(
            service.set_alarm_settings(settings).await,
            Err(AlarmServiceError::InvalidSettings)
        ));
        assert!(lagged.try_recv().is_err());
        settings.reread.interval_sec = 5;
        settings.reread.failure_limit_sec = 10;
        settings.retention.kind = crate::alarm_terminal::RetentionKind::Count;
        let view = service.set_alarm_settings(settings).await.unwrap();
        assert_eq!(view.settings, settings);
        assert!(view.warnings.is_empty());
        // The monitored Project's DB: the apply and the session start are
        // within the limit, and the oldest of them is not a kept event.
        let status = view.retention_status.unwrap();
        assert!(status.event_count >= 2);
        assert!(status.oldest_at_ms.is_some());
        lagged.try_recv().unwrap();
        assert_eq!(service.snapshot().await.unwrap().status, "running");
        service.stop().await.unwrap();
        drop(service);
        let service = AlarmService::open(&dir).await.unwrap();
        assert_eq!(service.alarm_settings().await.unwrap().settings, settings);
        drop(service);
        let _ = std::fs::remove_dir_all(dir);
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
                    hub.clients(),
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
                hub.clients(),
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
                .apply(&b, &hub.url, hub.clients(), "未ログイン", &[], ApplyMode::Explicit { confirmed_switch_from: None })
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
                .apply(&b, &hub.url, hub.clients(), "未ログイン", &[], ApplyMode::Explicit { confirmed_switch_from: Some(&b_id) })
                .await
                .unwrap(),
            ApplyResult::SwitchConfirmationRequired { monitored_project_id } if monitored_project_id == a_id
        ));
        service
            .apply(
                &b,
                &hub.url,
                hub.clients(),
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
    async fn pending_changes_use_the_monitored_projects_applied_definitions() {
        let dir = std::env::temp_dir().join(format!("alarm-pending-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("monitored.json");
        let project_id = uuid::Uuid::now_v7().to_string();
        let original = project(&project_id, "Original");
        std::fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
        let service = AlarmService::open(&dir).await.unwrap();
        let saved = SavedAlarmProject::read(&path).unwrap();
        let db = AlarmDb::open(service.terminal.clone(), &project_id)
            .await
            .unwrap();
        db.apply(
            &saved.applied(
                "http://127.0.0.1:8722".into(),
                "未ログイン".into(),
                wall_ms(),
            ),
            None,
            &[],
            &[],
        )
        .await
        .unwrap();
        db.close().await;
        service
            .terminal
            .set_monitored(Some(MonitoredProject {
                project_id: project_id.clone(),
                path: path.clone(),
            }))
            .unwrap();
        let mut edited = original;
        edited["alarms"]["definitions"][0]["name"] = json!("Edited");
        std::fs::write(&path, serde_json::to_vec(&edited).unwrap()).unwrap();
        let snapshot = service.snapshot().await.unwrap();
        assert_eq!(snapshot.applied.unwrap().project_id, project_id);
        assert!(snapshot.pending_display_changes);
        assert!(!snapshot.pending_condition_changes);
        assert!(!snapshot.pending_unknown);

        // Another Project in the monitored file: unknown, not "no changes".
        let other = project(&uuid::Uuid::now_v7().to_string(), "Other");
        std::fs::write(&path, serde_json::to_vec(&other).unwrap()).unwrap();
        let snapshot = service.snapshot().await.unwrap();
        assert!(snapshot.pending_unknown);
        assert!(!snapshot.pending_display_changes);
        assert!(!snapshot.pending_condition_changes);

        // The monitored file is gone.
        std::fs::remove_file(&path).unwrap();
        let snapshot = service.snapshot().await.unwrap();
        assert!(snapshot.pending_unknown);
        assert!(!snapshot.pending_display_changes);

        // It comes back with the applied Project: known again.
        std::fs::write(&path, serde_json::to_vec(&edited).unwrap()).unwrap();
        let snapshot = service.snapshot().await.unwrap();
        assert!(!snapshot.pending_unknown);
        assert!(snapshot.pending_display_changes);
        drop(service);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_engine_that_ended_by_itself_reports_why() {
        let statuses = [
            AlarmStopReason::Requested,
            AlarmStopReason::Unauthorized,
            AlarmStopReason::ConnectionFailure,
            AlarmStopReason::StorageFailure,
            AlarmStopReason::InvalidDefinition,
            AlarmStopReason::InternalError,
        ]
        .map(stop_status);
        assert_eq!(
            statuses,
            [
                "stopped",
                "authExpired",
                "connectionFailed",
                "alarmDbFailed",
                "invalidAppliedDefinition",
                "engineFailed",
            ]
        );
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
        let mut other = project(&other_id, "Other");
        other["alarms"]["definitions"][0]["severity"] = json!("invalid");
        std::fs::write(&other_path, serde_json::to_vec(&other).unwrap()).unwrap();
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
                    hub.clients(),
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
