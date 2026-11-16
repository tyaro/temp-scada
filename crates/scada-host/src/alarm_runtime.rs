//! Dedicated Hub subscription and durable alarm evaluation for one session.
//! The webview does not own the subscription or the Engine.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use banto_tagclient::{
    BindingRequest, BindingView, CatalogTag, ErrorKind, GenerationSnapshot,
    TagClientConnectionState, TagClientHandle, TagClientState, ValueEntry, ValueQuality,
};
use scada_alarm::{
    AckOutcome, EndReason, Engine, EngineUnavailable, Event, EventKind, Input, Now, Quality,
    Sample, TagValue, Transition,
};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use crate::alarm_db::{
    plan_apply, AlarmDb, AlarmDbError, AppliedDefinitions, Definition, EventWrite, LastRow,
    StartedAlarmSession, UnackedOccurrence, UnrecordedPeriod,
};
use crate::alarm_terminal::ActiveAlarmSession;

mod freshness;

use freshness::{differs, Freshness, RereadResult};
pub use freshness::{FreshnessConfig, HubClients, RereadFailure};

#[derive(Debug)]
pub enum AlarmRuntimeError {
    Db(AlarmDbError),
    Sdk(ErrorKind),
    Step(scada_alarm::StepError),
    InvalidDefinition,
    Internal,
    StorageFailure,
    ConnectionFailure,
    /// The alarm DB cannot be written now. ACK and apply are refused until a
    /// retry records the unrecorded period (design §5.3).
    HistoryUnwritable,
    Closed,
}

/// Interval between write retries while the alarm DB cannot be written.
const HISTORY_RETRY: Duration = Duration::from_secs(5);

/// The current history write outage. Evaluation continues; events that
/// could not be written are counted, not queued.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryWriteFailure {
    pub since_wall_ms: i64,
    pub unrecorded_events: u64,
}

impl From<AlarmDbError> for AlarmRuntimeError {
    fn from(value: AlarmDbError) -> Self {
        Self::Db(value)
    }
}

