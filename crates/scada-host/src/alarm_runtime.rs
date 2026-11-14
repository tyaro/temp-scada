//! Dedicated Hub subscription and durable alarm evaluation for one session.
//! The webview does not own the subscription or the Engine.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use banto_tagclient::{
    BindingRequest, BindingView, ErrorKind, GenerationSnapshot, RestClient,
    TagClientConnectionState, TagClientHandle, ValueQuality,
};
use scada_alarm::{
    AckOutcome, Engine, EngineUnavailable, Event, Input, Now, Quality, Sample, TagValue, Transition,
};
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::alarm_db::{AlarmDb, AlarmDbError, AppliedDefinitions, Definition, EventWrite, LastRow};

#[derive(Debug)]
pub enum AlarmRuntimeError {
    Db(AlarmDbError),
    Sdk(ErrorKind),
    Step(scada_alarm::StepError),
    InvalidDefinition,
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
}

pub struct AlarmEvaluator {
    db: Arc<AlarmDb>,
    applied: AppliedDefinitions,
    engine: Engine,
    origin: Instant,
}

impl AlarmEvaluator {
    pub fn new(
        db: Arc<AlarmDb>,
        applied: AppliedDefinitions,
        engine: Engine,
    ) -> Result<Self, AlarmRuntimeError> {
        if applied.condition_hashes.len() != engine.conditions().len()
            || engine.conditions().iter().any(|(id, condition)| {
                applied.condition_hashes.get(id)
                    != Some(
                        &Definition {
                            spec: condition.spec.clone(),
                        }
                        .evaluation_hash(),
                    )
            })
        {
            return Err(AlarmRuntimeError::InvalidDefinition);
        }
        Ok(Self {
            db,
            applied,
            engine,
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
    let mut detail =
        serde_json::to_value(event).map_err(|_| AlarmRuntimeError::InvalidDefinition)?;
    let kind = detail
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .ok_or(AlarmRuntimeError::InvalidDefinition)?
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
    Ack {
        condition: String,
        occurrence: String,
        recurrence: u32,
        user: String,
        reply: oneshot::Sender<Result<AckOutcome, AlarmRuntimeError>>,
    },
    Stop(oneshot::Sender<Result<(), AlarmRuntimeError>>),
}

/// One owner for the dedicated SDK connection and serialized Engine inputs.
pub struct AlarmRuntime {
    control: mpsc::Sender<Control>,
    changes: broadcast::Sender<AlarmChange>,
    task: tokio::task::JoinHandle<Result<(), AlarmRuntimeError>>,
}

impl AlarmRuntime {
    pub async fn start(
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
                evaluator
                    .db
                    .stop_session(evaluator.engine.session(), wall_ms())
                    .await?;
                return Err(AlarmRuntimeError::Sdk(error.kind()));
            }
        };
        let (control, control_rx) = mpsc::channel(32);
        let (changes, _) = broadcast::channel(256);
        let change_tx = changes.clone();
        let task = tokio::spawn(run(evaluator, sdk, control_rx, change_tx, tags));
        Ok(Self {
            control,
            changes,
            task,
        })
    }

    pub fn changes(&self) -> broadcast::Receiver<AlarmChange> {
        self.changes.subscribe()
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
    mut evaluator: AlarmEvaluator,
    sdk: TagClientHandle,
    mut control_rx: mpsc::Receiver<Control>,
    change_tx: broadcast::Sender<AlarmChange>,
    tags: BTreeSet<String>,
) -> Result<(), AlarmRuntimeError> {
    let mut states = sdk.state_watch();
    let mut previous = BTreeMap::new();
    let mut was_live = false;
    // Process the current snapshot before waiting so a rapid initial Live is not lost.
    let initial = states.borrow_and_update().clone();
    if initial.connection_state() == TagClientConnectionState::Stopped
        && initial.last_error().is_some()
    {
        let _ = stop(evaluator, sdk, &change_tx).await;
        return Err(AlarmRuntimeError::Closed);
    }
    if let Err(error) = process_state(
        &mut evaluator,
        &initial,
        &tags,
        &mut previous,
        &mut was_live,
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
                    return Err(AlarmRuntimeError::Closed);
                }
                if let Err(error) = process_state(&mut evaluator, &current, &tags, &mut previous, &mut was_live, &change_tx).await {
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
                Some(Control::Ack { condition, occurrence, recurrence, user, reply }) => {
                    let result = evaluator.input_with_ack(Input::Ack { condition, occurrence, recurrence, user }).await;
                    match result {
                        Ok((change, ack)) => {
                            let _ = reply.send(ack.ok_or(AlarmRuntimeError::InvalidDefinition));
                            if let Some(change) = change { let _ = change_tx.send(change); }
                        }
                        Err(error) => {
                            let _ = reply.send(Err(error));
                            let _ = stop(evaluator, sdk, &change_tx).await;
                            return Err(AlarmRuntimeError::Closed);
                        }
                    }
                }
                Some(Control::Stop(reply)) => {
                    let result = stop(evaluator, sdk, &change_tx).await;
                    let _ = reply.send(result);
                    return Ok(());
                }
                None => return stop(evaluator, sdk, &change_tx).await,
            }
        }
    }
}

