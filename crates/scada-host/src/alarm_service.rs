//! One terminal-wide owner of the alarm subscription and applied Project.
//! Callers supply only a host-resolved saved path and the protected Hub client.
use std::collections::BTreeMap;
use std::path::Path;
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
#[serde(rename_all = "camelCase", tag = "status")]
pub enum ApplyResult {
    Applied { snapshot: AlarmSnapshot },
    SkippedDifferentProject,
    ConfirmationRequired { occurrences: Vec<UnackedOccurrence> },
}

struct Active {
    runtime: Option<AlarmRuntime>,
    db: Option<Arc<AlarmDb>>,
    project_id: Option<String>,
    pump: Option<JoinHandle<()>>,
    reason: String,
}

pub struct AlarmService {
    terminal: Arc<AlarmTerminal>,
    active: Mutex<Active>,
    changes: broadcast::Sender<AlarmChange>,
}

impl AlarmService {
    pub async fn open(data_dir: &Path) -> Result<Self, AlarmServiceError> {
        let terminal = Arc::new(AlarmTerminal::open(data_dir).await?);
        let (changes, _) = broadcast::channel(256);
        let service = Self {
            terminal,
            active: Mutex::new(Active {
                runtime: None,
                db: None,
                project_id: None,
                pump: None,
                reason: "notApplied".into(),
            }),
            changes,
        };
        service.recover_switch().await?;
        Ok(service)
    }

    pub fn changes(&self) -> broadcast::Receiver<AlarmChange> {
        self.changes.subscribe()
    }