/// A complete durable change. The IPC layer can publish it as `alarm_changed`.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlarmChange {
    pub session: scada_alarm::Session,
    pub seq: u64,
    pub conditions: BTreeMap<String, Option<scada_alarm::ConditionState>>,
    pub engine_unavailable: Option<EngineUnavailable>,
    pub events: Vec<Event>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied: Option<AppliedDefinitions>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AlarmStopReason {
    Requested,
    Unauthorized,
    ConnectionFailure,
    StorageFailure,
    InvalidDefinition,
    InternalError,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum AlarmRuntimeStatus {
    Running,
    Stopped { reason: AlarmStopReason },
}

pub struct AlarmEvaluator {
    db: Arc<AlarmDb>,
    applied: AppliedDefinitions,
    engine: Engine,
    _active: ActiveAlarmSession,
    origin: Instant,
    history: watch::Sender<Option<HistoryWriteFailure>>,
}

impl AlarmEvaluator {
    pub async fn new(
        db: Arc<AlarmDb>,
        applied: AppliedDefinitions,
        started: StartedAlarmSession,
    ) -> Result<Self, AlarmRuntimeError> {
        let stored = match db.applied().await {
            Ok(stored) => stored,
            Err(error) => return Err(AlarmRuntimeError::Db(error)),
        };
        let session = match db.session().await {
            Ok(session) => session,
            Err(error) => return Err(AlarmRuntimeError::Db(error)),
        };
        if stored.as_ref() != Some(&applied)
            || session
                .as_ref()
                .is_none_or(|record| record.stopped || &record.session != started.session())
            || applied.condition_hashes.len() != started.conditions().len()
            || started.conditions().iter().any(|(id, condition)| {
                applied.condition_hashes.get(id)
                    != Some(
                        &Definition {
                            spec: condition.spec.clone(),
                        }
                        .evaluation_hash(),
                    )
            })
        {
            let _ = db.stop_session(started.session(), wall_ms()).await;
            return Err(AlarmRuntimeError::InvalidDefinition);
        }
        let (engine, active) = started.into_parts();
        Ok(Self {
            db,
            applied,
            engine,
            _active: active,
            origin: Instant::now(),
            history: watch::channel(None).0,
        })
    }

    pub fn history_failure(&self) -> Option<HistoryWriteFailure> {
        *self.history.borrow()
    }

    fn begin_outage(&self, at_wall_ms: i64, events: usize) {
        let events = events as u64;
        self.history.send_modify(|failure| match failure {
            Some(failure) => {
                failure.unrecorded_events = failure.unrecorded_events.saturating_add(events)
            }
            None => {
                *failure = Some(HistoryWriteFailure {
                    since_wall_ms: at_wall_ms,
                    unrecorded_events: events,
                })
            }
        });
    }

    /// Retry after an outage: one transaction writes `unrecordedPeriod` and
    /// rewrites `last_state` from the in-memory Engine. Returns whether the
    /// outage is over; a further storage outage keeps it for the next retry.
    pub async fn recover_history(&mut self) -> Result<bool, AlarmRuntimeError> {
        let Some(failure) = self.history_failure() else {
            return Ok(true);
        };
        let rows = self
            .engine
            .conditions()
            .iter()
            .map(|(id, condition)| {
                Ok(LastRow {
                    condition_id: id.clone(),
                    evaluation_hash: self
                        .applied
                        .condition_hashes
                        .get(id)
                        .ok_or(AlarmRuntimeError::InvalidDefinition)?
                        .clone(),
                    endpoint: self.applied.endpoint.clone(),
                    state: condition.state.to_last_state(),
                    session_id: self.engine.session().id.clone(),
                    last_event_seq: None,
                })
            })
            .collect::<Result<Vec<_>, AlarmRuntimeError>>()?;
        let period = UnrecordedPeriod {
            from_ms: failure.since_wall_ms,
            to_ms: wall_ms().max(failure.since_wall_ms),
            unrecorded_events: failure.unrecorded_events,
        };
        match self
            .db
            .record_unrecorded_period(
                self.engine.session(),
                period,
                &rows,
                self.engine.unavailable(),
            )
            .await
        {
            Ok(()) => {
                self.history.send_replace(None);
                Ok(true)
            }
            Err(error) if error.is_storage_outage() => {
                eprintln!("alarm history is still unwritable: {error:?}");
                Ok(false)
            }
            Err(error) => Err(AlarmRuntimeError::Db(error)),
        }
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    pub fn now(&self) -> Now {
        Now {
            mono_ms: self.origin.elapsed().as_millis().min(u64::MAX as u128) as u64,
            wall_ms: wall_ms(),
        }
    }

    /// Prepare the pure replacement before the DB write and install it only
    /// after the applied record, ended rows and survivors commit together.
    pub async fn apply(
        &mut self,
        applied: AppliedDefinitions,
        definitions: &BTreeMap<String, Definition>,
        confirmed: &[UnackedOccurrence],
    ) -> Result<AlarmChange, AlarmRuntimeError> {
        // The DB and the Engine must not disagree on the definitions.
        if self.history_failure().is_some() {
            return Err(AlarmRuntimeError::HistoryUnwritable);
        }
        if applied.project_id != self.applied.project_id
            || applied.endpoint != self.applied.endpoint
            || applied.condition_hashes
                != definitions
                    .iter()
                    .map(|(id, definition)| (id.clone(), definition.evaluation_hash()))
                    .collect()
        {
            return Err(AlarmRuntimeError::InvalidDefinition);
        }
        let now = self.now();
        let rows = self.db.last_states().await?;
        let plan = plan_apply(&rows, &applied, now.wall_ms)?;
        let mut next = self.engine.clone();
        let specs = definitions
            .iter()
            .map(|(id, definition)| (id.clone(), definition.spec.clone()))
            .collect();
        let conditions = next
            .replace_definitions(&specs)
            .map_err(|_| AlarmRuntimeError::InvalidDefinition)?;
        let events = plan
            .ended
            .iter()
            .map(|write| {
                let id = write
                    .condition_id
                    .as_ref()
                    .ok_or(AlarmRuntimeError::Internal)?;
                let row = rows
                    .iter()
                    .find(|row| &row.condition_id == id)
                    .ok_or(AlarmRuntimeError::Internal)?;
                let reason = match write.kind.as_str() {
                    "definitionChanged" => EndReason::DefinitionChanged,
                    "definitionDeleted" => EndReason::DefinitionDeleted,
                    "connectionChanged" => EndReason::ConnectionChanged,
                    _ => return Err(AlarmRuntimeError::Internal),
                };
                Ok(Event {
                    at_wall_ms: write.at_ms,
                    condition: Some(id.clone()),
                    occurrence: row.state.occurrence.clone(),
                    recurrence: row.state.occurrence.as_ref().map(|_| row.state.recurrence),
                    kind: EventKind::Ended {
                        reason,
                        unacked: !row.state.acked,
                    },
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.db
            .apply_confirmed(
                &applied,
                Some(self.engine.session()),
                &plan.ended,
                &plan.survivors,
                confirmed,
            )
            .await?;
        self.engine = next;
        self.applied = applied.clone();
        Ok(AlarmChange {
            session: self.engine.session().clone(),
            seq: self.engine.seq(),
            conditions,
            engine_unavailable: self.engine.unavailable(),
            events,
            applied: Some(applied),
        })
    }

    /// The DB transaction precedes Engine commit and change publication for every input.
    pub async fn input(&mut self, input: Input) -> Result<Option<AlarmChange>, AlarmRuntimeError> {
        Ok(self.input_with_ack(input).await?.0)
    }

    async fn input_with_ack(
        &mut self,
        input: Input,
    ) -> Result<(Option<AlarmChange>, Option<AckOutcome>), AlarmRuntimeError> {
        let is_ack = matches!(input, Input::Ack { .. });
        // An ACK is confirmed only once it is durable; a restart must not
        // bring an acknowledged occurrence back as unacknowledged.
        if is_ack && self.history_failure().is_some() {
            return Err(AlarmRuntimeError::HistoryUnwritable);
        }
        let now = self.now();
        let transition = self
            .engine
            .step(now, &input, &mut || uuid::Uuid::now_v7().to_string())
            .map_err(AlarmRuntimeError::Step)?;
        let change = transition.changed.then(|| AlarmChange {
            session: self.engine.session().clone(),
            seq: transition.seq,
            conditions: transition.conditions.clone(),
            engine_unavailable: transition.engine_unavailable,
            events: transition.events.clone(),
            applied: None,
        });
        if transition.changed {
            if self.history_failure().is_some() {
                self.begin_outage(now.wall_ms, transition.events.len());
            } else if let Err(error) = self.persist(&transition).await {
                match error {
                    AlarmRuntimeError::Db(error) if error.is_storage_outage() => {
                        eprintln!("alarm history write failed: {error:?}");
                        if is_ack {
                            // Refuse the ACK; the Engine keeps its prior state.
                            self.begin_outage(now.wall_ms, 0);
                            return Err(AlarmRuntimeError::HistoryUnwritable);
                        }
                        self.begin_outage(now.wall_ms, transition.events.len());
                    }
                    error => return Err(error),
                }
            }
        }
        let ack = transition.ack;
        // Hidden observation/timer state can change without a display change.
        self.engine.commit(transition);
        Ok((change, ack))
    }

    async fn persist(&self, transition: &Transition) -> Result<(), AlarmRuntimeError> {
        let mut changed = Vec::new();
        let mut removed = Vec::new();
        for (id, state) in &transition.conditions {
            match state {
                Some(state) => changed.push(LastRow {
                    condition_id: id.clone(),
                    evaluation_hash: self
                        .applied
                        .condition_hashes
                        .get(id)
                        .ok_or(AlarmRuntimeError::InvalidDefinition)?
                        .clone(),
                    endpoint: self.applied.endpoint.clone(),
                    state: state.to_last_state(),
                    session_id: self.engine.session().id.clone(),
                    last_event_seq: None,
                }),
                None => removed.push(id.clone()),
            }
        }
        let events = transition
            .events
            .iter()
            .map(event_write)
            .collect::<Result<Vec<_>, _>>()?;
        let availability = (transition.engine_unavailable != self.engine.unavailable())
            .then_some(transition.engine_unavailable);
        self.db
            .append(
                self.engine.session(),
                &events,
                &changed,
                &removed,
                availability,
            )
            .await?;
        Ok(())
    }
}

fn event_write(event: &Event) -> Result<EventWrite, AlarmRuntimeError> {
    let mut detail = serde_json::to_value(event).map_err(|_| AlarmRuntimeError::Internal)?;
    let kind = detail
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .ok_or(AlarmRuntimeError::Internal)?
        .to_owned();
    if let Some(map) = detail.as_object_mut() {
        map.remove("kind");
        map.remove("atWallMs");
        map.remove("condition");
    }
    Ok(EventWrite {
        at_ms: event.at_wall_ms,
        condition_id: event.condition.clone(),
        kind,
        detail,
    })
}

fn wall_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            duration.as_millis().min(i64::MAX as u128) as i64
        })
}

enum Control {
    Snapshot(oneshot::Sender<Engine>),
    Apply(Box<ApplyCommand>),
    Ack {
        condition: String,
        occurrence: String,
        recurrence: u32,
        user: String,
        reply: oneshot::Sender<Result<AckOutcome, AlarmRuntimeError>>,
    },
    Stop(oneshot::Sender<Result<(), AlarmRuntimeError>>),
}

struct ApplyCommand {
    applied: AppliedDefinitions,
    definitions: BTreeMap<String, Definition>,
    confirmed: Vec<UnackedOccurrence>,
    clients: HubClients,
    reply: oneshot::Sender<Result<(), AlarmRuntimeError>>,
}

/// One owner for the dedicated SDK connection and serialized Engine inputs.
pub struct AlarmRuntime {
    control: mpsc::Sender<Control>,
    changes: broadcast::Sender<AlarmChange>,
    status: watch::Receiver<AlarmRuntimeStatus>,
    history: watch::Receiver<Option<HistoryWriteFailure>>,
    reread: watch::Receiver<Option<RereadFailure>>,
    task: tokio::task::JoinHandle<Result<(), AlarmRuntimeError>>,
}

impl AlarmRuntime {
    /// Start with `clients` for the applied endpoint. The caller compares
    /// its HubRecord endpoint with the applied record on every client.
    pub async fn start(
        evaluator: AlarmEvaluator,
        clients: HubClients,
    ) -> Result<Self, AlarmRuntimeError> {
        Self::start_with_config(evaluator, clients, FreshnessConfig::default()).await
    }

    pub async fn start_with_config(
        evaluator: AlarmEvaluator,
        clients: HubClients,
        config: FreshnessConfig,
    ) -> Result<Self, AlarmRuntimeError> {
        let tags: BTreeSet<_> = evaluator
            .engine
            .conditions()
            .values()
            .map(|condition| condition.spec.source.tag().to_owned())
            .collect();
        let started = match clients.make() {
            Some(client) => client.start(requests(&tags)).map_err(|error| error.kind()),
            None => Err(ErrorKind::Transport),
        };
        let sdk = match started {
            Ok(sdk) => sdk,
            Err(kind) => {
                let _ = evaluator
                    .db
                    .stop_session(evaluator.engine.session(), wall_ms())
                    .await;
                return Err(AlarmRuntimeError::Sdk(kind));
            }
        };
        let (control, control_rx) = mpsc::channel(32);
        let (changes, _) = broadcast::channel(256);
        let change_tx = changes.clone();
        let (status_tx, status) = watch::channel(AlarmRuntimeStatus::Running);
        let history = evaluator.history.subscribe();
        let (reread_tx, reread) = watch::channel(None);
        let freshness = Freshness::new(config, clients, reread_tx);
        let task = tokio::spawn(run(
            evaluator, sdk, control_rx, change_tx, tags, freshness, status_tx,
        ));
        Ok(Self {
            control,
            changes,
            status,
            history,
            reread,
            task,
        })
    }

    /// A lagged receiver must discard its diffs and call `snapshot()` again.
    /// The same rule applies to a gap in `seq` within one session generation.
    pub fn changes(&self) -> broadcast::Receiver<AlarmChange> {
        self.changes.subscribe()
    }

    pub fn status(&self) -> watch::Receiver<AlarmRuntimeStatus> {
        self.status.clone()
    }

    /// The current history write outage; a change asks viewers to refresh.
    pub fn history(&self) -> watch::Receiver<Option<HistoryWriteFailure>> {
        self.history.clone()
    }

    /// The current reread failure streak; a change asks viewers to refresh.
    pub fn reread_failure(&self) -> watch::Receiver<Option<RereadFailure>> {
        self.reread.clone()
    }

    pub async fn apply(
        &self,
        applied: AppliedDefinitions,
        definitions: BTreeMap<String, Definition>,
        confirmed: Vec<UnackedOccurrence>,
        clients: HubClients,
    ) -> Result<(), AlarmRuntimeError> {
        let (reply, rx) = oneshot::channel();
        self.control
            .send(Control::Apply(Box::new(ApplyCommand {
                applied,
                definitions,
                confirmed,
                clients,
                reply,
            })))
            .await
            .map_err(|_| AlarmRuntimeError::Closed)?;
        rx.await.map_err(|_| AlarmRuntimeError::Closed)?
    }

    pub async fn snapshot(&self) -> Result<Engine, AlarmRuntimeError> {
        let (reply, rx) = oneshot::channel();
        self.control
            .send(Control::Snapshot(reply))
            .await
            .map_err(|_| AlarmRuntimeError::Closed)?;
        rx.await.map_err(|_| AlarmRuntimeError::Closed)
    }

    pub async fn ack(
        &self,
        condition: String,
        occurrence: String,
        recurrence: u32,
        user: String,
    ) -> Result<AckOutcome, AlarmRuntimeError> {
        let (reply, rx) = oneshot::channel();
        self.control
            .send(Control::Ack {
                condition,
                occurrence,
                recurrence,
                user,
                reply,
            })
            .await
            .map_err(|_| AlarmRuntimeError::Closed)?;
        rx.await.map_err(|_| AlarmRuntimeError::Closed)?
    }

    pub async fn stop(self) -> Result<(), AlarmRuntimeError> {
        let (reply, rx) = oneshot::channel();
        if self.control.send(Control::Stop(reply)).await.is_err() {
            return self.task.await.map_err(|_| AlarmRuntimeError::Closed)?;
        }
        match rx.await {
            Ok(result) => {
                self.task.await.map_err(|_| AlarmRuntimeError::Closed)??;
                result
            }
            Err(_) => self.task.await.map_err(|_| AlarmRuntimeError::Closed)?,
        }
    }
}

async fn run(
    evaluator: AlarmEvaluator,
    sdk: TagClientHandle,
    control_rx: mpsc::Receiver<Control>,
    change_tx: broadcast::Sender<AlarmChange>,
    tags: BTreeSet<String>,
    freshness: Freshness,
    status_tx: watch::Sender<AlarmRuntimeStatus>,
) -> Result<(), AlarmRuntimeError> {
    run_with_status(
        run_inner(evaluator, sdk, control_rx, change_tx, tags, freshness),
        status_tx,
    )
    .await
}

fn requests(tags: &BTreeSet<String>) -> Vec<BindingRequest> {
    tags.iter()
        .map(|tag| BindingRequest {
            binding_key: tag.clone(),
            external_name: tag.clone(),
        })
        .collect()
}

/// Swap in a new subscription; the old one is shut down in the background.
fn replace_sdk(
    sdk: &mut TagClientHandle,
    states: &mut watch::Receiver<TagClientState>,
    replacement: TagClientHandle,
) {
    let old = std::mem::replace(sdk, replacement);
    *states = sdk.state_watch();
    tokio::spawn(async move {
        let _ = tokio::time::timeout(Duration::from_secs(5), old.shutdown()).await;
    });
}

struct StopOnDrop(watch::Sender<AlarmRuntimeStatus>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        // A task panic or cancellation drops the future without returning a Result.
        self.0.send_if_modified(|status| {
            if *status == AlarmRuntimeStatus::Running {
                *status = AlarmRuntimeStatus::Stopped {
                    reason: AlarmStopReason::InternalError,
                };
                true
            } else {
                false
            }
        });
    }
}

async fn run_with_status<F>(
    future: F,
    status_tx: watch::Sender<AlarmRuntimeStatus>,
) -> Result<(), AlarmRuntimeError>
where
    F: std::future::Future<Output = Result<(), AlarmRuntimeError>>,
{
    let guard = StopOnDrop(status_tx);
    let result = future.await;
    let reason = match &result {
        Ok(()) => AlarmStopReason::Requested,
        Err(AlarmRuntimeError::Sdk(ErrorKind::Unauthorized)) => AlarmStopReason::Unauthorized,
        Err(AlarmRuntimeError::Sdk(_) | AlarmRuntimeError::ConnectionFailure) => {
            AlarmStopReason::ConnectionFailure
        }
        Err(
            AlarmRuntimeError::Db(_)
            | AlarmRuntimeError::StorageFailure
            | AlarmRuntimeError::HistoryUnwritable,
        ) => AlarmStopReason::StorageFailure,
        Err(AlarmRuntimeError::InvalidDefinition) => AlarmStopReason::InvalidDefinition,
        Err(
            AlarmRuntimeError::Step(_) | AlarmRuntimeError::Closed | AlarmRuntimeError::Internal,
        ) => AlarmStopReason::InternalError,
    };
    guard.0.send_replace(AlarmRuntimeStatus::Stopped { reason });
    result
}

async fn run_inner(
    mut evaluator: AlarmEvaluator,
    mut sdk: TagClientHandle,
    mut control_rx: mpsc::Receiver<Control>,
    change_tx: broadcast::Sender<AlarmChange>,
    mut tags: BTreeSet<String>,
    mut freshness: Freshness,
) -> Result<(), AlarmRuntimeError> {
    let mut states = sdk.state_watch();
    let mut previous = Fed::default();
    let mut was_evaluable = false;
    let mut accepted_generation = None;
    let mut awaiting_replacement_snapshot = false;
    let mut replacement_deadline = None;
    // A resubscription stopped; its watch has nothing more to say until the
    // next resubscription replaces it.
    let mut subscription_dead = false;
    let mut history_retry: Option<tokio::time::Instant> = None;
    // Process the current snapshot before waiting so a rapid initial Live is not lost.
    let initial = states.borrow_and_update().clone();
    if initial.connection_state() == TagClientConnectionState::Stopped
        && initial.last_error().is_some()
    {
        let _ = stop(evaluator, sdk, &change_tx).await;
        return Err(AlarmRuntimeError::Sdk(initial.last_error().unwrap()));
    }
    if let Err(error) = process_state(
        &mut evaluator,
        &initial,
        &tags,
        &mut previous,
        &mut was_evaluable,
        &mut accepted_generation,
        &mut freshness,
        &change_tx,
    )
    .await
    {
        let _ = stop(evaluator, sdk, &change_tx).await;
        return Err(error);
    }
    // Every arm that can fail stops the session the same way.
    macro_rules! check {
        ($result:expr) => {
            if let Err(error) = $result {
                let _ = stop(evaluator, sdk, &change_tx).await;
                return Err(error);
            }
        };
    }
    macro_rules! process_current {
        () => {{
            let current = states.borrow_and_update().clone();
            let stopped = current.connection_state() == TagClientConnectionState::Stopped;
            if subscription_dead || (stopped && freshness.resubscription_pending()) {
                // A stopped resubscription is one failure, retried later
                // (design §4.5); the session goes on.
                if !subscription_dead {
                    awaiting_replacement_snapshot = false;
                    replacement_deadline = None;
                    freshness.resubscription_stopped(tokio::time::Instant::now());
                    subscription_dead = true;
                    previous.clear();
                    was_evaluable = false;
                }
                let synced =
                    sync_availability(&mut evaluator, &freshness, &mut previous, &change_tx).await;
                check!(synced.map(|_| ()));
            } else if stopped {
                let _ = stop(evaluator, sdk, &change_tx).await;
                return Err(current
                    .last_error()
                    .map_or(AlarmRuntimeError::Closed, AlarmRuntimeError::Sdk));
            } else {
                check!(
                    process_state(
                        &mut evaluator,
                        &current,
                        &tags,
                        &mut previous,
                        &mut was_evaluable,
                        &mut accepted_generation,
                        &mut freshness,
                        &change_tx,
                    )
                    .await
                );
            }
        }};
    }
    // Resubscribe after a suspected stall (design §4.5). The old subscription
    // stays when no new one can be made; that counts as a failure.
    macro_rules! resubscribe {
        () => {{
            let started = freshness
                .clients
                .make()
                .and_then(|client| client.start(requests(&tags)).ok());
            match started {
                Some(replacement) => {
                    replace_sdk(&mut sdk, &mut states, replacement);
                    subscription_dead = false;
                    freshness.replaced();
                    freshness.resubscribe_started();
                    previous.clear();
                    was_evaluable = false;
                    accepted_generation = None;
                    awaiting_replacement_snapshot = true;
                    replacement_deadline =
                        Some(tokio::time::Instant::now() + Duration::from_secs(2));
                }
                None => {
                    freshness.resubscribe_failed(tokio::time::Instant::now());
                    let synced =
                        sync_availability(&mut evaluator, &freshness, &mut previous, &change_tx)
                            .await;
                    check!(synced.map(|_| ()));
                }
            }
        }};
    }
    loop {
        if evaluator.history_failure().is_none() {
            history_retry = None;
        } else if history_retry.is_none() {
            history_retry = Some(tokio::time::Instant::now() + HISTORY_RETRY);
        }
        let due = evaluator.engine.next_due_ms();
        let deadline = due.map(|ms| evaluator.origin + std::time::Duration::from_millis(ms));
        let next_reread = freshness.next_reread;
        let next_resubscribe = freshness.next_resubscribe;
        tokio::select! {
            state = states.changed(), if !subscription_dead => {
                if state.is_err() {
                    let _ = stop(evaluator, sdk, &change_tx).await;
                    return Err(AlarmRuntimeError::Closed);
                }
                let connection = states.borrow().connection_state();
                if awaiting_replacement_snapshot && !replacement_settled(connection) {
                    continue;
                }
                if awaiting_replacement_snapshot && connection != TagClientConnectionState::Stopped {
                    // A fresh subscription reached Live/Unbound.
                    freshness.resubscribe_succeeded();
                }
                awaiting_replacement_snapshot = false;
                replacement_deadline = None;
                process_current!();
            }
            _ = async { if let Some(deadline) = deadline { tokio::time::sleep_until(deadline.into()).await } else { std::future::pending::<()>().await } } => {
                check!(publish(&mut evaluator, Input::TimerExpired, &change_tx).await);
            }
            _ = async { if let Some(deadline) = history_retry { tokio::time::sleep_until(deadline).await } else { std::future::pending::<()>().await } } => {
                history_retry = None;
                check!(evaluator.recover_history().await.map(|_| ()));
            }
            _ = async { if let Some(deadline) = replacement_deadline { tokio::time::sleep_until(deadline).await } else { std::future::pending::<()>().await } } => {
                awaiting_replacement_snapshot = false;
                replacement_deadline = None;
                if freshness.resubscribing {
                    freshness.resubscribe_timed_out(tokio::time::Instant::now());
                }
                process_current!();
            }
            _ = tokio::time::sleep_until(next_reread) => {
                if freshness.start_reread(&tags, tokio::time::Instant::now(), wall_ms()) {
                    let synced = sync_availability(&mut evaluator, &freshness, &mut previous, &change_tx).await;
                    check!(synced.map(|_| ()));
                }
            }
            result = async {
                match freshness.ticket.as_mut() {
                    Some(ticket) => (&mut ticket.rx).await.unwrap_or(Err(())),
                    None => std::future::pending::<RereadResult>().await,
                }
            } => {
                let ticket = freshness.ticket.take().expect("a reread in flight");
                // A subscription change not processed yet also arrived meanwhile.
                let pending = states.has_changed().unwrap_or(true);
                let current = states.borrow().clone();
                let outcome = reread_done(
                    &mut evaluator,
                    &mut freshness,
                    RereadContext { ticket, result, state: &current, pending, tags: &tags },
                    &mut previous,
                    &change_tx,
                )
                .await;
                match outcome {
                    Ok(RereadOutcome::Recovered) => process_current!(),
                    Ok(RereadOutcome::Stalled) => resubscribe!(),
                    Ok(RereadOutcome::Settled) => {}
                    Err(error) => check!(Err::<(), _>(error)),
                }
            }
            _ = async { if let Some(deadline) = next_resubscribe { tokio::time::sleep_until(deadline).await } else { std::future::pending::<()>().await } } => {
                freshness.next_resubscribe = None;
                resubscribe!();
            }
            control = control_rx.recv() => match control {
                Some(Control::Snapshot(reply)) => { let _ = reply.send(evaluator.engine.clone()); }
                Some(Control::Apply(command)) => {
                    let ApplyCommand { applied, definitions, confirmed, clients, reply } = *command;
                    if evaluator.history_failure().is_some() {
                        let _ = reply.send(Err(AlarmRuntimeError::HistoryUnwritable));
                        continue;
                    }
                    if let Err(error) = publish(&mut evaluator, Input::TimerExpired, &change_tx).await {
                        let _ = reply.send(Err(error_summary(&error)));
                        let _ = stop(evaluator, sdk, &change_tx).await;
                        return Err(error);
                    }
                    let next_tags: BTreeSet<_> = definitions.values().map(|definition| definition.spec.source.tag().to_owned()).collect();
                    let replacement = if next_tags != tags {
                        let started = match clients.make() {
                            Some(client) => client.start(requests(&next_tags)).map_err(|error| error.kind()),
                            None => Err(ErrorKind::Transport),
                        };
                        match started {
                            Ok(handle) => Some(handle),
                            Err(kind) => {
                                let _ = reply.send(Err(AlarmRuntimeError::Sdk(kind)));
                                continue;
                            }
                        }
                    } else { None };
                    match evaluator.apply(applied, &definitions, &confirmed).await {
                        Ok(change) => {
                            // Rereads and resubscription use the refreshed credential.
                            freshness.set_clients(clients);
                            if let Some(replacement) = replacement {
                                replace_sdk(&mut sdk, &mut states, replacement);
                                subscription_dead = false;
                                freshness.replaced();
                                freshness.resubscribing = false;
                                tags = next_tags;
                                previous.clear();
                                was_evaluable = false;
                                accepted_generation = None;
                                awaiting_replacement_snapshot = true;
                                replacement_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(2));
                            } else {
                                previous.clear();
                            }
                            let _ = change_tx.send(change);
                            let _ = reply.send(Ok(()));
                            let connection = states.borrow().connection_state();
                            if !awaiting_replacement_snapshot || replacement_settled(connection) {
                                if awaiting_replacement_snapshot && connection != TagClientConnectionState::Stopped {
                                    freshness.resubscribe_succeeded();
                                }
                                awaiting_replacement_snapshot = false;
                                replacement_deadline = None;
                                process_current!();
                            }
                        }
                        Err(error) => {
                            if let Some(replacement) = replacement {
                                tokio::spawn(async move {
                                    let _ = tokio::time::timeout(
                                        Duration::from_secs(5),
                                        replacement.shutdown(),
                                    )
                                    .await;
                                });
                            }
                            let _ = reply.send(Err(error));
                        }
                    }
                }
                Some(Control::Ack { condition, occurrence, recurrence, user, reply }) => {
                    let result = evaluator.input_with_ack(Input::Ack { condition, occurrence, recurrence, user }).await;
                    match result {
                        Ok((change, ack)) => {
                            let _ = reply.send(ack.ok_or(AlarmRuntimeError::Internal));
                            if let Some(change) = change { let _ = change_tx.send(change); }
                        }
                        Err(AlarmRuntimeError::Step(error)) => {
                            let _ = reply.send(Err(AlarmRuntimeError::Step(error)));
                        }
                        Err(AlarmRuntimeError::HistoryUnwritable) => {
                            let _ = reply.send(Err(AlarmRuntimeError::HistoryUnwritable));
                        }
                        Err(error) => {
                            let _ = reply.send(Err(error_summary(&error)));
                            let _ = stop(evaluator, sdk, &change_tx).await;
                            return Err(error);
                        }
                    }
                }
                Some(Control::Stop(reply)) => {
                    let result = stop(evaluator, sdk, &change_tx).await;
                    return match result {
                        Ok(()) => { let _ = reply.send(Ok(())); Ok(()) }
                        Err(error) => { let _ = reply.send(Err(error_summary(&error))); Err(error) }
                    };
                }
                None => return stop(evaluator, sdk, &change_tx).await,
            }
        }
    }
}

/// A replacement subscription has a settled first state to process: Live or
/// Unbound, or a terminal state that ends the session.
fn replacement_settled(connection: TagClientConnectionState) -> bool {
    matches!(
        connection,
        TagClientConnectionState::Stopped
            | TagClientConnectionState::Live
            | TagClientConnectionState::Unbound
            | TagClientConnectionState::Unauthorized
    )
}

/// What was fed to the Engine per tag. `subscription` is the subscription's
/// last sample (to find its new arrivals); `evaluated` is the last value the
/// Engine received from either the subscription or a reread.
#[derive(Default)]
struct Fed {
    subscription: BTreeMap<String, Sample>,
    evaluated: BTreeMap<String, Sample>,
}

impl Fed {
    fn clear(&mut self) {
        self.subscription.clear();
        self.evaluated.clear();
    }
}

enum RereadOutcome {
    /// Nothing more to do in the loop.
    Settled,
    /// ReceiveLost ended; evaluate again from the subscription's values.
    Recovered,
    /// The subscription looks stalled; the read value was used.
    Stalled,
}

struct RereadContext<'a> {
    ticket: freshness::Ticket,
    result: RereadResult,
    state: &'a TagClientState,
    /// A subscription change is waiting in the watch, not processed yet.
    pending: bool,
    tags: &'a BTreeSet<String>,
}

