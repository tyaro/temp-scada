//! 状態機械の本体（設計§4.2〜§4.5）。

use std::collections::BTreeMap;

use serde::Serialize;

use crate::spec::{AckMode, ConditionSpec, Source, SpecError};
use crate::state::{
    ConditionState, EngineUnavailable, LastState, Observation, OrderKey, Quality, Sample, TagValue,
    Timer, Unavailable,
};

/// host が渡す時刻。delay は単調時計で測り、壁時計は表示とイベントにだけ使う（設計§4.4）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Now {
    pub mono_ms: u64,
    pub wall_ms: i64,
}

/// session の識別（設計§5.4）。世代番号は host 全体で単調に増える。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub generation: u64,
}

/// 新しい occurrence の id を振る（host は UUID v7 を渡す）。crate は乱数を持たない。
pub trait OccurrenceIds {
    fn next_occurrence(&mut self) -> String;
}

impl<F: FnMut() -> String> OccurrenceIds for F {
    fn next_occurrence(&mut self) -> String {
        self()
    }
}

/// condition を終える理由（設計§5.2）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EndReason {
    /// 評価に関わる内容の変更・無効化。
    DefinitionChanged,
    /// 定義の削除。
    DefinitionDeleted,
    /// Hub の接続先の変更。
    ConnectionChanged,
}

/// 入力（設計§4.2 の 6 種類）。
#[derive(Clone, Debug, PartialEq)]
pub enum Input {
    /// あるタグの値。そのタグを使う全 condition に当てる。
    Value { tag: String, sample: Sample },
    /// タイマーの満了。満了の時刻が `now.mono_ms` 以下の待ちをすべて判定する。
    TimerExpired,
    /// 見ている回の ACK。
    Ack {
        condition: String,
        occurrence: String,
        recurrence: u32,
        user: String,
    },
    /// Engine 単位の評価不能の始まり（`Some`）・終わり（`None`）。
    EngineAvailability {
        unavailable: Option<EngineUnavailable>,
    },
    /// 定義の終了。
    EndCondition {
        condition: String,
        reason: EndReason,
    },
    /// 「最後の状態」の行から始める。
    Restore { condition: String, row: LastState },
}

/// ブザーの鳴らし方。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Sound {
    /// 未確認のあいだ鳴らす（ブザー停止を解く）。
    Continuous,
    /// 一度だけ鳴らす（`noneWithSound`）。
    Once,
    /// 鳴らさない（`none`）。
    Silent,
}

/// 判定に使った限界・deadband・値（設計§4.4）。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Judgement {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadband: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<TagValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_timestamp_ms: Option<i64>,
}

/// イベントの種類。Engine の開始・停止・前回の終了時の状態などは host が書く。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EventKind {
    Occurred {
        sound: Sound,
        judgement: Judgement,
    },
    Reoccurred {
        sound: Sound,
        judgement: Judgement,
    },
    Returned {
        judgement: Judgement,
    },
    Acked {
        user: String,
    },
    AutoAcked,
    UnavailableStarted {
        reason: Unavailable,
    },
    UnavailableEnded {
        reason: Unavailable,
    },
    EngineUnavailableStarted {
        reason: EngineUnavailable,
    },
    EngineUnavailableEnded {
        reason: EngineUnavailable,
    },
    Ended {
        reason: EndReason,
        /// 未確認のまま終了したなら true。
        unacked: bool,
    },
}

/// 警報イベント。通番・session id・表示の情報は host が DB に書くときに付ける。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub at_wall_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub occurrence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence: Option<u32>,
    #[serde(flatten)]
    pub kind: EventKind,
}

/// ACK の結果（設計§5.5 の `alarm_ack`。「履歴に書けない」は host が返す）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AckOutcome {
    Accepted,
    OtherOccurrence,
    AlreadyAcked,
    NotFound,
}

/// 入力が状態機械に当てはまらない（host の誤り）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StepError {
    UnknownCondition(String),
    /// 発生中・未確認の行に occurrence が無い。
    InvalidLastState(String),
    /// すでに評価を始めた condition への復元。
    AlreadyStarted(String),
}

