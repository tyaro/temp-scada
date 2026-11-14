use super::*;
use crate::alarm_terminal::AlarmTerminal;
use scada_alarm::{AckMode, Source, Unavailable};

fn temp_dir() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("alarm-db-{}%-data", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn project_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn applied(id: &str, hash: &str) -> AppliedDefinitions {
    AppliedDefinitions {
        project_id: id.into(),
        project_revision: 3,
        file_hash: hash.into(),
        endpoint: "http://127.0.0.1:8722".into(),
        applied_by: "未ログイン".into(),
        applied_at_ms: 100,
        definitions: json!({"definitions": []}),
        condition_hashes: BTreeMap::from([("condition:hh".into(), "eval-hash".into())]),
        displays: BTreeMap::from([(
            "condition:hh".into(),
            ConditionDisplay {
                name: "T-101".into(),
                message: "高温".into(),
                severity: "high".into(),
                limit_label: Some("HH".into()),
            },
        )]),
    }
}

fn state(session_id: &str) -> LastRow {
    LastRow {
        condition_id: "condition:hh".into(),
        evaluation_hash: "eval-hash".into(),
        endpoint: "http://127.0.0.1:8722".into(),
        state: LastState {
            active: true,
            occurrence: Some("occurrence-1".into()),
            recurrence: 0,
            acked: false,
            unavailable: None,
            order_key: None,
            occurred_at_ms: Some(120),
        },
        session_id: session_id.into(),
        last_event_seq: None,
    }
}

#[test]
fn disabled_condition_ends_as_definition_change() {
    let mut applied = applied(&project_id(), "applied");
    applied.condition_hashes.clear();
    applied.displays.clear();
    let plan = plan_restore(
        Session {
            id: "new".into(),
            generation: 2,
        },
        "http://127.0.0.1:8722",
        200,
        &applied,
        &BTreeMap::new(),
        &BTreeSet::from(["condition:hh".into()]),
        &[state("old")],
    )
    .unwrap();
    assert_eq!(plan.ended[0].kind, "definitionChanged");
}

#[tokio::test]
async fn session_plan_rechecks_the_full_applied_hash_set_in_its_transaction() {
    let dir = temp_dir();
    let terminal = AlarmTerminal::open(&dir).await.unwrap();
    let id = project_id();
    let db = AlarmDb::open(&terminal, &id).await.unwrap();
    let mut empty = applied(&id, "empty");
    empty.condition_hashes.clear();
    empty.displays.clear();
    db.apply(&empty, None, &[], &[]).await.unwrap();
    let first = Session {
        id: "first".into(),
        generation: 1,
    };
    let plan = plan_restore(
        first.clone(),
        &empty.endpoint,
        100,
        &empty,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &[],
    )
    .unwrap();
    let engine = db.start_session_plan(plan, 100).await.unwrap();
    assert_eq!(engine.session(), &first);
    let second = Session {
        id: "second".into(),
        generation: 2,
    };
    let stale_plan = plan_restore(
        second.clone(),
        &empty.endpoint,
        200,
        &empty,
        &BTreeMap::new(),
        &BTreeSet::new(),
        &[],
    )
    .unwrap();
    db.apply(&applied(&id, "new"), Some(&first), &[], &[])
        .await
        .unwrap();
    assert!(matches!(
        db.start_session_plan(stale_plan, 200).await,
        Err(AlarmDbError::InvalidRow)
    ));
    assert_eq!(db.session().await.unwrap().unwrap().session, first);
    db.close().await;
    drop(terminal);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_crash_records_the_previous_state_and_unknown_period_before_restoring() {
    let dir = temp_dir();
    let terminal = AlarmTerminal::open(&dir).await.unwrap();
    let id = project_id();
    let db = AlarmDb::open(&terminal, &id).await.unwrap();
    let mut applied = applied(&id, "file-a");
    applied
        .condition_hashes
        .insert("condition:hh".into(), "eval-hash".into());
    db.apply(&applied, None, &[], &[]).await.unwrap();
    let first = Session {
        id: "session-1".into(),
        generation: 1,
    };
    db.start_session(&first, 100, &[], &[]).await.unwrap();
    db.append(
        &first,
        &[EventWrite {
            at_ms: 120,
            condition_id: Some("condition:hh".into()),
            kind: "occurred".into(),
            detail: json!({"value": 95}),
        }],
        &[state(&first.id)],
        &[],
        Some(Some(EngineUnavailable::Disconnected)),
    )
    .await
    .unwrap();
    db.append(
        &first,
        &[EventWrite {
            at_ms: 80,
            condition_id: None,
            kind: "clockMovedBack".into(),
            detail: Value::Null,
        }],
        &[],
        &[],
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        db.session().await.unwrap().unwrap().engine_unavailable,
        Some(EngineUnavailable::Disconnected)
    );
    let previous = db.last_states().await.unwrap();
    assert!(previous[0].last_event_seq.is_some());
    db.close().await; // a process ended without a normal stop

    let db = AlarmDb::open(&terminal, &id).await.unwrap();
    let second = Session {
        id: "session-2".into(),
        generation: 2,
    };
    db.start_session(&second, 200, &[], &previous)
        .await
        .unwrap();
    assert_eq!(db.applied().await.unwrap().unwrap().file_hash, "file-a");
    assert_eq!(db.session().await.unwrap().unwrap().session, second);
    assert_eq!(db.last_states().await.unwrap()[0].session_id, second.id);
    let events = db.events().await.unwrap();
    let kinds: Vec<_> = events
        .iter()
        .map(|event| event.event.kind.as_str())
        .collect();
    assert_eq!(
        kinds,
        [
            "engineStarted",
            "occurred",
            "clockMovedBack",
            "previousSessionState",
            "previousEngineUnavailable",
            "unknownPeriod",
            "engineStarted"
        ]
    );
    assert_eq!(events[5].event.detail, json!({"fromMs": 80, "toMs": 200}));
    db.append(
        &second,
        &[],
        &[],
        &[],
        Some(Some(EngineUnavailable::Disconnected)),
    )
    .await
    .unwrap();
    db.stop_session(&second, 250).await.unwrap();
    assert!(db
        .events()
        .await
        .unwrap()
        .iter()
        .any(|event| event.event.kind == "stoppedEngineUnavailable"));
    let third = Session {
        id: "session-3".into(),
        generation: 3,
    };
    db.start_session(&third, 300, &[], &db.last_states().await.unwrap())
        .await
        .unwrap();
    assert_eq!(
        db.events()
            .await
            .unwrap()
            .iter()
            .filter(|event| event.event.kind == "unknownPeriod")
            .count(),
        1
    );
    db.close().await;
    drop(terminal);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn failed_apply_leaves_definition_events_and_states_together() {
    let dir = temp_dir();
    let terminal = AlarmTerminal::open(&dir).await.unwrap();
    let id = project_id();
    let db = AlarmDb::open(&terminal, &id).await.unwrap();
    let mut original = applied(&id, "original");
    original
        .condition_hashes
        .insert("condition:hh".into(), "eval-hash".into());
    db.apply(&original, None, &[], &[]).await.unwrap();
    let session = Session {
        id: "session-1".into(),
        generation: 1,
    };
    db.start_session(&session, 100, &[], &[]).await.unwrap();
    let row = state(&session.id);
    db.append(&session, &[], std::slice::from_ref(&row), &[], None)
        .await
        .unwrap();
    sqlx::query("CREATE TRIGGER fail_candidate BEFORE UPDATE ON applied BEGIN SELECT RAISE(ABORT, 'full'); END")
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(db
        .apply(
            &applied(&id, "candidate"),
            Some(&session),
            &[EventWrite {
                at_ms: 200,
                condition_id: Some(row.condition_id.clone()),
                kind: "definitionChanged".into(),
                detail: json!({"unacked": true, "previous": row.state}),
            }],
            &[],
        )
        .await
        .is_err());
    assert_eq!(db.applied().await.unwrap().unwrap().file_hash, "original");
    assert_eq!(db.events().await.unwrap().len(), 1); // engineStarted only
    assert_eq!(db.last_states().await.unwrap().len(), 1);
    db.close().await;
    drop(terminal);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn an_old_session_cannot_ack_after_a_new_session_starts() {
    let dir = temp_dir();
    let terminal = AlarmTerminal::open(&dir).await.unwrap();
    let id = project_id();
    let db = AlarmDb::open(&terminal, &id).await.unwrap();
    let mut original = applied(&id, "original");
    original
        .condition_hashes
        .insert("condition:hh".into(), "eval-hash".into());
    db.apply(&original, None, &[], &[]).await.unwrap();
    let first = Session {
        id: "first".into(),
        generation: 1,
    };
    db.start_session(&first, 1, &[], &[]).await.unwrap();
    db.append(
        &first,
        &[],
        &[],
        &[],
        Some(Some(EngineUnavailable::Disconnected)),
    )
    .await
    .unwrap();
    db.append(&first, &[], &[], &[], Some(None)).await.unwrap();
    assert_eq!(
        db.session().await.unwrap().unwrap().engine_unavailable,
        None
    );
    let second = Session {
        id: "second".into(),
        generation: 2,
    };
    db.start_session(&second, 2, &[], &[]).await.unwrap();
    db.append(
        &second,
        &[EventWrite {
            at_ms: 2,
            condition_id: Some("condition:hh".into()),
            kind: "occurred".into(),
            detail: Value::Null,
        }],
        &[state(&second.id)],
        &[],
        None,
    )
    .await
    .unwrap();
    let saved_seq = db.last_states().await.unwrap()[0].last_event_seq;
    let mut bogus_seq = state(&second.id);
    bogus_seq.last_event_seq = Some(999_999);
    db.append(&second, &[], &[bogus_seq], &[], None)
        .await
        .unwrap();
    assert_eq!(db.last_states().await.unwrap()[0].last_event_seq, saved_seq);
    assert!(matches!(
        db.append(&second, &[], &[], &["condition:hh".into()], None)
            .await,
        Err(AlarmDbError::InvalidRow)
    ));
    let mut foreign = state(&second.id);
    foreign.evaluation_hash = "different".into();
    assert!(matches!(
        db.append(&second, &[], &[foreign], &[], None).await,
        Err(AlarmDbError::InvalidRow)
    ));
    assert_eq!(
        db.last_states().await.unwrap()[0].evaluation_hash,
        "eval-hash"
    );
    assert!(db.append(&first, &[], &[], &[], None).await.is_err());
    assert!(db.start_session(&first, 3, &[], &[]).await.is_err());
    let mut candidate = applied(&id, "candidate");
    candidate
        .condition_hashes
        .insert("condition:hh".into(), "eval-hash".into());
    let mut survivor = db.last_states().await.unwrap().remove(0);
    survivor.session_id = "stale".into();
    assert!(matches!(
        db.apply(&candidate, Some(&first), &[], &[]).await,
        Err(AlarmDbError::InvalidRow)
    ));
    assert!(matches!(
        db.apply(&candidate, None, &[], &[]).await,
        Err(AlarmDbError::InvalidRow)
    ));
    assert!(matches!(
        db.apply(&candidate, Some(&second), &[], &[]).await,
        Err(AlarmDbError::InvalidRow)
    ));
    let mut wrong_hash = candidate.clone();
    wrong_hash
        .condition_hashes
        .insert("condition:hh".into(), "different".into());
    assert!(matches!(
        db.apply(
            &wrong_hash,
            Some(&second),
            &[],
            std::slice::from_ref(&survivor)
        )
        .await,
        Err(AlarmDbError::InvalidRow)
    ));
    let mut stale = survivor.clone();
    stale.state.acked = true;
    assert!(matches!(
        db.apply(&candidate, Some(&second), &[], &[stale]).await,
        Err(AlarmDbError::InvalidRow)
    ));
    db.apply(
        &candidate,
        Some(&second),
        &[],
        std::slice::from_ref(&survivor),
    )
    .await
    .unwrap();
    assert_eq!(db.last_states().await.unwrap()[0].session_id, second.id);
    db.stop_session(&second, 3).await.unwrap();
    db.apply(&candidate, None, &[], &[survivor]).await.unwrap();
    assert_eq!(db.applied().await.unwrap().unwrap().file_hash, "candidate");
    sqlx::query("UPDATE session SET stopped = 2 WHERE id = 1")
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(matches!(db.session().await, Err(AlarmDbError::InvalidRow)));
    assert!(matches!(
        db.start_session(
            &Session {
                id: "third".into(),
                generation: 3
            },
            3,
            &[],
            &[]
        )
        .await,
        Err(AlarmDbError::InvalidRow)
    ));
    db.close().await;
    drop(terminal);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn an_applied_definition_from_another_project_is_not_read_as_this_project() {
    let dir = temp_dir();
    let terminal = AlarmTerminal::open(&dir).await.unwrap();
    let id = project_id();
    let db = AlarmDb::open(&terminal, &id).await.unwrap();
    let mut missing_display = applied(&id, "missing-display");
    missing_display.displays.clear();
    assert!(matches!(
        db.apply(&missing_display, None, &[], &[]).await,
        Err(AlarmDbError::InvalidRow)
    ));
    let mut extra_display = applied(&id, "extra-display");
    let display = extra_display.displays["condition:hh"].clone();
    extra_display.displays.insert("extra".into(), display);
    assert!(matches!(
        db.apply(&extra_display, None, &[], &[]).await,
        Err(AlarmDbError::InvalidRow)
    ));
    let other = applied(&project_id(), "other");
    assert!(matches!(
        db.apply(&other, None, &[], &[]).await,
        Err(AlarmDbError::InvalidProjectId)
    ));
    sqlx::query("INSERT INTO applied (id, body) VALUES (1, ?)")
        .bind(serde_json::to_string(&other).unwrap())
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(matches!(db.applied().await, Err(AlarmDbError::InvalidRow)));
    db.close().await;
    drop(terminal);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn session_start_rejects_missing_or_stale_restore_rows() {
    let dir = temp_dir();
    let terminal = AlarmTerminal::open(&dir).await.unwrap();
    let id = project_id();
    let db = AlarmDb::open(&terminal, &id).await.unwrap();
    let mut original = applied(&id, "original");
    original
        .condition_hashes
        .insert("condition:hh".into(), "eval-hash".into());
    db.apply(&original, None, &[], &[]).await.unwrap();
    let old = Session {
        id: "old".into(),
        generation: 1,
    };
    db.start_session(&old, 100, &[], &[]).await.unwrap();
    db.append(&old, &[], &[state(&old.id)], &[], None)
        .await
        .unwrap();
    let saved = db.last_states().await.unwrap();
    let new = Session {
        id: "new".into(),
        generation: 2,
    };
    assert!(matches!(
        db.start_session(&new, 200, &[], &[]).await,
        Err(AlarmDbError::InvalidRow)
    ));
    let mut stale = saved[0].clone();
    stale.state.acked = true;
    assert!(matches!(
        db.start_session(&new, 200, &[], &[stale]).await,
        Err(AlarmDbError::InvalidRow)
    ));
    assert_eq!(db.events().await.unwrap().len(), 1); // failed starts left no evidence
    assert_eq!(db.session().await.unwrap().unwrap().session, old);
    db.start_session(&new, 200, &[], &saved).await.unwrap();
    db.close().await;
    drop(terminal);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn stopped_session_can_apply_and_attribute_ended_rows_to_it() {
    let dir = temp_dir();
    let terminal = AlarmTerminal::open(&dir).await.unwrap();
    let id = project_id();
    let db = AlarmDb::open(&terminal, &id).await.unwrap();
    let mut original = applied(&id, "original");
    original
        .condition_hashes
        .insert("condition:hh".into(), "eval-hash".into());
    db.apply(&original, None, &[], &[]).await.unwrap();
    let session = Session {
        id: "stopped".into(),
        generation: 1,
    };
    db.start_session(&session, 100, &[], &[]).await.unwrap();
    let row = state(&session.id);
    db.append(&session, &[], std::slice::from_ref(&row), &[], None)
        .await
        .unwrap();
    db.stop_session(&session, 150).await.unwrap();
    db.apply(
        &applied(&id, "next"),
        None,
        &[EventWrite {
            at_ms: 200,
            condition_id: Some(row.condition_id),
            kind: "definitionDeleted".into(),
            detail: json!({"unacked": true, "previous": row.state}),
        }],
        &[],
    )
    .await
    .unwrap();
    assert!(db.last_states().await.unwrap().is_empty());
    let last = db.events().await.unwrap().pop().unwrap();
    assert_eq!(last.session_id, session.id);
    assert_eq!(last.event.kind, "definitionDeleted");
    assert_eq!(last.display.unwrap().name, "T-101");
    db.close().await;
    drop(terminal);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn interrupted_old_project_closes_without_a_new_session_before_later_apply() {
    let dir = temp_dir();
    let terminal = AlarmTerminal::open(&dir).await.unwrap();
    let id = project_id();
    let db = AlarmDb::open(&terminal, &id).await.unwrap();
    let mut original = applied(&id, "original");
    original
        .condition_hashes
        .insert("condition:hh".into(), "eval-hash".into());
    db.apply(&original, None, &[], &[]).await.unwrap();
    let session = Session {
        id: "old".into(),
        generation: 1,
    };
    db.start_session(&session, 100, &[], &[]).await.unwrap();
    let row = state(&session.id);
    db.append(&session, &[], std::slice::from_ref(&row), &[], None)
        .await
        .unwrap();
    db.close_unstopped_session(200).await.unwrap();
    db.close_unstopped_session(210).await.unwrap(); // idempotent after switch retry
    assert!(db.session().await.unwrap().unwrap().stopped);
    let events = db.events().await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event.kind == "unknownPeriod")
            .count(),
        1
    );
    assert!(events
        .iter()
        .any(|event| event.event.kind == "previousSessionState"));
    let mut candidate = applied(&id, "candidate");
    candidate.displays.get_mut("condition:hh").unwrap().name = "改名後".into();
    db.apply(
        &candidate,
        None,
        &[EventWrite {
            at_ms: 220,
            condition_id: Some(row.condition_id),
            kind: "definitionDeleted".into(),
            detail: json!({"unacked": true, "previous": row.state}),
        }],
        &[],
    )
    .await
    .unwrap();
    let events = db.events().await.unwrap();
    assert_eq!(
        events
            .iter()
            .find(|event| event.event.kind == "previousSessionState")
            .unwrap()
            .display
            .as_ref()
            .unwrap()
            .message,
        "高温"
    );
    assert_eq!(
        events
            .iter()
            .find(|event| event.event.kind == "previousSessionState")
            .unwrap()
            .display
            .as_ref()
            .unwrap()
            .name,
        "T-101"
    );
    db.close().await;
    drop(terminal);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn restore_keeps_only_matching_hash_and_endpoint() {
    let dir = temp_dir();
    let terminal = AlarmTerminal::open(&dir).await.unwrap();
    let id = project_id();
    let db = AlarmDb::open(&terminal, &id).await.unwrap();
    let mut original = applied(&id, "original");
    original
        .condition_hashes
        .insert("condition:hh".into(), "eval-hash".into());
    let display = original.displays["condition:hh"].clone();
    original.displays.insert("changed".into(), display.clone());
    original.displays.insert("wrong-endpoint".into(), display);
    original
        .condition_hashes
        .insert("changed".into(), "old-hash".into());
    original
        .condition_hashes
        .insert("wrong-endpoint".into(), "eval-hash".into());
    db.apply(&original, None, &[], &[]).await.unwrap();
    let spec = ConditionSpec {
        source: Source::Bit {
            tag: "PLANT.FLAG".into(),
            active_when: true,
        },
        on_delay_ms: 0,
        off_delay_ms: 0,
        ack_mode: AckMode::Manual,
    };
    let mut definitions = BTreeMap::new();
    definitions.insert(
        "condition:hh".into(),
        Definition {
            spec: spec.clone(),
            evaluation_hash: "eval-hash".into(),
        },
    );
    definitions.insert(
        "changed".into(),
        Definition {
            spec,
            evaluation_hash: "new-hash".into(),
        },
    );
    let mut changed = state("old");
    changed.condition_id = "changed".into();
    changed.evaluation_hash = "old-hash".into();
    let mut wrong_endpoint = state("old");
    wrong_endpoint.condition_id = "wrong-endpoint".into();
    wrong_endpoint.endpoint = "http://other:8722".into();
    let old = Session {
        id: "old".into(),
        generation: 1,
    };
    db.start_session(&old, 100, &[], &[]).await.unwrap();
    db.append(&old, &[], &[state("old")], &[], None)
        .await
        .unwrap();
    // Simulate stale rows from an interrupted older version. Production append
    // refuses these, while the startup restore path still handles them.
    let mut tx = db.pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    insert_state(&mut tx, &changed).await.unwrap();
    insert_state(&mut tx, &wrong_endpoint).await.unwrap();
    tx.commit().await.unwrap();
    let previous = db.last_states().await.unwrap();
    let session = Session {
        id: "new".into(),
        generation: 2,
    };
    let mut current = original.clone();
    current
        .condition_hashes
        .insert("changed".into(), "new-hash".into());
    current.condition_hashes.remove("wrong-endpoint");
    current.displays.remove("wrong-endpoint");
    assert!(matches!(
        plan_restore(
            session.clone(),
            "http://127.0.0.1:8722",
            200,
            &original,
            &definitions,
            &BTreeSet::new(),
            &previous,
        ),
        Err(RestoreError::DefinitionMismatch)
    ));
    assert!(matches!(
        plan_restore(
            session.clone(),
            "http://other:8722",
            200,
            &current,
            &definitions,
            &BTreeSet::new(),
            &previous,
        ),
        Err(RestoreError::EndpointMismatch)
    ));
    let plan = plan_restore(
        session.clone(),
        "http://127.0.0.1:8722",
        200,
        &current,
        &definitions,
        &BTreeSet::new(),
        &previous,
    )
    .unwrap();
    assert_eq!(plan.restored.len(), 1);
    let restored_state = &plan.engine.condition("condition:hh").unwrap().state;
    assert!(restored_state.active && !restored_state.acked);
    assert_eq!(restored_state.unavailable, Some(Unavailable::InitialValue));
    assert_eq!(plan.ended.len(), 2);
    assert_eq!(plan.ended[0].kind, "definitionChanged");
    assert_eq!(plan.ended[1].kind, "connectionChanged");
    db.close().await;
    drop(terminal);
    std::fs::remove_dir_all(dir).unwrap();
}