/// Account for one reread and, when the subscription delivered nothing for
/// a tag meanwhile, use a differing read value (design §4.5).
async fn reread_done(
    evaluator: &mut AlarmEvaluator,
    freshness: &mut Freshness,
    context: RereadContext<'_>,
    previous: &mut Fed,
    changes: &broadcast::Sender<AlarmChange>,
) -> Result<RereadOutcome, AlarmRuntimeError> {
    // A response for a subscription that is gone or no longer Live (even
    // a change not processed yet) says nothing about the current one: it
    // neither counts as a failure nor ends ReceiveLost.
    if context.ticket.epoch != freshness.epoch
        || context.state.connection_state() != TagClientConnectionState::Live
    {
        return Ok(RereadOutcome::Settled);
    }
    let values = match context.result {
        Ok(values) => values,
        Err(()) => {
            if freshness.failure(tokio::time::Instant::now(), wall_ms()) {
                sync_availability(evaluator, freshness, previous, changes).await?;
            }
            return Ok(RereadOutcome::Settled);
        }
    };
    if freshness.success() && sync_availability(evaluator, freshness, previous, changes).await? {
        return Ok(RereadOutcome::Recovered);
    }
    // Only liveness when the connection changed or the Engine is not
    // evaluating; the order is arrival order, never source timestamps.
    if context.pending || evaluator.engine.unavailable().is_some() {
        return Ok(RereadOutcome::Settled);
    }
    let Some(snapshot) = context.state.snapshot() else {
        return Ok(RereadOutcome::Settled);
    };
    // Rows from another catalog revision or run would be converted with the
    // wrong data types; the subscription rebinds to that generation itself.
    let catalog = &snapshot.catalog;
    if values.revision != catalog.revision
        || values.run_id != catalog.run_id
        || values.collection_mode != catalog.collection_mode
    {
        return Ok(RereadOutcome::Settled);
    }
    let rows: BTreeMap<&str, &ValueEntry> = values
        .values
        .iter()
        .map(|row| (row.tag.as_str(), row))
        .collect();
    let mut stalled = false;
    for tag in context.tags {
        let sent = context.ticket.arrivals.get(tag).copied().unwrap_or(0);
        if sent != freshness.arrival_count(tag) {
            continue;
        }
        let Some(BindingView::Resolved { tag: catalog, .. }) = snapshot.binding(tag) else {
            continue;
        };
        let (Some(row), Some(accepted)) = (rows.get(tag.as_str()), previous.evaluated.get(tag))
        else {
            continue;
        };
        let Some(read) = sample_from(catalog, Some(row)) else {
            continue;
        };
        if !differs(accepted, &read) {
            continue;
        }
        publish(
            evaluator,
            Input::Value {
                tag: tag.clone(),
                sample: read.clone(),
            },
            changes,
        )
        .await?;
        // The subscription's own last sample stays as it was, so a later
        // snapshot of an unrelated tag does not undo this correction.
        previous.evaluated.insert(tag.clone(), read);
        stalled = true;
    }
    Ok(if stalled {
        RereadOutcome::Stalled
    } else {
        RereadOutcome::Settled
    })
}