impl std::fmt::Display for StepError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StepError::UnknownCondition(id) => write!(f, "condition {id} がありません"),
            StepError::InvalidLastState(id) => {
                write!(f, "condition {id} の最後の状態に occurrence がありません")
            }
            StepError::AlreadyStarted(id) => {
                write!(f, "condition {id} はすでに評価を始めています")
            }
        }
    }
}

impl std::error::Error for StepError {}

/// condition の追加の失敗。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DefineError {
    Duplicate(String),
    InvalidSpec(String, SpecError),
}

impl std::fmt::Display for DefineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DefineError::Duplicate(id) => write!(f, "condition {id} が重複しています"),
            DefineError::InvalidSpec(id, error) => write!(f, "condition {id}: {error}"),
        }
    }
}

impl std::error::Error for DefineError {}

/// 定義と状態の組。
#[derive(Clone, Debug, PartialEq)]
pub struct Condition {
    pub spec: ConditionSpec,
    pub state: ConditionState,
}

/// `step` の結果。host が DB に書けたら `commit` で確定する（設計§4）。
#[derive(Clone, Debug, PartialEq)]
pub struct Transition {
    /// 確定後の Engine の変更の連番。画面へ知らせる変更が無ければ今の連番のまま。
    pub seq: u64,
    /// 画面へ知らせる変更があるか（イベント・状態・Engine 単位の評価不能）。
    pub changed: bool,
    /// 変わった condition の次の状態（`None` は終えて消す）。
    pub conditions: BTreeMap<String, Option<ConditionState>>,
    /// Engine 単位の評価不能の次の値。
    pub engine_unavailable: Option<EngineUnavailable>,
    pub events: Vec<Event>,
    /// ACK の入力なら結果。
    pub ack: Option<AckOutcome>,
}

/// 警報 Engine の状態（入出力なし）。
#[derive(Clone, Debug, PartialEq)]
pub struct Engine {
    session: Session,
    seq: u64,
    unavailable: Option<EngineUnavailable>,
    conditions: BTreeMap<String, Condition>,
}

