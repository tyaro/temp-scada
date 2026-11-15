//! Dedicated Hub subscription and durable alarm evaluation for one session.
//! The webview does not own the subscription or the Engine.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use banto_tagclient::{
    BindingRequest, BindingView, Endpoint, ErrorKind, GenerationSnapshot, PinnedHubTls, RestClient,
    SecretApiKey, TagClientConnectionState, TagClientHandle, ValueQuality,
};
use scada_alarm::{
    AckOutcome, EndReason, Engine, EngineUnavailable, Event, EventKind, Input, Now, Quality,
    Sample, TagValue, Transition,
};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use crate::alarm_db::{
    plan_apply, AlarmDb, AlarmDbError, AppliedDefinitions, Definition, EventWrite, LastRow,
    StartedAlarmSession, UnackedOccurrence,
};
use crate::alarm_terminal::ActiveAlarmSession;

#[derive(Debug)]
pub enum AlarmRuntimeError {
    Db(AlarmDbError),
    Sdk(ErrorKind),
    Step(scada_alarm::StepError),
    InvalidDefinition,
    Internal,
    StorageFailure,
    ConnectionFailure,
    Closed,
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
        })
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
            self.persist(&transition).await?;
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
    client: RestClient,
    reply: oneshot::Sender<Result<(), AlarmRuntimeError>>,
}

/// One owner for the dedicated SDK connection and serialized Engine inputs.
pub struct AlarmRuntime {
    control: mpsc::Sender<Control>,
    changes: broadcast::Sender<AlarmChange>,
    status: watch::Receiver<AlarmRuntimeStatus>,
    task: tokio::task::JoinHandle<Result<(), AlarmRuntimeError>>,
}

impl AlarmRuntime {
    pub async fn start(
        evaluator: AlarmEvaluator,
        secret: SecretApiKey,
        pins: Option<PinnedHubTls>,
        request_timeout: Duration,
    ) -> Result<Self, AlarmRuntimeError> {
        // Construct the SDK client from the applied endpoint, never a caller's
        // independent address that could mislabel durable alarm states.
        let client = (|| {
            let endpoint = Endpoint::new(&evaluator.applied.endpoint)?;
            match pins {
                Some(pins) => RestClient::with_pinned_tls(endpoint, secret, request_timeout, pins),
                None => RestClient::with_request_timeout(endpoint, secret, request_timeout),
            }
        })();
        let client = match client {
            Ok(client) => client,
            Err(error) => {
                let _ = evaluator
                    .db
                    .stop_session(evaluator.engine.session(), wall_ms())
                    .await;
                return Err(AlarmRuntimeError::Sdk(error.kind()));
            }
        };
        Self::start_with_client(evaluator, client).await
    }