/// Bring the Engine-wide reason in line with the freshness state. Returns
/// `true` when the Engine became evaluable again: conditions wait for their
/// next value, so the caller feeds the current subscription values.
async fn sync_availability(
    evaluator: &mut AlarmEvaluator,
    freshness: &Freshness,
    previous: &mut Fed,
    changes: &broadcast::Sender<AlarmChange>,
) -> Result<bool, AlarmRuntimeError> {
    let desired = freshness.desired();
    if evaluator.engine.unavailable() == desired {
        return Ok(false);
    }
    publish(
        evaluator,
        Input::EngineAvailability {
            unavailable: desired,
        },
        changes,
    )
    .await?;
    previous.clear();
    Ok(desired.is_none())
}

fn error_summary(error: &AlarmRuntimeError) -> AlarmRuntimeError {
    match error {
        AlarmRuntimeError::Db(_) | AlarmRuntimeError::StorageFailure => {
            AlarmRuntimeError::StorageFailure
        }
        AlarmRuntimeError::Sdk(_) | AlarmRuntimeError::ConnectionFailure => {
            AlarmRuntimeError::ConnectionFailure
        }
        AlarmRuntimeError::InvalidDefinition => AlarmRuntimeError::InvalidDefinition,
        AlarmRuntimeError::HistoryUnwritable => AlarmRuntimeError::HistoryUnwritable,
        AlarmRuntimeError::Internal => AlarmRuntimeError::Internal,
        _ => AlarmRuntimeError::Closed,
    }
}