async fn stop(
    mut evaluator: AlarmEvaluator,
    sdk: TagClientHandle,
    changes: &broadcast::Sender<AlarmChange>,
) -> Result<(), AlarmRuntimeError> {
    // A stop is also a boundary: commit every already-expired wait first.
    let settled = publish(&mut evaluator, Input::TimerExpired, changes).await;
    let sdk_result = sdk
        .shutdown()
        .await
        .map_err(|error| AlarmRuntimeError::Sdk(error.kind()));
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
    was_live: &mut bool,
    changes: &broadcast::Sender<AlarmChange>,
) -> Result<(), AlarmRuntimeError> {
    match state.connection_state() {
        TagClientConnectionState::Unauthorized => {
            return Err(AlarmRuntimeError::Sdk(ErrorKind::Unauthorized))
        }
        TagClientConnectionState::Live => {
            if !*was_live {
                publish(
                    evaluator,
                    Input::EngineAvailability { unavailable: None },
                    changes,
                )
                .await?;
                previous.clear();
            }
            let snapshot = state
                .snapshot()
                .ok_or(AlarmRuntimeError::InvalidDefinition)?;
            for tag in tags {
                let sample = sample(snapshot, tag);
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
            *was_live = true;
        }
        _ => {
            if *was_live || evaluator.engine.unavailable().is_none() {
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
            *was_live = false;
        }
    }
    Ok(())
}

fn sample(snapshot: &GenerationSnapshot, tag: &str) -> Sample {
    let invalid = || Sample {
        resolved: false,
        quality: Quality::Bad,
        value: None,
        source_timestamp_ms: None,
    };
    let Some(binding) = snapshot.binding(tag) else {
        return invalid();
    };
    let BindingView::Resolved {
        tag: catalog,
        value,
        ..
    } = binding
    else {
        return invalid();
    };
    if !catalog.enabled {
        return invalid();
    }
    let Some(value) = value else { return invalid() };
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
    Sample {
        resolved: true,
        quality,
        value: converted,
        source_timestamp_ms: Some(source_timestamp_ms),
    }
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
        let mut evaluator = AlarmEvaluator::new(db.clone(), applied, engine).unwrap();
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
        drop(evaluator);
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
            &BTreeMap::from([(id.clone(), definition)]),
            &BTreeSet::new(),
            &[],
        )
        .unwrap();
        let engine = db.start_session_plan(plan, 1).await.unwrap();
        let evaluator = AlarmEvaluator::new(db.clone(), applied, engine).unwrap();
        let runtime = AlarmRuntime::start(evaluator, hub.client()).await.unwrap();
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
            db.events()
                .await
                .unwrap()
                .iter()
                .filter(|event| event.event.kind == "occurred")
                .count(),
            1
        );
        runtime.stop().await.unwrap();
        assert!(db.session().await.unwrap().unwrap().stopped);
        let db = Arc::try_unwrap(db).ok().unwrap();
        db.close().await;
        drop(terminal);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
