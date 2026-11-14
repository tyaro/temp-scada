//! `examples/alarm-cases.json`（警報の状態機械の正本）を当てる。
//!
//! 各 step の入力を `Engine::step` に当て、イベント（並びと件数は完全一致、各イベントは
//! fixture に書いた項目だけを比べる）・condition の状態（書いた項目だけ）・ACK の結果・
//! Engine の変更の連番を確かめてから `commit` する。最後に、状態×入力の組がすべて
//! fixture に現れることを確かめる（設計§4 の「全入力×全状態の遷移表」）。

use std::collections::{BTreeMap, BTreeSet};

use scada_alarm::{
    AckMode, ConditionSpec, Engine, EngineUnavailable, Input, LastState, Now, Quality, Sample,
    Session, Source, TagValue, Timer, Unavailable,
};
use serde_json::{json, Value};

const CASES: &str = include_str!("../../../examples/alarm-cases.json");

fn number(value: &Value) -> Option<f64> {
    value.as_f64()
}

/// expected の項目がすべて actual にあり、等しいか（数値は f64 で比べる）。`null` を期待した
/// 項目も、actual にその項目が無ければ合わない。
fn subset(expected: &Value, actual: &Value) -> bool {
    match (expected, actual) {
        (Value::Object(expected), Value::Object(actual)) => expected
            .iter()
            .all(|(key, value)| actual.get(key).is_some_and(|actual| subset(value, actual))),
        (Value::Array(expected), Value::Array(actual)) => {
            expected.len() == actual.len() && expected.iter().zip(actual).all(|(e, a)| subset(e, a))
        }
        (Value::Number(_), Value::Number(_)) => number(expected) == number(actual),
        _ => expected == actual,
    }
}

fn tag_value(value: &Value) -> TagValue {
    match value {
        Value::Bool(bit) => TagValue::Bool(*bit),
        Value::Number(_) => TagValue::Number(value.as_f64().unwrap()),
        Value::String(text) => match text.as_str() {
            "NaN" => TagValue::Number(f64::NAN),
            "Infinity" => TagValue::Number(f64::INFINITY),
            "-Infinity" => TagValue::Number(f64::NEG_INFINITY),
            _ => TagValue::Text(text.clone()),
        },
        other => panic!("値にできない: {other}"),
    }
}

fn input(value: &Value) -> Input {
    let text = |key: &str| {
        value[key]
            .as_str()
            .unwrap_or_else(|| panic!("{key} が無い: {value}"))
            .to_owned()
    };
    match value["kind"].as_str().unwrap() {
        "value" => Input::Value {
            tag: text("tag"),
            sample: Sample {
                resolved: value["resolved"].as_bool().unwrap_or(true),
                quality: match value["quality"].as_str().unwrap_or("good") {
                    "good" => Quality::Good,
                    "stale" => Quality::Stale,
                    "bad" => Quality::Bad,
                    other => panic!("品質: {other}"),
                },
                value: value.get("value").map(tag_value),
                source_timestamp_ms: value["sourceTimestampMs"].as_i64(),
            },
        },
        "timer" => Input::TimerExpired,
        "ack" => Input::Ack {
            condition: text("condition"),
            occurrence: text("occurrence"),
            recurrence: value["recurrence"].as_u64().unwrap() as u32,
            user: text("user"),
        },
        "engine" => Input::EngineAvailability {
            unavailable: serde_json::from_value(value["unavailable"].clone()).unwrap(),
        },
        "end" => Input::EndCondition {
            condition: text("condition"),
            reason: serde_json::from_value(value["reason"].clone()).unwrap(),
        },
        "restore" => Input::Restore {
            condition: text("condition"),
            row: serde_json::from_value::<LastState>(value["row"].clone()).unwrap(),
        },
        other => panic!("入力の種類: {other}"),
    }
}

fn state_json(engine: &Engine, id: &str) -> Value {
    match engine.condition(id) {
        None => Value::Null,
        Some(condition) => {
            let mut value = serde_json::to_value(&condition.state).unwrap();
            value["display"] = serde_json::to_value(condition.state.display()).unwrap();
            value["awaitingReoccurrence"] = json!(condition.state.awaiting_reoccurrence());
            value
        }
    }
}

fn error_code(error: &scada_alarm::StepError) -> &'static str {
    match error {
        scada_alarm::StepError::UnknownCondition(_) => "unknownCondition",
        scada_alarm::StepError::InvalidLastState(_) => "invalidLastState",
        scada_alarm::StepError::AlreadyStarted(_) => "alreadyStarted",
    }
}

// ---- 網羅の分類（試験の側の独立した判定。crate の実装を呼ばない） ----

