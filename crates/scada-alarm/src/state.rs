//! condition の状態（設計§4.1）と、入力の値（§4.2）・評価不能の理由（§4.5）。

use serde::{Deserialize, Serialize};

/// Hub の品質。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Quality {
    Good,
    Stale,
    Bad,
}

/// 届いた値。数値と bool 以外の型は `Text` で表す（どの定義でも型不一致になる）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TagValue {
    Bool(bool),
    Number(f64),
    Text(String),
}

/// 1 つのタグについて届いた値（設計§4.2 の「値」の入力）。
#[derive(Clone, Debug, PartialEq)]
pub struct Sample {
    /// catalog でタグの外部名を解決できたか。
    pub resolved: bool,
    pub quality: Quality,
    pub value: Option<TagValue>,
    /// Hub の source timestamp（参考。判定・並びには使わない）。
    pub source_timestamp_ms: Option<i64>,
}

/// 判定に使った値。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub value: TagValue,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub source_timestamp_ms: Option<i64>,
}

/// condition 単位の評価不能の理由（設計§4.5）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Unavailable {
    /// 初期値待ち。状態と表示だけで、イベントは書かない。
    InitialValue,
    /// 更新停止（品質 Stale）。
    Stale,
    /// 不良（品質 Bad）。
    Bad,
    /// 未解決（catalog に無い）。
    Unresolved,
    /// 値なし（Good だが値が無い）。
    NoValue,
    /// 型不一致。
    TypeMismatch,
    /// 非有限（NaN・無限大）。
    NonFinite,
}

impl Unavailable {
    /// 始まりと終わりのイベントを書く理由なら true（初期値待ちだけは書かない）。
    pub fn is_reported(self) -> bool {
        self != Unavailable::InitialValue
    }
}

/// Engine 単位の評価不能の理由（設計§4.5）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EngineUnavailable {
    /// 未接続（SDK の接続が Live でない）。
    Disconnected,
    /// 受信の途絶。
    ReceiveLost,
}

/// 待ち。満了の時刻は単調時計（ms）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Timer {
    /// 発生待ち（on delay）。
    #[serde(rename_all = "camelCase")]
    OnDelay { due_ms: u64 },
    /// 復帰待ち（off delay）。
    #[serde(rename_all = "camelCase")]
    OffDelay { due_ms: u64 },
}

impl Timer {
    pub fn due_ms(self) -> u64 {
        match self {
            Timer::OnDelay { due_ms } | Timer::OffDelay { due_ms } => due_ms,
        }
    }
}

/// 発生（再発生）の順の鍵 (session の世代番号, Engine の変更の連番)（設計§4.4）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderKey {
    pub generation: u64,
    pub seq: u64,
}

/// 表示の状態（設計§4.1 の表）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DisplayState {
    Normal,
    Pending,
    ActiveUnacked,
    ActiveAcked,
    ReturnedUnacked,
}

/// 1 つの condition の状態（設計§4.1）。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionState {
    pub active: bool,
    pub occurrence: Option<String>,
    pub recurrence: u32,
    pub acked: bool,
    pub timer: Option<Timer>,
    /// condition 単位の評価不能の理由（いまの状態）。
    pub unavailable: Option<Unavailable>,
    /// 始まりのイベントを書いたまま、終わりをまだ書いていない理由。初期値待ちのあいだも
    /// 前の理由を開いたまま持ち、次の値が届いたときに終わり・始まりを書く（設計§4.5）。
    pub reported_unavailable: Option<Unavailable>,
    pub order_key: Option<OrderKey>,
    pub occurred_at_ms: Option<i64>,
    /// いまの判定に使っている値（イベントに残す）。評価不能のあいだは無い。
    pub observation: Option<Observation>,
    /// 値を受けたか復元したか。復元は、どちらもしていない condition にだけ当てる。
    #[serde(skip)]
    pub(crate) started: bool,
}

impl ConditionState {
    /// 新しい condition。Normal で、最初の値が届くまで初期値待ち。
    pub fn initial() -> Self {
        Self {
            active: false,
            occurrence: None,
            recurrence: 0,
            acked: true,
            timer: None,
            unavailable: Some(Unavailable::InitialValue),
            reported_unavailable: None,
            order_key: None,
            occurred_at_ms: None,
            observation: None,
            started: false,
        }
    }

    pub fn display(&self) -> DisplayState {
        match (self.active, self.acked) {
            (true, false) => DisplayState::ActiveUnacked,
            (true, true) => DisplayState::ActiveAcked,
            (false, false) => DisplayState::ReturnedUnacked,
            (false, true) => match self.timer {
                Some(Timer::OnDelay { .. }) => DisplayState::Pending,
                _ => DisplayState::Normal,
            },
        }
    }

    /// ReturnedUnacked で発生待ち（「再発生待ち」を添える）なら true。
    pub fn awaiting_reoccurrence(&self) -> bool {
        !self.active && !self.acked && matches!(self.timer, Some(Timer::OnDelay { .. }))
    }

    /// 画面へ知らせる値が同じか（`observation` の更新だけでは変更として数えない）。
    pub(crate) fn visibly_equal(&self, other: &Self) -> bool {
        self.active == other.active
            && self.occurrence == other.occurrence
            && self.recurrence == other.recurrence
            && self.acked == other.acked
            && self.timer == other.timer
            && self.unavailable == other.unavailable
            && self.order_key == other.order_key
            && self.occurred_at_ms == other.occurred_at_ms
    }

    /// 「最後の状態」の行に書く値（設計§5.4）。待ちと判定に使った値は持たない。
    pub fn to_last_state(&self) -> LastState {
        LastState {
            active: self.active,
            occurrence: self.occurrence.clone(),
            recurrence: self.recurrence,
            acked: self.acked,
            unavailable: self
                .unavailable
                .filter(|reason| reason.is_reported())
                .or(self.reported_unavailable),
            order_key: self.order_key,
            occurred_at_ms: self.occurred_at_ms,
        }
    }
}

/// 「最後の状態」の行のうち、状態機械が引き継ぐ値（入力の「復元」）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastState {
    pub active: bool,
    #[serde(default)]
    pub occurrence: Option<String>,
    #[serde(default)]
    pub recurrence: u32,
    pub acked: bool,
    #[serde(default)]
    pub unavailable: Option<Unavailable>,
    #[serde(default)]
    pub order_key: Option<OrderKey>,
    #[serde(default)]
    pub occurred_at_ms: Option<i64>,
}