    /// Start from the protected bootstrap client's saved credential. The
    /// caller first compares its HubRecord endpoint with the applied record.
    pub async fn start_with_client(
        evaluator: AlarmEvaluator,
        client: RestClient,
    ) -> Result<Self, AlarmRuntimeError> {
        let tags: BTreeSet<_> = evaluator
            .engine
            .conditions()
            .values()
            .map(|condition| condition.spec.source.tag().to_owned())
            .collect();
        let requests = tags
            .iter()
            .map(|tag| BindingRequest {
                binding_key: tag.clone(),
                external_name: tag.clone(),
            })
            .collect();
        let sdk = match client.start(requests) {
            Ok(sdk) => sdk,
            Err(error) => {
                let _ = evaluator
                    .db
                    .stop_session(evaluator.engine.session(), wall_ms())
                    .await;
                return Err(AlarmRuntimeError::Sdk(error.kind()));
            }
        };
        let (control, control_rx) = mpsc::channel(32);
        let (changes, _) = broadcast::channel(256);
        let change_tx = changes.clone();
        let (status_tx, status) = watch::channel(AlarmRuntimeStatus::Running);
        let task = tokio::spawn(run(evaluator, sdk, control_rx, change_tx, tags, status_tx));
        Ok(Self {
            control,
            changes,
            status,
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

    pub async fn apply(
        &self,
        applied: AppliedDefinitions,
        definitions: BTreeMap<String, Definition>,
        confirmed: Vec<UnackedOccurrence>,
        client: RestClient,
    ) -> Result<(), AlarmRuntimeError> {
        let (reply, rx) = oneshot::channel();
        self.control
            .send(Control::Apply(Box::new(ApplyCommand {
                applied,
                definitions,
                confirmed,
                client,
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
    status_tx: watch::Sender<AlarmRuntimeStatus>,
) -> Result<(), AlarmRuntimeError> {
    run_with_status(
        run_inner(evaluator, sdk, control_rx, change_tx, tags),
        status_tx,
    )
    .await
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
        Err(AlarmRuntimeError::Db(_) | AlarmRuntimeError::StorageFailure) => {
            AlarmStopReason::StorageFailure
        }
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
) -> Result<(), AlarmRuntimeError> {
    let mut states = sdk.state_watch();
    let mut previous = BTreeMap::new();
    let mut was_evaluable = false;
    let mut accepted_generation = None;
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
        &change_tx,
    )
    .await
    {
        let _ = stop(evaluator, sdk, &change_tx).await;
        return Err(error);
    }
    loop {
        let due = evaluator.engine.next_due_ms();
        let deadline = due.map(|ms| evaluator.origin + std::time::Duration::from_millis(ms));
        tokio::select! {
            state = states.changed() => {
                if state.is_err() {
                    let _ = stop(evaluator, sdk, &change_tx).await;
                    return Err(AlarmRuntimeError::Closed);
                }
                let current = states.borrow_and_update().clone();
                if current.connection_state() == TagClientConnectionState::Stopped {
                    let _ = stop(evaluator, sdk, &change_tx).await;
                    return Err(current.last_error().map_or(AlarmRuntimeError::Closed, AlarmRuntimeError::Sdk));
                }
                if let Err(error) = process_state(&mut evaluator, &current, &tags, &mut previous, &mut was_evaluable, &mut accepted_generation, &change_tx).await {
                    let _ = stop(evaluator, sdk, &change_tx).await;
                    return Err(error);
                }
            }
            _ = async { if let Some(deadline) = deadline { tokio::time::sleep_until(deadline.into()).await } else { std::future::pending::<()>().await } } => {
                if let Err(error) = publish(&mut evaluator, Input::TimerExpired, &change_tx).await {
                    let _ = stop(evaluator, sdk, &change_tx).await;
                    return Err(error);
                }
            }
            control = control_rx.recv() => match control {
                Some(Control::Snapshot(reply)) => { let _ = reply.send(evaluator.engine.clone()); }
                Some(Control::Apply(command)) => {
                    let ApplyCommand { applied, definitions, confirmed, client, reply } = *command;
                    if let Err(error) = publish(&mut evaluator, Input::TimerExpired, &change_tx).await {
                        let _ = reply.send(Err(error_summary(&error)));
                        let _ = stop(evaluator, sdk, &change_tx).await;
                        return Err(error);
                    }
                    let next_tags: BTreeSet<_> = definitions.values().map(|definition| definition.spec.source.tag().to_owned()).collect();
                    let replacement = if next_tags != tags {
                        let requests = next_tags.iter().map(|tag| BindingRequest { binding_key: tag.clone(), external_name: tag.clone() }).collect();
                        match client.start(requests) {
                            Ok(handle) => Some(handle),
                            Err(error) => {
                                let _ = reply.send(Err(AlarmRuntimeError::Sdk(error.kind())));
                                continue;
                            }
                        }
                    } else { None };
                    match evaluator.apply(applied, &definitions, &confirmed).await {
                        Ok(change) => {
                            if let Some(replacement) = replacement {
                                let old = std::mem::replace(&mut sdk, replacement);
                                states = sdk.state_watch();
                                tags = next_tags;
                                previous.clear();
                                was_evaluable = false;
                                accepted_generation = None;
                                tokio::spawn(async move {
                                    let _ = tokio::time::timeout(Duration::from_secs(5), old.shutdown()).await;
                                });
                            } else {
                                previous.clear();
                            }
                            let _ = change_tx.send(change);
                            let _ = reply.send(Ok(()));
                            let current = states.borrow_and_update().clone();
                            if let Err(error) = process_state(&mut evaluator, &current, &tags, &mut previous, &mut was_evaluable, &mut accepted_generation, &change_tx).await {
                                let _ = stop(evaluator, sdk, &change_tx).await;
                                return Err(error);
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

fn error_summary(error: &AlarmRuntimeError) -> AlarmRuntimeError {
    match error {
        AlarmRuntimeError::Db(_) | AlarmRuntimeError::StorageFailure => {
            AlarmRuntimeError::StorageFailure
        }
        AlarmRuntimeError::Sdk(_) | AlarmRuntimeError::ConnectionFailure => {
            AlarmRuntimeError::ConnectionFailure
        }
        AlarmRuntimeError::InvalidDefinition => AlarmRuntimeError::InvalidDefinition,
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
    let sdk_result = tokio::time::timeout(Duration::from_secs(5), sdk.shutdown())
        .await
        .map_err(|_| AlarmRuntimeError::ConnectionFailure)
        .and_then(|result| result.map_err(|error| AlarmRuntimeError::Sdk(error.kind())));
    evaluator
        .db
        .stop_session(evaluator.engine.session(), wall_ms())
        .await?;
    settled?;
    sdk_result
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

async fn process_state(
    evaluator: &mut AlarmEvaluator,
    state: &banto_tagclient::TagClientState,
    tags: &BTreeSet<String>,
    previous: &mut BTreeMap<String, Sample>,
    was_evaluable: &mut bool,
    accepted_generation: &mut Option<u64>,
    changes: &broadcast::Sender<AlarmChange>,
) -> Result<(), AlarmRuntimeError> {
    match state.connection_state() {
        TagClientConnectionState::Unauthorized => {
            return Err(AlarmRuntimeError::Sdk(ErrorKind::Unauthorized))
        }
        TagClientConnectionState::Live | TagClientConnectionState::Unbound => {
            let snapshot = state.snapshot().ok_or(AlarmRuntimeError::Internal)?;
            begin_generation(
                evaluator,
                snapshot.generation,
                previous,
                was_evaluable,
                accepted_generation,
                changes,
            )
            .await?;
            for tag in tags {
                let Some(sample) = sample(snapshot, tag) else {
                    // A resolved binding without its first value remains InitialValue.
                    continue;
                };
                if previous.get(tag) != Some(&sample) {
                    publish(
                        evaluator,
                        Input::Value {
                            tag: tag.clone(),
                            sample: sample.clone(),
                        },
                        changes,
                    )
                    .await?;
                    previous.insert(tag.clone(), sample);
                }
            }
        }
        _ => {
            if *was_evaluable || evaluator.engine.unavailable().is_none() {
                publish(
                    evaluator,
                    Input::EngineAvailability {
                        unavailable: Some(EngineUnavailable::Disconnected),
                    },
                    changes,
                )
                .await?;
            }
            previous.clear();
            *was_evaluable = false;
        }
    }
    Ok(())
}

async fn begin_generation(
    evaluator: &mut AlarmEvaluator,
    generation: u64,
    previous: &mut BTreeMap<String, Sample>,
    was_evaluable: &mut bool,
    accepted_generation: &mut Option<u64>,
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
    if evaluator.engine.unavailable().is_some() {
        publish(
            evaluator,
            Input::EngineAvailability { unavailable: None },
            changes,
        )
        .await?;
    }
    if !*was_evaluable || generation_changed {
        previous.clear();
    }
    *was_evaluable = true;
    *accepted_generation = Some(generation);
    Ok(())
}

fn sample(snapshot: &GenerationSnapshot, tag: &str) -> Option<Sample> {
    let invalid = || Sample {
        resolved: false,
        quality: Quality::Bad,
        value: None,
        source_timestamp_ms: None,
    };
    let Some(binding) = snapshot.binding(tag) else {
        return Some(invalid());
    };
    let BindingView::Resolved {
        tag: catalog,
        value,
        ..
    } = binding
    else {
        return Some(invalid());
    };
    if !catalog.enabled {
        return Some(invalid());
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
        let mut previous = BTreeMap::from([(
            "PLANT.FLAG".into(),
            Sample {
                resolved: true,
                quality: Quality::Good,
                value: Some(TagValue::Bool(true)),
                source_timestamp_ms: Some(10),
            },
        )]);
        let mut was_evaluable = true;
        let mut generation = Some(1);
        begin_generation(
            &mut evaluator,
            2,
            &mut previous,
            &mut was_evaluable,
            &mut generation,
            &changes,
        )
        .await
        .unwrap();
        assert_eq!(generation, Some(2));
        assert!(previous.is_empty());
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

    #[tokio::test]
    async fn dedicated_sdk_subscription_evaluates_and_stops_its_session() {
        let hub = Hub::new(&[("PLC01.Fast.Running", "bit")]).await;
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
        let runtime = AlarmRuntime::start(
            evaluator,
            SecretApiKey::new("alarm-test-key".into()).unwrap(),
            None,
            Duration::from_secs(2),
        )
        .await
        .unwrap();
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
                hub.client(),
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
                changed_applied,
                BTreeMap::from([(id.clone(), changed_definition)]),
                vec![UnackedOccurrence {
                    condition_id: id.clone(),
                    occurrence: round.occurrence.clone().unwrap(),
                    recurrence: round.recurrence,
                }],
                hub.client(),
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
        let runtime = AlarmRuntime::start(
            evaluator,
            SecretApiKey::new("alarm-test-key".into()).unwrap(),
            None,
            Duration::from_secs(2),
        )
        .await
        .unwrap();
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