fn state_class(engine: &Engine, id: &str) -> &'static str {
    if engine.unavailable().is_some() {
        return "engineUnavailable";
    }
    let state = &engine.condition(id).unwrap().state;
    match state.unavailable {
        Some(Unavailable::InitialValue) => return "initialValue",
        Some(_) => return "unavailable",
        None => {}
    }
    match (state.active, state.acked, state.timer) {
        (false, true, None) => "normal",
        (false, true, Some(Timer::OnDelay { .. })) => "pending",
        (true, false, None) => "activeUnacked",
        (true, true, None) => "activeAcked",
        (true, false, Some(Timer::OffDelay { .. })) => "returningUnacked",
        (true, true, Some(Timer::OffDelay { .. })) => "returningAcked",
        (false, false, None) => "returnedUnacked",
        (false, false, Some(Timer::OnDelay { .. })) => "returnedPending",
        other => panic!("ありえない状態: {other:?}"),
    }
}

fn oracle_holds(spec: &ConditionSpec, active: bool, value: &TagValue) -> bool {
    match (&spec.source, value) {
        (
            Source::Threshold {
                limit,
                value: bound,
                deadband,
                ..
            },
            TagValue::Number(n),
        ) => {
            let band = if active { *deadband } else { 0.0 };
            if limit.is_upper() {
                *n >= *bound - band
            } else {
                *n <= *bound + band
            }
        }
        (Source::Bit { active_when, .. }, TagValue::Bool(b)) => b == active_when,
        _ => false,
    }
}

/// 入力の分類と、その入力が当たる condition の組。
fn classify(engine: &Engine, now: Now, input: &Input) -> Vec<(String, &'static str)> {
    let mut out = Vec::new();
    match input {
        Input::Value { tag, sample } => {
            for (id, condition) in engine.conditions() {
                if condition.spec.source.tag() != tag {
                    continue;
                }
                let usable = sample.resolved
                    && sample.quality == Quality::Good
                    && match (&condition.spec.source, &sample.value) {
                        (Source::Threshold { .. }, Some(TagValue::Number(n))) => n.is_finite(),
                        (Source::Bit { .. }, Some(TagValue::Bool(_))) => true,
                        _ => false,
                    };
                let class = if !usable {
                    "valueUnavailable"
                } else if oracle_holds(
                    &condition.spec,
                    condition.state.active,
                    sample.value.as_ref().unwrap(),
                ) {
                    "valueHolds"
                } else {
                    "valueClears"
                };
                out.push((id.clone(), class));
            }
        }
        Input::TimerExpired => {
            for (id, condition) in engine.conditions() {
                if condition
                    .state
                    .timer
                    .is_some_and(|t| t.due_ms() <= now.mono_ms)
                {
                    out.push((id.clone(), "timer"));
                }
            }
        }
        Input::Ack {
            condition,
            occurrence,
            recurrence,
            ..
        } => {
            if let Some(current) = engine.condition(condition) {
                let same = current.state.occurrence.as_deref() == Some(occurrence.as_str())
                    && current.state.recurrence == *recurrence;
                out.push((
                    condition.clone(),
                    if same { "ackCurrent" } else { "ackOther" },
                ));
            }
        }
        Input::EngineAvailability { unavailable } => {
            let class = if unavailable.is_some() {
                "engineLost"
            } else {
                "engineRestored"
            };
            for id in engine.conditions().keys() {
                out.push((id.clone(), class));
            }
        }
        Input::EndCondition { condition, .. } => {
            if engine.condition(condition).is_some() {
                out.push((condition.clone(), "end"));
            }
        }
        Input::Restore { condition, .. } => {
            if engine.condition(condition).is_some() {
                out.push((condition.clone(), "restore"));
            }
        }
    }
    out
}

fn required_pairs() -> BTreeSet<(&'static str, &'static str)> {
    let mut pairs = BTreeSet::new();
    let condition_states = [
        "initialValue",
        "normal",
        "pending",
        "activeUnacked",
        "activeAcked",
        "returningUnacked",
        "returningAcked",
        "returnedUnacked",
        "returnedPending",
        "unavailable",
    ];
    for state in condition_states {
        for input in ["valueHolds", "valueClears", "valueUnavailable"] {
            pairs.insert((state, input));
        }
    }
    for input in [
        "valueHolds",
        "valueClears",
        "valueUnavailable",
        "ackCurrent",
        "engineRestored",
    ] {
        pairs.insert(("engineUnavailable", input));
    }
    for state in [
        "pending",
        "returningUnacked",
        "returningAcked",
        "returnedPending",
    ] {
        pairs.insert((state, "timer"));
    }
    for state in [
        "activeUnacked",
        "activeAcked",
        "returningUnacked",
        "returnedUnacked",
        "returnedPending",
        "unavailable",
    ] {
        pairs.insert((state, "ackCurrent"));
    }
    for state in ["activeUnacked", "returnedUnacked"] {
        pairs.insert((state, "ackOther"));
    }
    for state in [
        "normal",
        "pending",
        "activeUnacked",
        "activeAcked",
        "returningUnacked",
        "returnedUnacked",
        "returnedPending",
        "unavailable",
    ] {
        pairs.insert((state, "engineLost"));
    }
    for state in [
        "normal",
        "pending",
        "activeUnacked",
        "activeAcked",
        "returnedUnacked",
    ] {
        pairs.insert((state, "end"));
    }
    pairs.insert(("initialValue", "restore"));
    pairs
}