async fn stop(
    mut evaluator: AlarmEvaluator,
    sdk: TagClientHandle,
    changes: &broadcast::Sender<AlarmChange>,
) -> Result<(), AlarmRuntimeError> {
    // A stop is also a boundary: commit every already-expired wait first.
    let settled = publish(&mut evaluator, Input::TimerExpired, changes).await;
    // Close an outage first so the stop record follows the unrecorded period
    // and the rewritten last states. If it still fails, leave the session
    // unstopped: the next start records the unknown period from the DB.
    let recovered = match &settled {
        Ok(()) => evaluator.recover_history().await,
        Err(_) => Ok(evaluator.history_failure().is_none()),
    };
    let stopped = match recovered {
        Ok(true) => evaluator
            .db
            .stop_session(evaluator.engine.session(), wall_ms())
            .await
            .map_err(AlarmRuntimeError::Db),
        Ok(false) => Err(AlarmRuntimeError::HistoryUnwritable),
        Err(error) => Err(error),
    };
    match tokio::time::timeout(Duration::from_secs(5), sdk.shutdown()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("alarm SDK shutdown failed: {error:?}"),
        Err(_) => eprintln!("alarm SDK shutdown timed out after 5 seconds"),
    }
    stopped?;
    settled?;
    Ok(())
}

