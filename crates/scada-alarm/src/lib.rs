//! 警報の状態機械（段階3-A。設計: `docs/design/runtime/alarm-stage3-design.md`§4）。
//!
//! 入出力を持たない純粋な状態機械。`Engine::step(時刻, 入力)` が次の状態とイベントを返し、
//! host が警報 DB に書けたら `Engine::commit` で確定する。時刻・新しい occurrence の id・
//! session の世代番号は host が渡し、crate は時計・乱数・番号の採番元を持たない（Engine の
//! 変更の連番だけは状態の一部として持つ）。全遷移の正本は `examples/alarm-cases.json`。

mod engine;
mod spec;
mod state;

pub use engine::{
    AckOutcome, Condition, DefineError, EndReason, Engine, Event, EventKind, Input, Judgement, Now,
    OccurrenceIds, Session, Sound, StepError, Transition,
};
pub use spec::{AckMode, ConditionSpec, LimitKind, Source, SpecError, MAX_DELAY_MS};
pub use state::{
    ConditionState, DisplayState, EngineUnavailable, LastState, Observation, OrderKey, Quality,
    Sample, TagValue, Timer, Unavailable,
};