#[test]
fn alarm_cases_match_the_state_machine() {
    let root: Value = serde_json::from_str(CASES).unwrap();
    let wall_base = root["wallBaseMs"].as_i64().unwrap();
    let mut covered: BTreeSet<(&'static str, &'static str)> = BTreeSet::new();
    let mut occurred_modes: BTreeSet<String> = BTreeSet::new();
    let mut returned_modes: BTreeSet<String> = BTreeSet::new();
    let mut names = BTreeSet::new();

    for case in root["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        assert!(names.insert(name.to_owned()), "名前の重複: {name}");
        let mut engine = Engine::new(Session {
            id: "s-1".into(),
            generation: case["generation"].as_u64().unwrap_or(1),
        });
        let mut modes: BTreeMap<String, AckMode> = BTreeMap::new();
        for (id, spec) in case["conditions"].as_object().unwrap() {
            let spec: ConditionSpec = serde_json::from_value(spec.clone())
                .unwrap_or_else(|e| panic!("{name}: {id} の定義: {e}"));
            modes.insert(id.clone(), spec.ack_mode);
            engine.define(id.clone(), spec).unwrap();
        }
        let mut next_id = 0;
        let mut ids = move || {
            next_id += 1;
            format!("occ-{next_id}")
        };

        for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let at = step["at"].as_u64().unwrap_or(0);
            let now = Now {
                mono_ms: at,
                wall_ms: wall_base + at as i64,
            };
            let input = input(&step["input"]);
            let label = format!("{name} の step {} ({})", index + 1, step["input"]);
            for (id, class) in classify(&engine, now, &input) {
                covered.insert((state_class(&engine, &id), class));
            }

            let transition = match engine.step(now, &input, &mut ids) {
                Ok(transition) => {
                    assert!(step.get("error").is_none(), "{label}: 失敗するはず");
                    transition
                }
                Err(error) => {
                    assert_eq!(
                        step["error"].as_str(),
                        Some(error_code(&error)),
                        "{label}: {error}"
                    );
                    continue;
                }
            };

            let events = serde_json::to_value(&transition.events).unwrap();
            let expected_events = step.get("events").cloned().unwrap_or(json!([]));
            assert!(
                subset(&expected_events, &events),
                "{label}: イベント\n期待: {expected_events}\n実際: {events}"
            );
            for event in &transition.events {
                let mode = event.condition.as_ref().and_then(|id| modes.get(id));
                match (&event.kind, mode) {
                    (scada_alarm::EventKind::Occurred { .. }, Some(mode)) => {
                        occurred_modes.insert(format!("{mode:?}"));
                    }
                    (scada_alarm::EventKind::Returned { .. }, Some(mode)) => {
                        returned_modes.insert(format!("{mode:?}"));
                    }
                    _ => {}
                }
            }
            match step.get("ack") {
                Some(expected) => assert_eq!(
                    &serde_json::to_value(transition.ack).unwrap(),
                    expected,
                    "{label}: ACK の結果"
                ),
                None => assert!(transition.ack.is_none(), "{label}: ACK の結果が無いはず"),
            }
            if let Some(seq) = step.get("seq") {
                assert_eq!(Some(transition.seq), seq.as_u64(), "{label}: 連番");
            }
            assert_eq!(
                transition.changed,
                transition.seq != engine.seq(),
                "{label}: 変更と連番"
            );
            engine.commit(transition);

            if let Some(expected) = step.get("engineUnavailable") {
                let expected: Option<EngineUnavailable> =
                    serde_json::from_value(expected.clone()).unwrap();
                assert_eq!(engine.unavailable(), expected, "{label}: Engine 単位");
            }
            if let Some(states) = step.get("states") {
                for (id, expected) in states.as_object().unwrap() {
                    let actual = state_json(&engine, id);
                    assert!(
                        subset(expected, &actual),
                        "{label}: {id} の状態\n期待: {expected}\n実際: {actual}"
                    );
                }
            }
        }
    }

    let missing: Vec<_> = required_pairs().difference(&covered).copied().collect();
    assert!(missing.is_empty(), "fixture に無い状態×入力: {missing:?}");
    for mode in ["Manual", "AutoOnReturn", "None", "NoneWithSound"] {
        assert!(
            occurred_modes.contains(mode),
            "{mode} の発生が fixture に無い"
        );
        assert!(
            returned_modes.contains(mode),
            "{mode} の復帰が fixture に無い"
        );
    }
}