impl Engine {
    /// session を始める。Engine の変更の連番は 1 から振る。
    pub fn new(session: Session) -> Self {
        Self {
            session,
            seq: 0,
            unavailable: None,
            conditions: BTreeMap::new(),
        }
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn unavailable(&self) -> Option<EngineUnavailable> {
        self.unavailable
    }

    pub fn conditions(&self) -> &BTreeMap<String, Condition> {
        &self.conditions
    }

    pub fn condition(&self, id: &str) -> Option<&Condition> {
        self.conditions.get(id)
    }

    /// condition を Normal・初期値待ちで加える（適用・session の開始。イベントは書かない）。
    pub fn define(
        &mut self,
        id: impl Into<String>,
        spec: ConditionSpec,
    ) -> Result<(), DefineError> {
        let id = id.into();
        if let Err(error) = spec.validate() {
            return Err(DefineError::InvalidSpec(id, error));
        }
        if self.conditions.contains_key(&id) {
            return Err(DefineError::Duplicate(id));
        }
        self.conditions.insert(
            id,
            Condition {
                spec,
                state: ConditionState::initial(),
            },
        );
        Ok(())
    }

    /// 次に満了する待ちの時刻（単調時計）。host はこの時刻にタイマーを掛ける。
    pub fn next_due_ms(&self) -> Option<u64> {
        self.conditions
            .values()
            .filter_map(|condition| condition.state.timer.map(Timer::due_ms))
            .min()
    }

    /// 入力を当てた結果を返す。`self` は変えない。
    pub fn step(
        &self,
        now: Now,
        input: &Input,
        ids: &mut dyn OccurrenceIds,
    ) -> Result<Transition, StepError> {
        let mut work = Work {
            now,
            order_key: OrderKey {
                generation: self.session.generation,
                seq: self.seq + 1,
            },
            ids,
            events: Vec::new(),
        };
        let mut next: BTreeMap<String, Option<ConditionState>> = BTreeMap::new();
        let mut engine_unavailable = self.unavailable;
        let mut ack = None;

        match input {
            Input::Value { tag, sample } => {
                if self.unavailable.is_none() {
                    for (id, condition) in &self.conditions {
                        if condition.spec.source.tag() != tag {
                            continue;
                        }
                        let mut state = condition.state.clone();
                        work.value(id, &condition.spec, &mut state, sample);
                        next.insert(id.clone(), Some(state));
                    }
                }
            }
            Input::TimerExpired => {
                for (id, condition) in &self.conditions {
                    let due = condition
                        .state
                        .timer
                        .is_some_and(|timer| timer.due_ms() <= now.mono_ms);
                    if due {
                        let mut state = condition.state.clone();
                        work.expire(id, &condition.spec, &mut state);
                        next.insert(id.clone(), Some(state));
                    }
                }
            }
            Input::Ack {
                condition,
                occurrence,
                recurrence,
                user,
            } => {
                let outcome = match self.conditions.get(condition) {
                    None => AckOutcome::NotFound,
                    Some(current) => {
                        let mut state = current.state.clone();
                        let outcome =
                            work.ack(condition, &mut state, occurrence, *recurrence, user);
                        next.insert(condition.clone(), Some(state));
                        outcome
                    }
                };
                ack = Some(outcome);
            }
            Input::EngineAvailability { unavailable } => {
                if *unavailable != self.unavailable {
                    if let Some(old) = self.unavailable {
                        work.push(None, EventKind::EngineUnavailableEnded { reason: old });
                    }
                    if let Some(reason) = unavailable {
                        work.push(
                            None,
                            EventKind::EngineUnavailableStarted { reason: *reason },
                        );
                    }
                    for (id, condition) in &self.conditions {
                        let mut state = condition.state.clone();
                        state.timer = None;
                        if unavailable.is_none() {
                            // 持っていた値では判定しない。次の値が届くまで初期値待ち（§4.5）。
                            state.unavailable = Some(Unavailable::InitialValue);
                            state.observation = None;
                        }
                        next.insert(id.clone(), Some(state));
                    }
                    engine_unavailable = *unavailable;
                }
            }
            Input::EndCondition { condition, reason } => {
                let current = self
                    .conditions
                    .get(condition)
                    .ok_or_else(|| StepError::UnknownCondition(condition.clone()))?;
                let state = &current.state;
                work.events.push(Event {
                    at_wall_ms: now.wall_ms,
                    condition: Some(condition.clone()),
                    occurrence: state.occurrence.clone(),
                    recurrence: state.occurrence.as_ref().map(|_| state.recurrence),
                    kind: EventKind::Ended {
                        reason: *reason,
                        unacked: !state.acked,
                    },
                });
                next.insert(condition.clone(), None);
            }
            Input::Restore { condition, row } => {
                let current = self
                    .conditions
                    .get(condition)
                    .ok_or_else(|| StepError::UnknownCondition(condition.clone()))?;
                // 値が届いた・待ちを始めた・復元した condition には当てない（発生待ちの間も）。
                if current.state != ConditionState::initial() {
                    return Err(StepError::AlreadyStarted(condition.clone()));
                }
                if (row.active || !row.acked) && row.occurrence.is_none() {
                    return Err(StepError::InvalidLastState(condition.clone()));
                }
                let state = ConditionState {
                    active: row.active,
                    occurrence: row.occurrence.clone(),
                    recurrence: row.recurrence,
                    acked: row.acked,
                    timer: None,
                    unavailable: Some(Unavailable::InitialValue),
                    reported_unavailable: row.unavailable.filter(|reason| reason.is_reported()),
                    order_key: row.order_key,
                    occurred_at_ms: row.occurred_at_ms,
                    observation: None,
                };
                next.insert(condition.clone(), Some(state));
            }
        }

        let state_changed = next
            .iter()
            .any(|(id, state)| match (self.conditions.get(id), state) {
                (Some(current), Some(state)) => !current.state.visibly_equal(state),
                _ => true,
            });
        let changed =
            !work.events.is_empty() || state_changed || engine_unavailable != self.unavailable;
        Ok(Transition {
            seq: if changed { self.seq + 1 } else { self.seq },
            changed,
            conditions: next,
            engine_unavailable,
            events: work.events,
            ack,
        })
    }

    /// `step` の結果を確定する。
    pub fn commit(&mut self, transition: Transition) {
        self.seq = transition.seq;
        self.unavailable = transition.engine_unavailable;
        for (id, state) in transition.conditions {
            match state {
                Some(state) => {
                    if let Some(condition) = self.conditions.get_mut(&id) {
                        condition.state = state;
                    }
                }
                None => {
                    self.conditions.remove(&id);
                }
            }
        }
    }
}

struct Work<'a> {
    now: Now,
    order_key: OrderKey,
    ids: &'a mut dyn OccurrenceIds,
    events: Vec<Event>,
}

