use super::*;
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

#[tokio::test]
async fn a_crash_records_the_previous_state_and_unknown_period_before_restoring() {
    let dir = temp_dir();
    let id = project_id();
    let db = AlarmDb::open(&dir, &id).await.unwrap();
    db.apply(&applied(&id, "file-a"), None, &[], &[])
        .await
        .unwrap();
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
        Some(EngineUnavailable::Disconnected),
    )
    .await
    .unwrap();
    let previous = db.last_states().await.unwrap();
    assert!(previous[0].last_event_seq.is_some());
    db.close().await; // a process ended without a normal stop

    let db = AlarmDb::open(&dir, &id).await.unwrap();
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
            "previousSessionState",
            "previousEngineUnavailable",
            "unknownPeriod",
            "engineStarted"
        ]
    );
    assert_eq!(events[4].event.detail, json!({"fromMs": 120, "toMs": 200}));
    db.append(
        &second,
        &[],
        &[],
        &[],
        Some(EngineUnavailable::Disconnected),
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
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn failed_apply_leaves_definition_events_and_states_together() {
    let dir = temp_dir();
    let id = project_id();
    let db = AlarmDb::open(&dir, &id).await.unwrap();
    db.apply(&applied(&id, "original"), None, &[], &[])
        .await
        .unwrap();
    let session = Session {
        id: "session-1".into(),
        generation: 1,
    };
    db.start_session(&session, 100, &[], &[]).await.unwrap();
    let mut invalid = state("session-1");
    invalid.condition_id.clear(); // DB CHECK rejects the last insert.
    assert!(db
        .apply(
            &applied(&id, "candidate"),
            Some(&session),
            &[EventWrite {
                at_ms: 200,
                condition_id: None,
                kind: "definitionChanged".into(),
                detail: Value::Null,
            }],
            &[invalid],
        )
        .await
        .is_err());
    assert_eq!(db.applied().await.unwrap().unwrap().file_hash, "original");
    assert_eq!(db.events().await.unwrap().len(), 1); // engineStarted only
    assert!(db.last_states().await.unwrap().is_empty());
    db.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn an_old_session_cannot_ack_after_a_new_session_starts() {
    let dir = temp_dir();
    let id = project_id();
    let db = AlarmDb::open(&dir, &id).await.unwrap();
    let first = Session {
        id: "first".into(),
        generation: 1,
    };
    db.start_session(&first, 1, &[], &[]).await.unwrap();
    let second = Session {
        id: "second".into(),
        generation: 2,
    };
    db.start_session(&second, 2, &[], &[]).await.unwrap();
    assert!(db.append(&first, &[], &[], &[], None).await.is_err());
    assert!(db.start_session(&first, 3, &[], &[]).await.is_err());
    let candidate = applied(&id, "candidate");
    assert!(matches!(
        db.apply(&candidate, Some(&first), &[], &[]).await,
        Err(AlarmDbError::InvalidRow)
    ));
    assert!(matches!(
        db.apply(&candidate, None, &[], &[]).await,
        Err(AlarmDbError::InvalidRow)
    ));
    db.apply(&candidate, Some(&second), &[], &[state("stale")])
        .await
        .unwrap();
    assert_eq!(db.last_states().await.unwrap()[0].session_id, second.id);
    db.stop_session(&second, 3).await.unwrap();
    db.apply(&candidate, None, &[], &[]).await.unwrap();
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
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn an_applied_definition_from_another_project_is_not_read_as_this_project() {
    let dir = temp_dir();
    let id = project_id();
    let db = AlarmDb::open(&dir, &id).await.unwrap();
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
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn session_start_rejects_missing_or_stale_restore_rows() {
    let dir = temp_dir();
    let id = project_id();
    let db = AlarmDb::open(&dir, &id).await.unwrap();
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
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn stopped_session_can_apply_and_attribute_ended_rows_to_it() {
    let dir = temp_dir();
    let id = project_id();
    let db = AlarmDb::open(&dir, &id).await.unwrap();
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
            detail: json!({"unacked": true}),
        }],
        &[],
    )
    .await
    .unwrap();
    assert!(db.last_states().await.unwrap().is_empty());
    let last = db.events().await.unwrap().pop().unwrap();
    assert_eq!(last.session_id, session.id);
    assert_eq!(last.event.kind, "definitionDeleted");
    db.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn restore_keeps_only_matching_hash_and_endpoint_and_writes_ends_with_start() {
    let dir = temp_dir();
    let id = project_id();
    let db = AlarmDb::open(&dir, &id).await.unwrap();
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
    db.append(
        &old,
        &[],
        &[state("old"), changed, wrong_endpoint],
        &[],
        None,
    )
    .await
    .unwrap();
    let previous = db.last_states().await.unwrap();
    let session = Session {
        id: "new".into(),
        generation: 2,
    };
    let plan = plan_restore(
        session.clone(),
        "http://127.0.0.1:8722",
        200,
        &definitions,
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
    db.start_session(&session, 200, &plan.ended, &plan.restored)
        .await
        .unwrap();
    assert_eq!(db.last_states().await.unwrap(), plan.restored);
    let kinds: Vec<_> = db
        .events()
        .await
        .unwrap()
        .into_iter()
        .map(|event| event.event.kind)
        .collect();
    assert!(kinds.ends_with(&[
        "definitionChanged".into(),
        "connectionChanged".into(),
        "engineStarted".into()
    ]));
    db.close().await;
    std::fs::remove_dir_all(dir).unwrap();
}