    async fn recover_switch(&self) -> Result<(), AlarmServiceError> {
        let Some(switching) = self.terminal.switching()? else {
            return Ok(());
        };
        let target_db = AlarmDb::open(self.terminal.clone(), &switching.target.project_id).await?;
        let committed = target_db
            .applied()
            .await?
            .is_some_and(|applied| applied.file_hash == switching.file_hash);
        if committed {
            if let Some(old) = self.terminal.monitored()? {
                if old.project_id != switching.target.project_id {
                    let old_db = AlarmDb::open(self.terminal.clone(), &old.project_id).await?;
                    old_db.close_unstopped_session(wall_ms()).await?;
                    let confirmed = all_unacked(&old_db.last_states().await?)?;
                    old_db.end_monitoring(wall_ms(), &confirmed).await?;
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
        if active.runtime.as_ref().is_some_and(|runtime| {
            !matches!(*runtime.status().borrow(), AlarmRuntimeStatus::Running)
        }) {
            let runtime = active.runtime.take().expect("checked runtime");
            let _ = runtime.stop().await;
            if let Some(pump) = active.pump.take() {
                pump.abort();
            }
            active.db = None;
            active.project_id = None;
        }
        if active.runtime.is_none() {
            if let Err(error) = self.start_locked(&mut active, endpoint, client).await {
                active.reason = stopped_reason(&error).into();
            }
        }
        self.snapshot_locked(&active).await
    }

    async fn start_locked(
        &self,
        active: &mut Active,
        endpoint: Option<&str>,
        client: Option<RestClient>,
    ) -> Result<(), AlarmServiceError> {
        let Some(monitored) = self.terminal.monitored()? else {
            active.reason = "notApplied".into();
            return Ok(());
        };
        let db = Arc::new(AlarmDb::open(self.terminal.clone(), &monitored.project_id).await?);
        let Some(applied) = db.applied().await? else {
            active.reason = "notApplied".into();
            return Ok(());
        };
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
        let sender = self.changes.clone();
        active.pump = Some(tokio::spawn(async move {
            loop {
                match receiver.recv().await {
                    Ok(change) => {
                        let _ = sender.send(change);
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
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
                result.map_err(AlarmServiceError::from)
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
        active.project_id = None;
        active.reason = "stopped".into();
        result
    }

    pub async fn stop(&self) -> Result<(), AlarmServiceError> {
        let mut active = self.active.lock().await;
        Self::stop_locked(&mut active).await
    }

    pub async fn apply(
        &self,
        path: &Path,
        endpoint: &str,
        client: RestClient,
        applied_by: &str,
        confirmed: &[UnackedOccurrence],
        explicit: bool,
    ) -> Result<ApplyResult, AlarmServiceError> {
        let saved = SavedAlarmProject::read(path)?;
        let mut active = self.active.lock().await;
        let previous = self.terminal.monitored()?;
        if !explicit
            && previous
                .as_ref()
                .is_some_and(|old| old.project_id != saved.project_id)
        {
            return Ok(ApplyResult::SkippedDifferentProject);
        }
        let applied = saved.applied(endpoint.into(), applied_by.into(), wall_ms());
        let same_project = previous
            .as_ref()
            .is_some_and(|old| old.project_id == saved.project_id);
        let old_applied = if let Some(old) = &previous {
            let db = AlarmDb::open(self.terminal.clone(), &old.project_id).await?;
            let applied = db.applied().await?;
            db.close().await;
            applied
        } else {
            None
        };
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
                        .apply(applied, saved.definitions, confirmed.to_vec(), client)
                        .await
                    {
                        Ok(()) => {
                            self.terminal.set_monitored(Some(MonitoredProject {
                                project_id: saved.project_id,
                                path: path.to_owned(),
                            }))?;
                            return Ok(ApplyResult::Applied {
                                snapshot: self.snapshot_locked(&active).await?,
                            });
                        }
                        Err(error) => return Err(error.into()),
                    }
                }
            }
        }
        let target_db = Arc::new(AlarmDb::open(self.terminal.clone(), &saved.project_id).await?);
        let target_rows = target_db.last_states().await?;
        let target_plan = plan_apply(&target_rows, &applied, wall_ms())?;
        let mut unacked = target_plan.unacked.clone();
        let mut old_unacked = Vec::new();
        if let Some(old) = &previous {
            if old.project_id != saved.project_id {
                let old_db = AlarmDb::open(self.terminal.clone(), &old.project_id).await?;
                old_unacked = all_unacked(&old_db.last_states().await?)?;
                unacked.extend(old_unacked.clone());
            }
        }
        unacked.sort();
        let mut claimed = confirmed.to_vec();
        claimed.sort();
        if claimed != unacked {
            return Ok(ApplyResult::ConfirmationRequired {
                occurrences: unacked,
            });
        }
        let switching = previous
            .as_ref()
            .is_some_and(|old| old.project_id != saved.project_id);
        let target = MonitoredProject {
            project_id: saved.project_id.clone(),
            path: path.to_owned(),
        };
        if switching {
            self.terminal.set_switching(Some(PendingSwitch {
                target: target.clone(),
                file_hash: saved.file_hash.clone(),
            }))?;
        }
        if let Err(error) = Self::stop_locked(&mut active).await {
            if switching {
                self.terminal.set_switching(None)?;
            }
            return Err(error);
        }
        if let Some(old) = &previous {
            let old_db = AlarmDb::open(self.terminal.clone(), &old.project_id).await?;
            old_db.close_unstopped_session(wall_ms()).await?;
            if switching {
                let fresh = all_unacked(&old_db.last_states().await?)?;
                if fresh != old_unacked {
                    self.terminal.set_switching(None)?;
                    if old_applied
                        .as_ref()
                        .is_some_and(|old| old.endpoint == endpoint)
                    {
                        let _ = self
                            .start_locked(&mut active, Some(endpoint), Some(client))
                            .await;
                    }
                    let mut occurrences = fresh;
                    occurrences.extend(target_plan.unacked);
                    occurrences.sort();
                    return Ok(ApplyResult::ConfirmationRequired { occurrences });
                }
            }
        }
        target_db.close_unstopped_session(wall_ms()).await?;
        let plan = plan_apply(&target_db.last_states().await?, &applied, wall_ms())?;
        let target_confirmed: Vec<_> = confirmed
            .iter()
            .filter(|entry| plan.unacked.contains(entry))
            .cloned()
            .collect();
        if let Err(error) = target_db
            .apply_confirmed(
                &applied,
                None,
                &plan.ended,
                &plan.survivors,
                &target_confirmed,
            )
            .await
        {
            if switching {
                self.terminal.set_switching(None)?;
            }
            if old_applied
                .as_ref()
                .is_some_and(|old| old.endpoint == endpoint)
            {
                let _ = self
                    .start_locked(&mut active, Some(endpoint), Some(client))
                    .await;
            }
            return match error {
                AlarmDbError::ConfirmationRequired(mut occurrences) if switching => {
                    occurrences.extend(old_unacked);
                    occurrences.sort();
                    Err(AlarmServiceError::ConfirmationRequired(occurrences))
                }
                error => Err(error.into()),
            };
        }
        if switching {
            let old = previous
                .as_ref()
                .ok_or(AlarmServiceError::NoMonitoredProject)?;
            AlarmDb::open(self.terminal.clone(), &old.project_id)
                .await?
                .end_monitoring(wall_ms(), &old_unacked)
                .await?;
        }
        self.terminal.set_monitored(Some(target))?;
        if let Err(error) = self
            .start_locked(&mut active, Some(endpoint), Some(client))
            .await
        {
            active.reason = stopped_reason(&error).into();
        }
        Ok(ApplyResult::Applied {
            snapshot: self.snapshot_locked(&active).await?,
        })
    }

    pub async fn snapshot(&self) -> Result<AlarmSnapshot, AlarmServiceError> {
        let active = self.active.lock().await;
        self.snapshot_locked(&active).await
    }

    pub async fn applied_endpoint(&self) -> Result<Option<String>, AlarmServiceError> {
        let Some(monitored) = self.terminal.monitored()? else {
            return Ok(None);
        };
        Ok(AlarmDb::open(self.terminal.clone(), &monitored.project_id)
            .await?
            .applied()
            .await?
            .map(|applied| applied.endpoint))
    }

    async fn snapshot_locked(&self, active: &Active) -> Result<AlarmSnapshot, AlarmServiceError> {
        let monitored = self.terminal.monitored()?;
        let applied = if let Some(monitored) = &monitored {
            Some(
                AlarmDb::open(self.terminal.clone(), &monitored.project_id)
                    .await?
                    .applied()
                    .await?,
            )
            .flatten()
        } else {
            None
        };
        let (pending_condition_changes, pending_display_changes) = match (&monitored, &applied) {
            (Some(monitored), Some(applied)) => match SavedAlarmProject::read(&monitored.path) {
                Ok(saved) if saved.project_id == applied.project_id => (
                    saved
                        .applied(
                            applied.endpoint.clone(),
                            applied.applied_by.clone(),
                            applied.applied_at_ms,
                        )
                        .condition_hashes
                        != applied.condition_hashes
                        || saved.disabled != applied.disabled_condition_ids,
                    saved.displays != applied.displays,
                ),
                _ => (false, false),
            },
            _ => (false, false),
        };
        let engine = match &active.runtime {
            Some(runtime) => Some(runtime.snapshot().await?.into()),
            None => None,
        };
        let status = match &active.runtime {
            Some(runtime) => match *runtime.status().borrow() {
                AlarmRuntimeStatus::Running => "running".into(),
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
            pending_condition_changes,
            pending_display_changes,
        })
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
        Ok(runtime.ack(condition, occurrence, recurrence, user).await?)
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
        Ok(AlarmDb::open(self.terminal.clone(), &monitored.project_id)
            .await?
            .history(before_seq, from_ms, to_ms, kind, limit)
            .await?)
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
                .apply(&a, &hub.url, hub.client(), "未ログイン", &[], false)
                .await
                .unwrap(),
            ApplyResult::Applied { .. }
        ));
        let a_session = service.snapshot().await.unwrap().engine.unwrap().session;
        assert!(matches!(
            service
                .apply(&b, &hub.url, hub.client(), "未ログイン", &[], false)
                .await
                .unwrap(),
            ApplyResult::SkippedDifferentProject
        ));
        assert_eq!(
            service.snapshot().await.unwrap().engine.unwrap().session,
            a_session
        );
        let needed = match service
            .apply(&b, &hub.url, hub.client(), "未ログイン", &[], true)
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
                .apply(&b, &hub.url, hub.client(), "未ログイン", &needed, true)
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
            .apply(&b, &hub.url, hub.client(), "未ログイン", &[], true)
            .await
            .unwrap()
        {
            ApplyResult::ConfirmationRequired { occurrences } => occurrences,
            _ => panic!("removing an active condition needs confirmation"),
        };
        assert!(matches!(
            resumed
                .apply(&b, &hub.url, hub.client(), "未ログイン", &needed, true)
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
                .apply(&path, &hub.url, hub.client(), "未ログイン", &[], false)
                .await
                .unwrap(),
            ApplyResult::Applied { .. }
        ));
        assert!(service.snapshot().await.unwrap().applied.is_some());
        service.stop().await.unwrap();
        drop(service);
        for _ in 0..20 {
            if std::fs::remove_dir_all(&dir).is_ok() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("temporary alarm DB handles were not released");
    }
}