impl Work<'_> {
    fn push(&mut self, condition: Option<(&str, &ConditionState)>, kind: EventKind) {
        let (condition, occurrence, recurrence) = match condition {
            Some((id, state)) => (
                Some(id.to_owned()),
                state.occurrence.clone(),
                state.occurrence.as_ref().map(|_| state.recurrence),
            ),
            None => (None, None, None),
        };
        self.events.push(Event {
            at_wall_ms: self.now.wall_ms,
            condition,
            occurrence,
            recurrence,
            kind,
        });
    }

    fn value(
        &mut self,
        id: &str,
        spec: &ConditionSpec,
        state: &mut ConditionState,
        sample: &Sample,
    ) {
        match classify(spec, sample) {
            Err(reason) => {
                state.timer = None;
                state.observation = None;
                state.unavailable = Some(reason);
                if state.reported_unavailable != Some(reason) {
                    if let Some(old) = state.reported_unavailable.take() {
                        self.push(
                            Some((id, state)),
                            EventKind::UnavailableEnded { reason: old },
                        );
                    }
                    self.push(Some((id, state)), EventKind::UnavailableStarted { reason });
                    state.reported_unavailable = Some(reason);
                }
            }
            Ok(observation) => {
                if let Some(old) = state.reported_unavailable.take() {
                    self.push(
                        Some((id, state)),
                        EventKind::UnavailableEnded { reason: old },
                    );
                }
                if state.unavailable.take().is_some() {
                    // 評価不能が解けた: その時点から判定し直す（delay は最初から数える）。
                    state.timer = None;
                }
                state.observation = Some(observation);
                self.evaluate(id, spec, state);
            }
        }
    }

    fn evaluate(&mut self, id: &str, spec: &ConditionSpec, state: &mut ConditionState) {
        let Some(observation) = &state.observation else {
            return;
        };
        let holds = holds(spec, state.active, &observation.value);
        let now = self.now.mono_ms;
        if !state.active {
            if holds {
                if !matches!(state.timer, Some(Timer::OnDelay { .. })) {
                    state.timer = Some(Timer::OnDelay {
                        due_ms: now.saturating_add(spec.on_delay_ms),
                    });
                }
            } else {
                state.timer = None;
            }
        } else if !holds {
            if !matches!(state.timer, Some(Timer::OffDelay { .. })) {
                state.timer = Some(Timer::OffDelay {
                    due_ms: now.saturating_add(spec.off_delay_ms),
                });
            }
        } else {
            state.timer = None;
        }
        if state.timer.is_some_and(|timer| timer.due_ms() <= now) {
            self.expire(id, spec, state);
        }
    }

    fn expire(&mut self, id: &str, spec: &ConditionSpec, state: &mut ConditionState) {
        match state.timer.take() {
            Some(Timer::OnDelay { .. }) => self.occur(id, spec, state),
            Some(Timer::OffDelay { .. }) => self.return_to_normal(id, spec, state),
            None => {}
        }
    }

    fn occur(&mut self, id: &str, spec: &ConditionSpec, state: &mut ConditionState) {
        let judgement = judgement(spec, state);
        state.active = true;
        state.order_key = Some(self.order_key);
        state.occurred_at_ms = Some(self.now.wall_ms);
        if state.acked {
            // 確認済みから発生: 新しい回。
            state.occurrence = Some(self.ids.next_occurrence());
            state.recurrence = 0;
            state.acked = !spec.ack_mode.requires_ack();
            let sound = match spec.ack_mode {
                AckMode::Manual | AckMode::AutoOnReturn => Sound::Continuous,
                AckMode::NoneWithSound => Sound::Once,
                AckMode::None => Sound::Silent,
            };
            self.push(Some((id, state)), EventKind::Occurred { sound, judgement });
        } else {
            // 未確認のまま復帰した回の再発生: 同じ回のまま。
            state.recurrence = state.recurrence.saturating_add(1);
            self.push(
                Some((id, state)),
                EventKind::Reoccurred {
                    sound: Sound::Continuous,
                    judgement,
                },
            );
        }
    }

    fn return_to_normal(&mut self, id: &str, spec: &ConditionSpec, state: &mut ConditionState) {
        let judgement = judgement(spec, state);
        state.active = false;
        self.push(Some((id, state)), EventKind::Returned { judgement });
        if spec.ack_mode == AckMode::AutoOnReturn && !state.acked {
            state.acked = true;
            self.push(Some((id, state)), EventKind::AutoAcked);
        }
    }

    fn ack(
        &mut self,
        id: &str,
        state: &mut ConditionState,
        occurrence: &str,
        recurrence: u32,
        user: &str,
    ) -> AckOutcome {
        if state.occurrence.as_deref() != Some(occurrence) || state.recurrence != recurrence {
            return AckOutcome::OtherOccurrence;
        }
        if state.acked {
            return AckOutcome::AlreadyAcked;
        }
        state.acked = true;
        self.push(
            Some((id, state)),
            EventKind::Acked {
                user: user.to_owned(),
            },
        );
        AckOutcome::Accepted
    }
}