#[test]
fn evaluation_key_ignores_display_and_tracks_evaluation() {
    let spec = |value: f64, mode: AckMode| ConditionSpec {
        source: Source::Threshold {
            tag: "PLANT.T101.PV".into(),
            limit: scada_alarm::LimitKind::Hh,
            value,
            deadband: 1.0,
        },
        on_delay_ms: 0,
        off_delay_ms: 0,
        ack_mode: mode,
    };
    let base = spec(95.0, AckMode::Manual);
    assert_eq!(
        base.evaluation_key(),
        spec(95.0, AckMode::Manual).evaluation_key()
    );
    assert_ne!(
        base.evaluation_key(),
        spec(95.5, AckMode::Manual).evaluation_key()
    );
    assert_ne!(
        base.evaluation_key(),
        spec(95.0, AckMode::AutoOnReturn).evaluation_key()
    );
    let bit = |tag: &str| ConditionSpec {
        source: Source::Bit {
            tag: tag.into(),
            active_when: true,
        },
        on_delay_ms: 0,
        off_delay_ms: 0,
        ack_mode: AckMode::Manual,
    };
    // 区切り文字を含むタグ名でも別の定義と同じ鍵にならない。
    assert_ne!(bit("A|1:B").evaluation_key(), bit("A").evaluation_key());
}

#[test]
fn spec_validation_rejects_bad_values() {
    let threshold = |value: f64, deadband: f64, on: u64| ConditionSpec {
        source: Source::Threshold {
            tag: "T".into(),
            limit: scada_alarm::LimitKind::L,
            value,
            deadband,
        },
        on_delay_ms: on,
        off_delay_ms: 0,
        ack_mode: AckMode::Manual,
    };
    assert!(threshold(1.0, 0.0, 600_000).validate().is_ok());
    assert!(threshold(f64::NAN, 0.0, 0).validate().is_err());
    assert!(threshold(1.0, -0.5, 0).validate().is_err());
    assert!(threshold(1.0, f64::INFINITY, 0).validate().is_err());
    assert!(threshold(1.0, 0.0, 600_001).validate().is_err());
    let mut engine = Engine::new(Session {
        id: "s".into(),
        generation: 1,
    });
    assert!(engine.define("a", threshold(1.0, 0.0, 0)).is_ok());
    assert!(engine.define("a", threshold(1.0, 0.0, 0)).is_err());
    assert!(engine.define("b", threshold(1.0, -1.0, 0)).is_err());
}

#[test]
fn last_state_round_trips_and_keeps_the_open_reason() {
    let mut engine = Engine::new(Session {
        id: "s".into(),
        generation: 2,
    });
    engine
        .define(
            "a",
            ConditionSpec {
                source: Source::Bit {
                    tag: "B".into(),
                    active_when: true,
                },
                on_delay_ms: 0,
                off_delay_ms: 0,
                ack_mode: AckMode::Manual,
            },
        )
        .unwrap();
    let mut ids = || "occ".to_owned();
    let now = Now {
        mono_ms: 10,
        wall_ms: 1_000,
    };
    let value = |bit: Option<bool>, quality: Quality| Input::Value {
        tag: "B".into(),
        sample: Sample {
            resolved: true,
            quality,
            value: bit.map(TagValue::Bool),
            source_timestamp_ms: None,
        },
    };
    let t = engine
        .step(now, &value(Some(true), Quality::Good), &mut ids)
        .unwrap();
    engine.commit(t);
    let t = engine
        .step(now, &value(None, Quality::Bad), &mut ids)
        .unwrap();
    engine.commit(t);
    // Engine 単位の評価不能が解けて初期値待ちになっても、開いた理由は行に残る。
    for unavailable in [Some(EngineUnavailable::Disconnected), None] {
        let t = engine
            .step(now, &Input::EngineAvailability { unavailable }, &mut ids)
            .unwrap();
        engine.commit(t);
    }
    let row = engine.condition("a").unwrap().state.to_last_state();
    assert_eq!(row.unavailable, Some(Unavailable::Bad));
    assert!(row.active && !row.acked);
    assert_eq!(row.occurrence.as_deref(), Some("occ"));
    let text = serde_json::to_string(&row).unwrap();
    assert_eq!(serde_json::from_str::<LastState>(&text).unwrap(), row);
}