async fn publish(
    evaluator: &mut AlarmEvaluator,
    input: Input,
    changes: &broadcast::Sender<AlarmChange>,
) -> Result<(), AlarmRuntimeError> {
    if let Some(change) = evaluator.input(input).await? {
        let _ = changes.send(change);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn process_state(
    evaluator: &mut AlarmEvaluator,
    state: &TagClientState,
    tags: &BTreeSet<String>,
    previous: &mut Fed,
    was_evaluable: &mut bool,
    accepted_generation: &mut Option<u64>,
    freshness: &mut Freshness,
    changes: &broadcast::Sender<AlarmChange>,
) -> Result<(), AlarmRuntimeError> {
    match state.connection_state() {
        TagClientConnectionState::Unauthorized => {
            return Err(AlarmRuntimeError::Sdk(ErrorKind::Unauthorized))
        }
        connection @ (TagClientConnectionState::Live | TagClientConnectionState::Unbound) => {
            let snapshot = state.snapshot().ok_or(AlarmRuntimeError::Internal)?;
            begin_generation(
                evaluator,
                snapshot.generation,
                connection == TagClientConnectionState::Live,
                previous,
                was_evaluable,
                accepted_generation,
                freshness,
                changes,
            )
            .await?;
            if evaluator.engine.unavailable().is_some() {
                // The Engine drops values while unavailable; feed them again
                // once it is evaluable.
                previous.clear();
                return Ok(());
            }
            for tag in tags {
                let Some(sample) = sample(snapshot, tag) else {
                    // A resolved binding without its first value remains InitialValue.
                    continue;
                };
                if previous.subscription.get(tag) != Some(&sample) {
                    publish(
                        evaluator,
                        Input::Value {
                            tag: tag.clone(),
                            sample: sample.clone(),
                        },
                        changes,
                    )
                    .await?;
                    freshness.arrived(tag);
                    previous.subscription.insert(tag.clone(), sample.clone());
                    previous.evaluated.insert(tag.clone(), sample);
                }
            }
        }
        _ => {
            freshness.disconnected();
            sync_availability(evaluator, freshness, previous, changes).await?;
            previous.clear();
            *was_evaluable = false;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn begin_generation(
    evaluator: &mut AlarmEvaluator,
    generation: u64,
    live: bool,
    previous: &mut Fed,
    was_evaluable: &mut bool,
    accepted_generation: &mut Option<u64>,
    freshness: &mut Freshness,
    changes: &broadcast::Sender<AlarmChange>,
) -> Result<(), AlarmRuntimeError> {
    let generation_changed = accepted_generation.is_some_and(|old| old != generation);
    // The SDK watch is latest-only. A reconnect can pass through a non-Live
    // state while a DB write awaits; a new generation still discards waits.
    if generation_changed && evaluator.engine.unavailable().is_none() {
        publish(
            evaluator,
            Input::EngineAvailability {
                unavailable: Some(EngineUnavailable::Disconnected),
            },
            changes,
        )
        .await?;
    }
    freshness.connected(live, generation_changed || !*was_evaluable);
    sync_availability(evaluator, freshness, previous, changes).await?;
    if !*was_evaluable || generation_changed {
        previous.clear();
    }
    *was_evaluable = true;
    *accepted_generation = Some(generation);
    Ok(())
}

fn sample(snapshot: &GenerationSnapshot, tag: &str) -> Option<Sample> {
    let Some(BindingView::Resolved {
        tag: catalog,
        value,
        ..
    }) = snapshot.binding(tag)
    else {
        return Some(invalid_sample());
    };
    sample_from(catalog, value)
}

fn invalid_sample() -> Sample {
    Sample {
        resolved: false,
        quality: Quality::Bad,
        value: None,
        source_timestamp_ms: None,
    }
}

/// Convert one value row of a resolved catalog tag. The subscription and
/// the REST reread share this conversion.
fn sample_from(catalog: &CatalogTag, value: Option<&ValueEntry>) -> Option<Sample> {
    if !catalog.enabled {
        return Some(invalid_sample());
    }
    // No value row means initial value waiting, not an unresolved catalog tag.
    let value = value?;
    let quality = match &value.q {
        ValueQuality::Good => Quality::Good,
        ValueQuality::Stale => Quality::Stale,
        _ => Quality::Bad,
    };
    let source_timestamp_ms = value.t;
    let converted = value.v.map(|number| {
        if catalog.data_type == "bit" && (number == 0.0 || number == 1.0) {
            TagValue::Bool(number == 1.0)
        } else if catalog.data_type == "bit" {
            TagValue::Text(number.to_string())
        } else if matches!(
            catalog.data_type.as_str(),
            "i16" | "u16" | "i32" | "u32" | "i64" | "u64" | "f32" | "f64"
        ) {
            TagValue::Number(number)
        } else {
            TagValue::Text(number.to_string())
        }
    });
    Some(Sample {
        resolved: true,
        quality,
        value: converted,
        source_timestamp_ms: Some(source_timestamp_ms),
    })
}

#[cfg(test)]
mod freshness_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alarm_db::{plan_restore, ConditionDisplay};
    use crate::alarm_terminal::AlarmTerminal;
    use crate::recording_runtime::setup_tests::Hub;
    use scada_alarm::{AckMode, ConditionSpec, Session};
    use std::sync::atomic::Ordering;

    #[tokio::test]
    async fn resolved_binding_without_first_value_stays_initial_value_waiting() {
        let hub = Hub::new(&[("PLANT.FLAG", "bit")]).await;
        let sdk = hub
            .client()
            .start(vec![BindingRequest {
                binding_key: "PLANT.FLAG".into(),
                external_name: "PLANT.FLAG".into(),
            }])
            .unwrap();
        let mut states = sdk.state_watch();
        let mut snapshot = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let state = states.borrow().clone();
                if state.connection_state() == TagClientConnectionState::Live {
                    break state.snapshot().unwrap().as_ref().clone();
                }
                states.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert!(sample(&snapshot, "PLANT.FLAG").is_some());
        snapshot.values = None;
        assert!(matches!(
            snapshot.binding("PLANT.FLAG"),
            Some(BindingView::Resolved { value: None, .. })
        ));
        assert!(sample(&snapshot, "PLANT.FLAG").is_none());
        sdk.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn task_panic_publishes_internal_error_instead_of_staying_running() {
        let (status_tx, mut status) = watch::channel(AlarmRuntimeStatus::Running);
        let task = tokio::spawn(run_with_status(
            async { panic!("test-only alarm task panic") },
            status_tx,
        ));
        assert!(task.await.unwrap_err().is_panic());
        status.changed().await.unwrap();
        assert_eq!(
            *status.borrow(),
            AlarmRuntimeStatus::Stopped {
                reason: AlarmStopReason::InternalError
            }
        );
    }

    #[tokio::test]
    async fn dropped_engine_owner_releases_claim_for_crash_recovery() {
        let dir = std::env::temp_dir().join(format!("alarm-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let terminal = Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        let project_id = uuid::Uuid::new_v4().to_string();
        let db = Arc::new(AlarmDb::open(terminal.clone(), &project_id).await.unwrap());
        let applied = AppliedDefinitions {
            project_id: project_id.clone(),
            project_revision: 1,
            file_hash: "saved".into(),
            endpoint: "http://127.0.0.1:8722".into(),
            applied_by: "未ログイン".into(),
            applied_at_ms: 1,
            definitions: serde_json::json!({"definitions": []}),
            condition_hashes: BTreeMap::new(),
            disabled_condition_ids: BTreeSet::new(),
            displays: BTreeMap::new(),
        };
        db.apply(&applied, None, &[], &[]).await.unwrap();
        let session = Session {
            id: "running".into(),
            generation: terminal.reserve_generation().unwrap(),
        };
        let plan = plan_restore(
            session.clone(),
            &applied.endpoint,
            1,
            &applied,
            &BTreeMap::new(),
            &BTreeSet::new(),
            &[],
        )
        .unwrap();
        let engine = db.start_session_plan(plan, 1).await.unwrap();
        let evaluator = AlarmEvaluator::new(db.clone(), applied, engine)
            .await
            .unwrap();
        assert!(terminal.active_project(&project_id).unwrap());
        drop(evaluator); // The SDK/Engine owner is gone before a DB stop succeeded.
        assert!(!terminal.active_project(&project_id).unwrap());
        db.close_unstopped_session(2).await.unwrap();
        assert!(db.session().await.unwrap().unwrap().stopped);
        let db = Arc::try_unwrap(db).ok().unwrap();
        db.close().await;
        drop(terminal);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn evaluator_rejects_an_endpoint_not_in_the_applied_db_row() {
        let dir = std::env::temp_dir().join(format!("alarm-endpoint-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let terminal = Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        let project_id = uuid::Uuid::new_v4().to_string();
        let db = Arc::new(AlarmDb::open(terminal.clone(), &project_id).await.unwrap());
        let applied = AppliedDefinitions {
            project_id: project_id.clone(),
            project_revision: 1,
            file_hash: "saved".into(),
            endpoint: "http://127.0.0.1:8722".into(),
            applied_by: "未ログイン".into(),
            applied_at_ms: 1,
            definitions: serde_json::json!({"definitions": []}),
            condition_hashes: BTreeMap::new(),
            disabled_condition_ids: BTreeSet::new(),
            displays: BTreeMap::new(),
        };
        db.apply(&applied, None, &[], &[]).await.unwrap();
        let session = Session {
            id: "running".into(),
            generation: terminal.reserve_generation().unwrap(),
        };
        let plan = plan_restore(
            session,
            &applied.endpoint,
            1,
            &applied,
            &BTreeMap::new(),
            &BTreeSet::new(),
            &[],
        )
        .unwrap();
        let engine = db.start_session_plan(plan, 1).await.unwrap();
        let mut wrong = applied;
        wrong.endpoint = "http://127.0.0.1:9999".into();
        assert!(matches!(
            AlarmEvaluator::new(db.clone(), wrong, engine).await,
            Err(AlarmRuntimeError::InvalidDefinition)
        ));
        assert!(db.session().await.unwrap().unwrap().stopped);
        assert!(!terminal.active_project(&project_id).unwrap());
        let db = Arc::try_unwrap(db).ok().unwrap();
        db.close().await;
        drop(terminal);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn value_timer_and_ack_are_written_before_engine_commit() {
        let dir = std::env::temp_dir().join(format!("alarm-evaluator-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let terminal = Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        let project_id = uuid::Uuid::new_v4().to_string();
        let db = Arc::new(AlarmDb::open(terminal.clone(), &project_id).await.unwrap());
        let spec = ConditionSpec {
            source: scada_alarm::Source::Bit {
                tag: "PLANT.FLAG".into(),
                active_when: true,
            },
            on_delay_ms: 50,
            off_delay_ms: 0,
            ack_mode: AckMode::Manual,
        };
        let id = "alarm:bit".to_owned();
        let definition = Definition { spec };
        let applied = AppliedDefinitions {
            project_id: project_id.clone(),
            project_revision: 1,
            file_hash: "saved-file".into(),
            endpoint: "http://127.0.0.1:8722".into(),
            applied_by: "未ログイン".into(),
            applied_at_ms: 1,
            definitions: serde_json::json!({"definitions": []}),
            condition_hashes: BTreeMap::from([(id.clone(), definition.evaluation_hash())]),
            disabled_condition_ids: BTreeSet::new(),
            displays: BTreeMap::from([(
                id.clone(),
                ConditionDisplay {
                    name: "Flag".into(),
                    message: "発生".into(),
                    severity: "high".into(),
                    limit_label: None,
                },
            )]),
        };
        db.apply(&applied, None, &[], &[]).await.unwrap();
        let session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            generation: terminal.reserve_generation().unwrap(),
        };
        let plan = plan_restore(
            session.clone(),
            &applied.endpoint,
            1,
            &applied,
            &BTreeMap::from([(id.clone(), definition)]),
            &BTreeSet::new(),
            &[],
        )
        .unwrap();
        let engine = db.start_session_plan(plan, 1).await.unwrap();
        let mut evaluator = AlarmEvaluator::new(db.clone(), applied, engine)
            .await
            .unwrap();
        let value = Input::Value {
            tag: "PLANT.FLAG".into(),
            sample: Sample {
                resolved: true,
                quality: Quality::Good,
                value: Some(TagValue::Bool(true)),
                source_timestamp_ms: Some(9),
            },
        };
        evaluator.input(value).await.unwrap();
        assert!(evaluator.engine().next_due_ms().is_some());
        evaluator.origin = Instant::now() - std::time::Duration::from_millis(100);
        let change = evaluator.input(Input::TimerExpired).await.unwrap().unwrap();
        assert_eq!(change.events.len(), 1);
        assert!(change.events[0].at_wall_ms <= wall_ms());
        let occurrence = evaluator
            .engine()
            .condition(&id)
            .unwrap()
            .state
            .occurrence
            .clone()
            .unwrap();
        assert_eq!(
            db.events()
                .await
                .unwrap()
                .iter()
                .filter(|event| event.event.kind == "occurred")
                .count(),
            1
        );
        let (change, ack) = evaluator
            .input_with_ack(Input::Ack {
                condition: id.clone(),
                occurrence,
                recurrence: 0,
                user: "operator".into(),
            })
            .await
            .unwrap();
        assert_eq!(ack, Some(AckOutcome::Accepted));
        assert!(change.is_some());
        assert!(db.last_states().await.unwrap()[0].state.acked);
        for active in [false, true] {
            evaluator
                .input(Input::Value {
                    tag: "PLANT.FLAG".into(),
                    sample: Sample {
                        resolved: true,
                        quality: Quality::Good,
                        value: Some(TagValue::Bool(active)),
                        source_timestamp_ms: Some(10),
                    },
                })
                .await
                .unwrap();
        }
        assert!(evaluator.engine().next_due_ms().is_some());
        let (changes, _) = broadcast::channel(4);
        let mut previous = Fed {
            subscription: BTreeMap::from([(
                "PLANT.FLAG".into(),
                Sample {
                    resolved: true,
                    quality: Quality::Good,
                    value: Some(TagValue::Bool(true)),
                    source_timestamp_ms: Some(10),
                },
            )]),
            evaluated: BTreeMap::new(),
        };
        let mut was_evaluable = true;
        let mut generation = Some(1);
        let (report, _) = watch::channel(None);
        let mut freshness =
            Freshness::new(FreshnessConfig::default(), HubClients::new(|| None), report);
        begin_generation(
            &mut evaluator,
            2,
            true,
            &mut previous,
            &mut was_evaluable,
            &mut generation,
            &mut freshness,
            &changes,
        )
        .await
        .unwrap();
        assert_eq!(generation, Some(2));
        assert!(previous.subscription.is_empty() && previous.evaluated.is_empty());
        assert!(evaluator.engine().next_due_ms().is_none());
        db.stop_session(&session, wall_ms()).await.unwrap();
        let before = evaluator.engine().clone();
        assert!(matches!(
            evaluator.input(Input::TimerExpired).await,
            Ok(None)
        ));
        assert!(matches!(
            evaluator
                .input(Input::Value {
                    tag: "PLANT.FLAG".into(),
                    sample: Sample {
                        resolved: true,
                        quality: Quality::Bad,
                        value: None,
                        source_timestamp_ms: None
                    }
                })
                .await,
            Err(AlarmRuntimeError::Db(_))
        ));
        assert_eq!(evaluator.engine(), &before);
        let hub = Hub::new(&[("PLANT.FLAG", "bit")]).await;
        let sdk = hub
            .client()
            .start(vec![BindingRequest {
                binding_key: "PLANT.FLAG".into(),
                external_name: "PLANT.FLAG".into(),
            }])
            .unwrap();
        let (control, control_rx) = mpsc::channel(1);
        drop(control);
        let (changes, _) = broadcast::channel(1);
        let (status_tx, mut status) = watch::channel(AlarmRuntimeStatus::Running);
        let task = tokio::spawn(run(
            evaluator,
            sdk,
            control_rx,
            changes,
            BTreeSet::from(["PLANT.FLAG".into()]),
            Freshness::new(
                FreshnessConfig::default(),
                HubClients::new(|| None),
                watch::channel(None).0,
            ),
            status_tx,
        ));
        tokio::time::timeout(Duration::from_secs(3), status.changed())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            *status.borrow(),
            AlarmRuntimeStatus::Stopped {
                reason: AlarmStopReason::StorageFailure
            }
        );
        assert!(matches!(task.await.unwrap(), Err(AlarmRuntimeError::Db(_))));
        assert!(!terminal.active_project(&project_id).unwrap());
        let db = Arc::try_unwrap(db).ok().unwrap();
        db.close().await;
        drop(terminal);
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn flag(active: bool) -> Input {
        Input::Value {
            tag: "PLANT.FLAG".into(),
            sample: Sample {
                resolved: true,
                quality: Quality::Good,
                value: Some(TagValue::Bool(active)),
                source_timestamp_ms: Some(1),
            },
        }
    }

    // The alarm DB pool has one connection, so this makes every write fail
    // with SQLITE_READONLY, a storage outage that can clear.
    const FAIL_WRITES: &str = "PRAGMA query_only = 1;";
    const HEAL_WRITES: &str = "PRAGMA query_only = 0;";

    /// One bit condition applied and started in a fresh alarm DB.
    pub(super) async fn outage_fixture(
        prefix: &str,
    ) -> (
        std::path::PathBuf,
        Arc<AlarmTerminal>,
        Arc<AlarmDb>,
        AppliedDefinitions,
        BTreeMap<String, Definition>,
        Session,
        AlarmEvaluator,
    ) {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let terminal = Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        let project_id = uuid::Uuid::new_v4().to_string();
        let db = Arc::new(AlarmDb::open(terminal.clone(), &project_id).await.unwrap());
        let id = "alarm:bit".to_owned();
        let definition = Definition {
            spec: ConditionSpec {
                source: scada_alarm::Source::Bit {
                    tag: "PLANT.FLAG".into(),
                    active_when: true,
                },
                on_delay_ms: 0,
                off_delay_ms: 0,
                ack_mode: AckMode::Manual,
            },
        };
        let applied = AppliedDefinitions {
            project_id: project_id.clone(),
            project_revision: 1,
            file_hash: "saved-file".into(),
            endpoint: "http://127.0.0.1:8722".into(),
            applied_by: "未ログイン".into(),
            applied_at_ms: 1,
            definitions: serde_json::json!({"definitions": []}),
            condition_hashes: BTreeMap::from([(id.clone(), definition.evaluation_hash())]),
            disabled_condition_ids: BTreeSet::new(),
            displays: BTreeMap::from([(
                id.clone(),
                ConditionDisplay {
                    name: "Flag".into(),
                    message: "発生".into(),
                    severity: "high".into(),
                    limit_label: None,
                },
            )]),
        };
        db.apply(&applied, None, &[], &[]).await.unwrap();
        let session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            generation: terminal.reserve_generation().unwrap(),
        };
        let definitions = BTreeMap::from([(id, definition)]);
        let plan = plan_restore(
            session.clone(),
            &applied.endpoint,
            1,
            &applied,
            &definitions,
            &BTreeSet::new(),
            &[],
        )
        .unwrap();
        let engine = db.start_session_plan(plan, 1).await.unwrap();
        let evaluator = AlarmEvaluator::new(db.clone(), applied.clone(), engine)
            .await
            .unwrap();
        (dir, terminal, db, applied, definitions, session, evaluator)
    }

    fn ack_current(evaluator: &AlarmEvaluator, id: &str) -> Input {
        let state = &evaluator.engine().condition(id).unwrap().state;
        Input::Ack {
            condition: id.into(),
            occurrence: state.occurrence.clone().unwrap(),
            recurrence: state.recurrence,
            user: "operator".into(),
        }
    }

    #[tokio::test]
    async fn history_outage_keeps_evaluating_and_records_the_unrecorded_period() {
        let (dir, terminal, db, applied, definitions, session, mut evaluator) =
            outage_fixture("alarm-outage").await;
        let id = "alarm:bit";
        evaluator.input(flag(true)).await.unwrap();
        evaluator.input(flag(false)).await.unwrap();
        let saved = db.last_states().await.unwrap().remove(0);
        assert!(saved.last_event_seq.is_some());
        db.execute_for_test(FAIL_WRITES).await;

        // The recurrence is evaluated and published although it is not written.
        let change = evaluator.input(flag(true)).await.unwrap().unwrap();
        assert_eq!(change.events.len(), 1);
        let failure = evaluator.history_failure().unwrap();
        assert_eq!(failure.unrecorded_events, 1);
        assert_eq!(db.last_states().await.unwrap()[0], saved);
        // Return then recur: counted, not queued.
        evaluator.input(flag(false)).await.unwrap();
        evaluator.input(flag(true)).await.unwrap();
        let counted = evaluator.history_failure().unwrap();
        assert_eq!(counted.since_wall_ms, failure.since_wall_ms);
        assert_eq!(counted.unrecorded_events, 3);

        // ACK and apply are refused while the history cannot be written.
        let before = evaluator.engine().clone();
        let ack = ack_current(&evaluator, id);
        assert!(matches!(
            evaluator.input_with_ack(ack.clone()).await,
            Err(AlarmRuntimeError::HistoryUnwritable)
        ));
        assert_eq!(evaluator.engine(), &before);
        assert!(matches!(
            evaluator.apply(applied.clone(), &definitions, &[]).await,
            Err(AlarmRuntimeError::HistoryUnwritable)
        ));

        // A retry that still fails keeps the outage and its count.
        assert!(!evaluator.recover_history().await.unwrap());
        assert_eq!(evaluator.history_failure(), Some(counted));

        db.execute_for_test(HEAL_WRITES).await;
        assert!(evaluator.recover_history().await.unwrap());
        assert_eq!(evaluator.history_failure(), None);
        let events = db.events().await.unwrap();
        let period = events
            .iter()
            .find(|event| event.event.kind == "unrecordedPeriod")
            .unwrap();
        assert_eq!(period.event.detail["fromMs"], counted.since_wall_ms);
        assert_eq!(period.event.detail["unrecordedEvents"], 3);
        assert!(period.event.condition_id.is_none());
        let rows = db.last_states().await.unwrap();
        assert_eq!(rows.len(), 1);
        // The event behind the rewritten state was not written.
        assert_eq!(rows[0].last_event_seq, None);
        assert_eq!(
            rows[0].state,
            evaluator
                .engine()
                .condition(id)
                .unwrap()
                .state
                .to_last_state()
        );

        // After recovery an ACK is written before it is accepted.
        let (_, outcome) = evaluator.input_with_ack(ack).await.unwrap();
        assert_eq!(outcome, Some(AckOutcome::Accepted));
        assert!(db.last_states().await.unwrap()[0].state.acked);

        // A write failure on the ACK itself refuses it and starts an outage.
        evaluator.input(flag(false)).await.unwrap();
        evaluator.input(flag(true)).await.unwrap();
        let ack = ack_current(&evaluator, id);
        db.execute_for_test(FAIL_WRITES).await;
        let before = evaluator.engine().clone();
        assert!(matches!(
            evaluator.input_with_ack(ack).await,
            Err(AlarmRuntimeError::HistoryUnwritable)
        ));
        assert_eq!(evaluator.engine(), &before);
        assert_eq!(evaluator.history_failure().unwrap().unrecorded_events, 0);
        db.execute_for_test(HEAL_WRITES).await;
        assert!(evaluator.recover_history().await.unwrap());

        // A constraint violation is a logic error, not an outage.
        db.execute_for_test("CREATE TRIGGER reject_event BEFORE INSERT ON event BEGIN SELECT RAISE(ABORT, 'constraint'); END;").await;
        assert!(matches!(
            evaluator.input(flag(false)).await,
            Err(AlarmRuntimeError::Db(AlarmDbError::Sql(_)))
        ));
        assert_eq!(evaluator.history_failure(), None);
        db.execute_for_test("DROP TRIGGER reject_event;").await;

        // A lost session ownership is still fatal, not an outage.
        db.stop_session(&session, wall_ms()).await.unwrap();
        assert!(matches!(
            evaluator.input(flag(false)).await,
            Err(AlarmRuntimeError::Db(AlarmDbError::InvalidRow))
        ));
        assert_eq!(evaluator.history_failure(), None);
        drop(evaluator);
        let db = Arc::try_unwrap(db).ok().unwrap();
        db.close().await;
        drop(terminal);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn stop_during_an_outage_leaves_the_session_for_crash_recovery() {
        let (dir, terminal, db, _, _, session, mut evaluator) =
            outage_fixture("alarm-outage-stop").await;
        db.execute_for_test(FAIL_WRITES).await;
        evaluator.input(flag(true)).await.unwrap();
        assert!(evaluator.history_failure().is_some());
        let hub = Hub::new(&[("PLANT.FLAG", "bit")]).await;
        let sdk = hub
            .client()
            .start(vec![BindingRequest {
                binding_key: "PLANT.FLAG".into(),
                external_name: "PLANT.FLAG".into(),
            }])
            .unwrap();
        let (changes, _) = broadcast::channel(4);
        assert!(matches!(
            stop(evaluator, sdk, &changes).await,
            Err(AlarmRuntimeError::HistoryUnwritable)
        ));
        let record = db.session().await.unwrap().unwrap();
        assert!(!record.stopped);
        assert_eq!(record.session, session);
        db.execute_for_test(HEAL_WRITES).await;
        // The next start closes it with the crash evidence and unknown period.
        db.close_unstopped_session(wall_ms()).await.unwrap();
        assert!(db
            .events()
            .await
            .unwrap()
            .iter()
            .any(|event| event.event.kind == "unknownPeriod"));
        let db = Arc::try_unwrap(db).ok().unwrap();
        db.close().await;
        drop(terminal);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn dedicated_sdk_subscription_evaluates_and_stops_its_session() {
        let hub = Hub::new(&[("PLC01.Fast.Running", "bit"), ("PLC01.Fast.Added", "bit")]).await;
        let dir = std::env::temp_dir().join(format!("alarm-sdk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let terminal = Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        let project_id = uuid::Uuid::new_v4().to_string();
        let db = Arc::new(AlarmDb::open(terminal.clone(), &project_id).await.unwrap());
        let id = "alarm:running".to_owned();
        let definition = Definition {
            spec: ConditionSpec {
                source: scada_alarm::Source::Bit {
                    tag: "PLC01.Fast.Running".into(),
                    active_when: true,
                },
                on_delay_ms: 0,
                off_delay_ms: 0,
                ack_mode: AckMode::Manual,
            },
        };
        let applied = AppliedDefinitions {
            project_id,
            project_revision: 1,
            file_hash: "saved".into(),
            endpoint: hub.url.clone(),
            applied_by: "未ログイン".into(),
            applied_at_ms: 1,
            definitions: serde_json::json!({"definitions": []}),
            condition_hashes: BTreeMap::from([(id.clone(), definition.evaluation_hash())]),
            disabled_condition_ids: BTreeSet::new(),
            displays: BTreeMap::from([(
                id.clone(),
                ConditionDisplay {
                    name: "Running".into(),
                    message: "運転".into(),
                    severity: "low".into(),
                    limit_label: None,
                },
            )]),
        };
        db.apply(&applied, None, &[], &[]).await.unwrap();
        let session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            generation: terminal.reserve_generation().unwrap(),
        };
        let plan = plan_restore(
            session.clone(),
            &applied.endpoint,
            1,
            &applied,
            &BTreeMap::from([(id.clone(), definition.clone())]),
            &BTreeSet::new(),
            &[],
        )
        .unwrap();
        let engine = db.start_session_plan(plan, 1).await.unwrap();
        let evaluator = AlarmEvaluator::new(db.clone(), applied.clone(), engine)
            .await
            .unwrap();
        let runtime = AlarmRuntime::start(evaluator, hub.clients()).await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if runtime
                    .snapshot()
                    .await
                    .unwrap()
                    .condition(&id)
                    .unwrap()
                    .state
                    .active
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(hub.subscriptions.load(Ordering::SeqCst), 1);
        assert_eq!(
            runtime
                .ack("missing".into(), "old".into(), 0, "operator".into())
                .await
                .unwrap(),
            AckOutcome::NotFound
        );
        assert_eq!(*runtime.status().borrow(), AlarmRuntimeStatus::Running);
        assert_eq!(
            db.events()
                .await
                .unwrap()
                .iter()
                .filter(|event| event.event.kind == "occurred")
                .count(),
            1
        );
        let before = runtime.snapshot().await.unwrap();
        let mut changed = runtime.changes();
        let mut renamed = applied.clone();
        renamed.project_revision = 2;
        renamed.file_hash = "saved-again".into();
        renamed.displays.get_mut(&id).unwrap().name = "Running again".into();
        runtime
            .apply(
                renamed.clone(),
                BTreeMap::from([(id.clone(), definition.clone())]),
                Vec::new(),
                hub.clients(),
            )
            .await
            .unwrap();
        let applied_change = tokio::time::timeout(Duration::from_secs(3), changed.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(applied_change.applied, Some(renamed.clone()));
        assert_eq!(applied_change.seq, before.seq() + 1);
        let after = runtime.snapshot().await.unwrap();
        assert_eq!(after.session(), before.session());
        assert!(after.condition(&id).unwrap().state.active);
        assert_eq!(db.applied().await.unwrap(), Some(renamed.clone()));
        let mut changed_definition = definition;
        if let scada_alarm::Source::Bit { active_when, .. } = &mut changed_definition.spec.source {
            *active_when = false;
        }
        let mut changed_applied = renamed;
        changed_applied.project_revision = 3;
        changed_applied.file_hash = "changed-condition".into();
        changed_applied
            .condition_hashes
            .insert(id.clone(), changed_definition.evaluation_hash());
        let round = &after.condition(&id).unwrap().state;
        runtime
            .apply(
                changed_applied.clone(),
                BTreeMap::from([(id.clone(), changed_definition.clone())]),
                vec![UnackedOccurrence {
                    condition_id: id.clone(),
                    occurrence: round.occurrence.clone().unwrap(),
                    recurrence: round.recurrence,
                }],
                hub.clients(),
            )
            .await
            .unwrap();
        assert!(
            !runtime
                .snapshot()
                .await
                .unwrap()
                .condition(&id)
                .unwrap()
                .state
                .active
        );
        assert!(db
            .events()
            .await
            .unwrap()
            .iter()
            .any(|event| event.event.kind == "definitionChanged"));
        let unavailable_before = db
            .events()
            .await
            .unwrap()
            .iter()
            .filter(|event| {
                event.event.condition_id.as_deref() == Some(id.as_str())
                    && event.event.kind == "unavailableStarted"
            })
            .count();
        let added_id = "alarm:added".to_owned();
        let mut added_definition = changed_definition.clone();
        added_definition.spec.source = scada_alarm::Source::Bit {
            tag: "PLC01.Fast.Added".into(),
            active_when: true,
        };
        let mut added_applied = changed_applied;
        added_applied.project_revision = 4;
        added_applied.file_hash = "added-tag".into();
        added_applied
            .condition_hashes
            .insert(added_id.clone(), added_definition.evaluation_hash());
        added_applied.displays.insert(
            added_id.clone(),
            ConditionDisplay {
                name: "Added".into(),
                message: "追加".into(),
                severity: "low".into(),
                limit_label: None,
            },
        );
        runtime
            .apply(
                added_applied.clone(),
                BTreeMap::from([
                    (id.clone(), changed_definition.clone()),
                    (added_id.clone(), added_definition.clone()),
                ]),
                Vec::new(),
                hub.clients(),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if runtime
                    .snapshot()
                    .await
                    .unwrap()
                    .condition(&added_id)
                    .unwrap()
                    .state
                    .active
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            db.events()
                .await
                .unwrap()
                .iter()
                .filter(
                    |event| event.event.condition_id.as_deref() == Some(id.as_str())
                        && event.event.kind == "unavailableStarted"
                )
                .count(),
            unavailable_before
        );
        let client = hub.clients();
        drop(hub);
        let missing_id = "alarm:missing-after-switch".to_owned();
        let mut missing_definition = added_definition.clone();
        missing_definition.spec.source = scada_alarm::Source::Bit {
            tag: "PLC01.Fast.Missing".into(),
            active_when: true,
        };
        let mut disconnected_applied = added_applied;
        disconnected_applied.project_revision = 5;
        disconnected_applied.file_hash = "disconnected-tag".into();
        disconnected_applied
            .condition_hashes
            .insert(missing_id.clone(), missing_definition.evaluation_hash());
        disconnected_applied.displays.insert(
            missing_id.clone(),
            ConditionDisplay {
                name: "Missing".into(),
                message: "停止".into(),
                severity: "low".into(),
                limit_label: None,
            },
        );
        runtime
            .apply(
                disconnected_applied,
                BTreeMap::from([
                    (id.clone(), changed_definition),
                    (added_id.clone(), added_definition),
                    (missing_id, missing_definition),
                ]),
                Vec::new(),
                client,
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(4), async {
            loop {
                if runtime.snapshot().await.unwrap().unavailable()
                    == Some(EngineUnavailable::Disconnected)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let status = runtime.status();
        runtime.stop().await.unwrap();
        assert_eq!(
            *status.borrow(),
            AlarmRuntimeStatus::Stopped {
                reason: AlarmStopReason::Requested
            }
        );
        assert!(db.session().await.unwrap().unwrap().stopped);
        let db = Arc::try_unwrap(db).ok().unwrap();
        db.close().await;
        drop(terminal);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn unbound_catalog_marks_condition_unresolved_without_engine_disconnect() {
        let hub = Hub::new(&[]).await;
        let dir = std::env::temp_dir().join(format!("alarm-unbound-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let terminal = Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        let project_id = uuid::Uuid::new_v4().to_string();
        let db = Arc::new(AlarmDb::open(terminal.clone(), &project_id).await.unwrap());
        let id = "alarm:missing".to_owned();
        let definition = Definition {
            spec: ConditionSpec {
                source: scada_alarm::Source::Bit {
                    tag: "PLC01.Fast.Missing".into(),
                    active_when: true,
                },
                on_delay_ms: 0,
                off_delay_ms: 0,
                ack_mode: AckMode::Manual,
            },
        };
        let applied = AppliedDefinitions {
            project_id,
            project_revision: 1,
            file_hash: "saved".into(),
            endpoint: hub.url.clone(),
            applied_by: "未ログイン".into(),
            applied_at_ms: 1,
            definitions: serde_json::json!({"definitions": []}),
            condition_hashes: BTreeMap::from([(id.clone(), definition.evaluation_hash())]),
            disabled_condition_ids: BTreeSet::new(),
            displays: BTreeMap::from([(
                id.clone(),
                ConditionDisplay {
                    name: "Missing".into(),
                    message: "未解決".into(),
                    severity: "low".into(),
                    limit_label: None,
                },
            )]),
        };
        db.apply(&applied, None, &[], &[]).await.unwrap();
        let session = Session {
            id: uuid::Uuid::new_v4().to_string(),
            generation: terminal.reserve_generation().unwrap(),
        };
        let plan = plan_restore(
            session,
            &applied.endpoint,
            1,
            &applied,
            &BTreeMap::from([(id.clone(), definition)]),
            &BTreeSet::new(),
            &[],
        )
        .unwrap();
        let engine = db.start_session_plan(plan, 1).await.unwrap();
        let evaluator = AlarmEvaluator::new(db.clone(), applied, engine)
            .await
            .unwrap();
        let runtime = AlarmRuntime::start(evaluator, hub.clients()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let engine = runtime.snapshot().await.unwrap();
                if engine.condition(&id).unwrap().state.unavailable
                    == Some(scada_alarm::Unavailable::Unresolved)
                {
                    assert_eq!(engine.unavailable(), None);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(hub.subscriptions.load(Ordering::SeqCst), 0);
        assert_eq!(
            db.events()
                .await
                .unwrap()
                .iter()
                .filter(|event| event.event.kind == "unavailableStarted")
                .count(),
            1
        );
        runtime.stop().await.unwrap();
        let db = Arc::try_unwrap(db).ok().unwrap();
        db.close().await;
        drop(terminal);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