fn classify(spec: &ConditionSpec, sample: &Sample) -> Result<Observation, Unavailable> {
    if !sample.resolved {
        return Err(Unavailable::Unresolved);
    }
    match sample.quality {
        Quality::Bad => return Err(Unavailable::Bad),
        Quality::Stale => return Err(Unavailable::Stale),
        Quality::Good => {}
    }
    let Some(value) = &sample.value else {
        return Err(Unavailable::NoValue);
    };
    match (&spec.source, value) {
        (Source::Threshold { .. }, TagValue::Number(number)) if !number.is_finite() => {
            Err(Unavailable::NonFinite)
        }
        (Source::Threshold { .. }, TagValue::Number(_))
        | (Source::Bit { .. }, TagValue::Bool(_)) => Ok(Observation {
            value: value.clone(),
            source_timestamp_ms: sample.source_timestamp_ms,
        }),
        _ => Err(Unavailable::TypeMismatch),
    }
}

/// 条件が成立しているか（設計§4.2）。発生と継続の両方で等号を含める。
fn holds(spec: &ConditionSpec, active: bool, value: &TagValue) -> bool {
    match (&spec.source, value) {
        (
            Source::Threshold {
                limit,
                value: bound,
                deadband,
                ..
            },
            TagValue::Number(number),
        ) => {
            let band = if active { *deadband } else { 0.0 };
            if limit.is_upper() {
                *number >= bound - band
            } else {
                *number <= bound + band
            }
        }
        (Source::Bit { active_when, .. }, TagValue::Bool(bit)) => bit == active_when,
        _ => false,
    }
}

fn judgement(spec: &ConditionSpec, state: &ConditionState) -> Judgement {
    let (limit, deadband) = match &spec.source {
        Source::Threshold {
            value, deadband, ..
        } => (Some(*value), Some(*deadband)),
        Source::Bit { .. } => (None, None),
    };
    Judgement {
        limit,
        deadband,
        value: state.observation.as_ref().map(|o| o.value.clone()),
        source_timestamp_ms: state
            .observation
            .as_ref()
            .and_then(|o| o.source_timestamp_ms),
    }
}
