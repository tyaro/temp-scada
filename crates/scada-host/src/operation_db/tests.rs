use std::time::Duration;

use banto_tagclient::ErrorKind;
use serde_json::json;

use super::*;

fn temp_file() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("operation-db-{}%-data", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("operations.db")
}

fn request(slot: &str) -> RequestRecord {
    RequestRecord {
        requested_at_ms: 1_000,
        user: "未ログイン".into(),
        phase: "setup".into(),
        hub_endpoint: Some("http://127.0.0.1:8722".into()),
        project_id: "4f6c1b0e-6d0e-4b8a-9f00-000000000001".into(),
        project_digest: "a".repeat(64),
        screen_id: "main".into(),
        object_id: "pump1".into(),
        equipment_id: "eq-1".into(),
        equipment_code: Some("P-101".into()),
        slot: slot.into(),
        tag: Some("Line1.P101.Command".into()),
        value: json!(true),
    }
}

/// A log whose record points at a write key (in memory only), as a
/// terminal that can send has; `begin` takes that key's id (`key_of`).
fn keyed(db: OperationDb) -> OperationLog {
    let log = OperationLog::new(db);
    {
        let mut in_flight = log.in_flight.lock().unwrap();
        if in_flight.key.is_none() {
            in_flight.key = Some(key_ref("k0"));
        }
    }
    log
}

/// The id of the write key the record points at now.
fn key_of(log: &OperationLog) -> String {
    log.key().expect("a registered write key").id
}

fn finish(outcome: Outcome, at: i64) -> Finish {
    Finish {
        outcome,
        reason: None,
        audit_id: None,
        finished_at_ms: at,
    }
}

async fn fail_updates(db: &OperationDb, fail: bool) {
    let sql = if fail {
        "CREATE TRIGGER fail_update BEFORE UPDATE ON operation BEGIN SELECT RAISE(ABORT, 'disk full'); END"
    } else {
        "DROP TRIGGER fail_update"
    };
    sqlx::query(sql).execute(&db.pool).await.unwrap();
}

async fn fail_inserts(db: &OperationDb, fail: bool) {
    let sql = if fail {
        "CREATE TRIGGER fail_insert BEFORE INSERT ON operation BEGIN SELECT RAISE(ABORT, 'disk full'); END"
    } else {
        "DROP TRIGGER fail_insert"
    };
    sqlx::query(sql).execute(&db.pool).await.unwrap();
}

#[test]
fn write_errors_map_to_the_design_outcomes() {
    use ErrorKind::*;
    for kind in [
        Unauthorized,
        WriteForbidden,
        WriteUnavailable,
        Transport,
        InvalidEndpoint,
        InvalidWriteOptions,
        InvalidTagSelection,
    ] {
        assert_eq!(classify_write_error(kind), Outcome::NotSent, "{kind:?}");
    }
    assert_eq!(classify_write_error(KeyTripped), Outcome::Stopped);
    // Refused before sending and a 502 `write_failed` share the kind: "not
    // effected", never "not sent".
    assert_eq!(classify_write_error(WriteRejected), Outcome::Failed);
    // Time-outs, cuts and any kind the table does not name: the operator
    // checks the current value.
    for kind in [WriteUncertain, ProtocolError, KeyRevoked, Stopped] {
        assert_eq!(classify_write_error(kind), Outcome::Uncertain, "{kind:?}");
    }
}

#[tokio::test]
async fn a_row_is_pending_until_finished_once() {
    let file = temp_file();
    let (db, recovered) = OperationDb::open(&file, 0).await.unwrap();
    assert_eq!(recovered, 0);
    let request = request("command");
    db.insert_pending("row-1", &request).await.unwrap();
    let row = db.row("row-1").await.unwrap().unwrap();
    assert_eq!(row.request, request);
    assert_eq!(row.repeat_count, 1);
    assert_eq!(row.finish, None);

    let done = Finish {
        outcome: Outcome::Ok,
        reason: None,
        audit_id: Some(42),
        finished_at_ms: 1_200,
    };
    db.finish("row-1", &done).await.unwrap();
    assert_eq!(db.row("row-1").await.unwrap().unwrap().finish, Some(done));
    // An outcome is written once.
    assert!(matches!(
        db.finish("row-1", &finish(Outcome::Failed, 1_300)).await,
        Err(OperationDbError::InvalidRow)
    ));
    assert!(matches!(
        db.finish("missing", &finish(Outcome::Ok, 1_300)).await,
        Err(OperationDbError::InvalidRow)
    ));
    db.close().await;
}

#[tokio::test]
async fn reopening_finishes_rows_an_earlier_process_left_pending() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    db.insert_pending("lost", &request("command"))
        .await
        .unwrap();
    db.insert_finished("kept", &request("command"), &finish(Outcome::Ok, 1_100))
        .await
        .unwrap();
    db.close().await;

    let (db, recovered) = OperationDb::open(&file, 9_000).await.unwrap();
    assert_eq!(recovered, 1);
    assert_eq!(
        db.row("lost").await.unwrap().unwrap().finish,
        Some(Finish {
            outcome: Outcome::Uncertain,
            reason: Some(INTERRUPTED.into()),
            audit_id: None,
            finished_at_ms: 9_000,
        })
    );
    assert_eq!(
        db.row("kept").await.unwrap().unwrap().finish,
        Some(finish(Outcome::Ok, 1_100))
    );
    db.close().await;
}

#[tokio::test]
async fn a_file_of_another_format_is_refused_without_changing_it() {
    // A file of a later format, and a foreign SQLite file without our
    // version, both in rollback-journal mode.
    for setup in ["PRAGMA user_version = 4", "CREATE TABLE foreign_data (x)"] {
        let file = temp_file();
        let mut connection = <sqlx::sqlite::SqliteConnection as sqlx::Connection>::connect_with(
            &SqliteConnectOptions::new()
                .filename(&file)
                .create_if_missing(true)
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete),
        )
        .await
        .unwrap();
        sqlx::raw_sql(setup).execute(&mut connection).await.unwrap();
        sqlx::Connection::close(connection).await.unwrap();

        assert!(
            matches!(
                OperationDb::open(&file, 0).await,
                Err(OperationDbError::UnsupportedFormat)
            ),
            "{setup}"
        );
        // The refused file keeps its journal mode (WAL would be persistent).
        let mut connection = <sqlx::sqlite::SqliteConnection as sqlx::Connection>::connect_with(
            &SqliteConnectOptions::new().filename(&file).read_only(true),
        )
        .await
        .unwrap();
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(mode, "delete", "{setup}");
        sqlx::Connection::close(connection).await.unwrap();
    }
}

#[tokio::test]
async fn an_accepted_file_is_in_wal_mode() {
    let (db, _) = OperationDb::open(&temp_file(), 0).await.unwrap();
    let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(mode, "wal");
    db.close().await;
}

#[tokio::test]
async fn a_row_finished_between_the_read_and_the_lock_reads_as_finished() {
    let (db, _) = OperationDb::open(&temp_file(), 0).await.unwrap();
    let log = keyed(db);
    let other = request("speedSp");
    let request = request("command");

    // `latest` reads the row while it is pending; `complete` then writes the
    // outcome and frees the send slot before `latest` takes the lock.
    let id = log
        .begin(&request, Duration::ZERO, &key_of(&log))
        .await
        .unwrap();
    let stale = log
        .db()
        .latest(&request.project_id, "eq-1", "command")
        .await
        .unwrap()
        .unwrap();
    assert!(stale.finish.is_none());
    log.complete(&id, finish(Outcome::Ok, 1_300)).await.unwrap();
    let (row, state) = log.resolve(stale).await.unwrap();
    assert_eq!(state, RecordState::Finished(finish(Outcome::Ok, 1_300)));
    assert_eq!(row.finish, Some(finish(Outcome::Ok, 1_300)));

    // The same when a kept outcome is rewritten between the read and the lock.
    let id = log
        .begin(&request, Duration::ZERO, &key_of(&log))
        .await
        .unwrap();
    fail_updates(log.db(), true).await;
    assert!(log
        .complete(&id, finish(Outcome::Failed, 1_400))
        .await
        .is_err());
    let stale = log
        .db()
        .latest(&request.project_id, "eq-1", "command")
        .await
        .unwrap()
        .unwrap();
    fail_updates(log.db(), false).await;
    log.refuse(&other, "too_soon", 1_500).await.unwrap();
    let (_, state) = log.resolve(stale).await.unwrap();
    assert_eq!(state, RecordState::Finished(finish(Outcome::Failed, 1_400)));
    log.close().await;
}

#[tokio::test]
async fn latest_is_the_newest_row_of_the_slot() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    assert!(log.latest("p", "eq-1", "command").await.unwrap().is_none());

    let command = request("command");
    log.refuse(&command, "phase_unavailable", 1_010)
        .await
        .unwrap();
    let mut other = request("speedSp");
    other.value = json!({"value": 12.5, "input": "12.5"});
    log.refuse(&other, "out_of_range", 1_020).await.unwrap();

    let (row, state) = log
        .latest(&command.project_id, "eq-1", "command")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.request.slot, "command");
    assert_eq!(
        state,
        RecordState::Finished(Finish {
            outcome: Outcome::Refused,
            reason: Some("phase_unavailable".into()),
            audit_id: None,
            finished_at_ms: 1_010,
        })
    );
    let (row, _) = log
        .latest(&command.project_id, "eq-1", "speedSp")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.request.value, json!({"value": 12.5, "input": "12.5"}));
    // Another Project with the same ids has its own rows.
    assert!(log
        .latest("other", "eq-1", "command")
        .await
        .unwrap()
        .is_none());
    log.close().await;
}

#[tokio::test]
async fn one_write_is_in_flight_per_terminal() {
    let (db, _) = OperationDb::open(&temp_file(), 0).await.unwrap();
    let log = keyed(db);
    let request = request("command");
    let id = log
        .begin(&request, Duration::ZERO, &key_of(&log))
        .await
        .unwrap();
    assert_eq!(id.len(), 36);
    let (_, state) = log
        .latest(&request.project_id, "eq-1", "command")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state, RecordState::Sending);
    assert!(matches!(
        log.begin(&request, Duration::ZERO, &key_of(&log)).await,
        Err(BeginError::Busy)
    ));

    log.complete(&id, finish(Outcome::Uncertain, 1_500))
        .await
        .unwrap();
    let (_, state) = log
        .latest(&request.project_id, "eq-1", "command")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        state,
        RecordState::Finished(finish(Outcome::Uncertain, 1_500))
    );
    // The slot is free again.
    let next = log
        .begin(&request, Duration::ZERO, &key_of(&log))
        .await
        .unwrap();
    assert_ne!(next, id);
    log.close().await;
}

#[tokio::test]
async fn nothing_is_sent_when_the_pending_row_cannot_be_written() {
    let (db, _) = OperationDb::open(&temp_file(), 0).await.unwrap();
    fail_inserts(&db, true).await;
    let log = keyed(db);
    let request = request("command");
    assert!(matches!(
        log.begin(&request, Duration::ZERO, &key_of(&log)).await,
        Err(BeginError::Record(_))
    ));
    // The send slot was released.
    fail_inserts(log.db(), false).await;
    log.begin(&request, Duration::ZERO, &key_of(&log))
        .await
        .unwrap();
    log.close().await;
}

#[tokio::test]
async fn an_outcome_that_could_not_be_written_is_shown_and_rewritten_later() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    let request = request("command");
    let id = log
        .begin(&request, Duration::ZERO, &key_of(&log))
        .await
        .unwrap();

    fail_updates(log.db(), true).await;
    let sent = Finish {
        outcome: Outcome::Ok,
        reason: None,
        audit_id: Some(7),
        finished_at_ms: 1_400,
    };
    assert!(log.complete(&id, sent.clone()).await.is_err());
    // Not "sending" any more: the send ended and the process has its outcome.
    let (row, state) = log
        .latest(&request.project_id, "eq-1", "command")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.id, id);
    assert_eq!(
        state,
        RecordState::Unrecorded {
            finish: Some(sent.clone())
        }
    );
    // A write while the DB still fails keeps it for a later try.
    let other = log.refuse(&request, "too_soon", 1_450).await.unwrap();
    assert!(log.db().row(&id).await.unwrap().unwrap().finish.is_none());

    // The next successful write rewrites the row; the request is never re-sent.
    fail_updates(log.db(), false).await;
    log.refuse(&request, "too_soon", 1_500).await.unwrap();
    assert_eq!(log.db().row(&id).await.unwrap().unwrap().finish, Some(sent));
    assert!(log.db().row(&other).await.unwrap().is_some());
    log.close().await;
}

#[tokio::test]
async fn a_completion_that_is_written_also_rewrites_an_earlier_unrecorded_outcome() {
    let (db, _) = OperationDb::open(&temp_file(), 0).await.unwrap();
    let log = keyed(db);
    let request = request("command");
    let first = log
        .begin(&request, Duration::ZERO, &key_of(&log))
        .await
        .unwrap();
    fail_updates(log.db(), true).await;
    let kept = Finish {
        outcome: Outcome::Ok,
        reason: None,
        audit_id: Some(9),
        finished_at_ms: 1_400,
    };
    assert!(log.complete(&first, kept.clone()).await.is_err());
    // The next request starts while updates still fail (its INSERT works).
    let second = log
        .begin(&request, Duration::ZERO, &key_of(&log))
        .await
        .unwrap();
    assert!(log
        .db()
        .row(&first)
        .await
        .unwrap()
        .unwrap()
        .finish
        .is_none());

    // The DB recovers before the second completes: its write rewrites the
    // first too, so ending the process now would not lose it.
    fail_updates(log.db(), false).await;
    log.complete(&second, finish(Outcome::Failed, 1_600))
        .await
        .unwrap();
    assert_eq!(
        log.db().row(&first).await.unwrap().unwrap().finish,
        Some(kept)
    );
    log.close().await;
}

#[tokio::test]
async fn a_pending_row_of_an_earlier_process_reads_as_unrecorded_without_outcome() {
    let (db, _) = OperationDb::open(&temp_file(), 0).await.unwrap();
    // A row no in-process state knows of (left by a process whose recovery
    // has not run on this file).
    let request = request("command");
    db.insert_pending("old", &request).await.unwrap();
    let log = keyed(db);
    let (_, state) = log
        .latest(&request.project_id, "eq-1", "command")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state, RecordState::Unrecorded { finish: None });
    log.close().await;
}

#[tokio::test]
async fn a_dropped_begin_frees_the_send_slot() {
    let (db, _) = OperationDb::open(&temp_file(), 0).await.unwrap();
    let log = keyed(db);
    let request = request("command");
    {
        let key = key_of(&log);
        let mut begin = Box::pin(log.begin(&request, Duration::ZERO, &key));
        // Hold the pool's only connection, so the INSERT surely waits.
        let held = log.db().pool.acquire().await.unwrap();
        let first = futures_util::poll!(begin.as_mut());
        assert!(first.is_pending());
        assert!(log.in_flight.lock().unwrap().sending.is_some());
        drop(begin);
        drop(held);
    }
    assert!(log.in_flight.lock().unwrap().sending.is_none());
    log.begin(&request, Duration::ZERO, &key_of(&log))
        .await
        .unwrap();
    log.close().await;
}

#[tokio::test]
async fn identical_refusals_of_a_slot_are_one_row_for_a_minute() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    let mut first = request("command");
    let id = log.refuse(&first, "write_stopped", 1_010).await.unwrap();
    let mut again = first.clone();
    again.requested_at_ms = 1_000 + FOLD_WINDOW_MS - 1;
    assert_eq!(
        log.refuse(&again, "write_stopped", 61_000).await.unwrap(),
        id
    );
    let row = log.db().row(&id).await.unwrap().unwrap();
    assert_eq!(row.repeat_count, 2);
    // The first request's time stays; the end is the last refusal's.
    assert_eq!(row.request.requested_at_ms, 1_000);
    assert_eq!(row.finish.unwrap().finished_at_ms, 61_000);
    // A minute after the row's first request: a new row.
    again.requested_at_ms = 1_000 + FOLD_WINDOW_MS;
    let next = log.refuse(&again, "write_stopped", 61_010).await.unwrap();
    assert_ne!(next, id);
    assert_eq!(log.db().row(&next).await.unwrap().unwrap().repeat_count, 1);
    // A clock that went back does not fold into a later row.
    first.requested_at_ms = 900;
    assert_ne!(
        log.refuse(&first, "write_stopped", 61_020).await.unwrap(),
        next
    );
    log.close().await;
}

#[tokio::test]
async fn a_clock_that_went_back_inside_the_window_starts_a_new_row() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    let mut refusal = request("command");
    refusal.requested_at_ms = 1_000;
    let id = log.refuse(&refusal, "write_stopped", 1_000).await.unwrap();
    refusal.requested_at_ms = 20_000;
    assert_eq!(
        log.refuse(&refusal, "write_stopped", 20_000).await.unwrap(),
        id
    );
    // Back to 15 s: after the row's first request, but before its end.
    refusal.requested_at_ms = 15_000;
    let back = log.refuse(&refusal, "write_stopped", 15_000).await.unwrap();
    assert_ne!(back, id);
    let row = log.db().row(&id).await.unwrap().unwrap();
    assert_eq!(row.repeat_count, 2);
    assert_eq!(row.finish.unwrap().finished_at_ms, 20_000);
    // The same end as the row's still folds.
    assert_eq!(
        log.refuse(&refusal, "write_stopped", 15_000).await.unwrap(),
        back
    );
    log.close().await;
}

/// One field of a request changed.
type Change = fn(&mut RequestRecord);

#[tokio::test]
async fn a_refusal_that_differs_in_any_field_is_its_own_row() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    let base = request("command");
    let changes: Vec<(&str, Change)> = vec![
        ("user", |r| r.user = "operator".into()),
        ("phase", |r| r.phase = "operational".into()),
        ("hub_endpoint", |r| r.hub_endpoint = None),
        ("project_digest", |r| r.project_digest = "b".repeat(64)),
        ("screen_id", |r| r.screen_id = "sub".into()),
        ("object_id", |r| r.object_id = "pump2".into()),
        ("equipment_code", |r| r.equipment_code = None),
        ("tag", |r| r.tag = None),
        ("value", |r| r.value = json!(false)),
    ];
    for (field, change) in changes {
        let id = log.refuse(&base, "too_soon", 1_010).await.unwrap();
        let mut other = base.clone();
        change(&mut other);
        assert_ne!(
            log.refuse(&other, "too_soon", 1_020).await.unwrap(),
            id,
            "{field}"
        );
    }
    // The reason, and the typed text of an input with the same value.
    let id = log.refuse(&base, "too_soon", 1_030).await.unwrap();
    assert_ne!(log.refuse(&base, "write_stopped", 1_040).await.unwrap(), id);
    let mut typed = request("speedSp");
    typed.value = json!({"value": 12.5, "input": "12.5"});
    let id = log.refuse(&typed, "too_soon", 1_050).await.unwrap();
    typed.value = json!({"value": 12.5, "input": "12.50"});
    assert_ne!(log.refuse(&typed, "too_soon", 1_060).await.unwrap(), id);
    log.close().await;
}

#[tokio::test]
async fn only_the_newest_row_of_the_slot_is_folded_into() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    let run = request("command");
    let mut stop = run.clone();
    stop.value = json!(false);
    // Another slot in between does not matter.
    let id = log.refuse(&run, "write_stopped", 1_010).await.unwrap();
    log.refuse(&request("speedSp"), "write_stopped", 1_020)
        .await
        .unwrap();
    assert_eq!(log.refuse(&run, "write_stopped", 1_030).await.unwrap(), id);
    // 「運転」, 「停止」, 「運転」: three rows, so the slot's last row is the
    // last request.
    log.refuse(&stop, "write_stopped", 1_040).await.unwrap();
    let last = log.refuse(&run, "write_stopped", 1_050).await.unwrap();
    assert_ne!(last, id);
    // A sent request is never folded into.
    let sent = log
        .begin(&run, Duration::ZERO, &key_of(&log))
        .await
        .unwrap();
    log.complete(&sent, finish(Outcome::Ok, 1_060))
        .await
        .unwrap();
    assert_ne!(
        log.refuse(&run, "write_stopped", 1_070).await.unwrap(),
        sent
    );
    log.close().await;
}

#[tokio::test]
async fn a_fold_that_cannot_be_written_is_an_error() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    let run = request("command");
    let id = log.refuse(&run, "too_soon", 1_010).await.unwrap();
    fail_updates(log.db(), true).await;
    assert!(log.refuse(&run, "too_soon", 1_020).await.is_err());
    fail_updates(log.db(), false).await;
    assert_eq!(log.db().row(&id).await.unwrap().unwrap().repeat_count, 1);
    log.close().await;
}

fn key_ref(id: &str) -> KeyRef {
    KeyRef {
        endpoint: "http://127.0.0.1:8722".into(),
        id: id.into(),
    }
}

fn hub_error(outcome: Outcome, kind: ErrorKind, at: i64) -> Finish {
    Finish {
        outcome,
        reason: Some(kind.as_str().into()),
        audit_id: None,
        finished_at_ms: at,
    }
}

#[tokio::test]
async fn a_tripped_key_stops_the_terminal_across_restarts_until_resumed() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    assert_eq!(log.write_status(), WriteStatus::default());
    let request = request("command");
    let id = log
        .begin(&request, Duration::ZERO, &key_of(&log))
        .await
        .unwrap();
    log.complete(
        &id,
        hub_error(Outcome::Stopped, ErrorKind::KeyTripped, 2_000),
    )
    .await
    .unwrap();
    let stopped = WriteStatus {
        state: WriteState::Stopped,
        changed_at_ms: Some(2_000),
    };
    assert_eq!(log.write_status(), stopped);
    assert_eq!(log.gate(Duration::ZERO), Err(Gate::Stopped));
    assert!(matches!(
        log.begin(&request, Duration::ZERO, &key_of(&log)).await,
        Err(BeginError::Gate(Gate::Stopped))
    ));
    log.close().await;

    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    assert_eq!(log.write_status(), stopped);
    assert!(log.resume(3_000).await.unwrap());
    assert_eq!(log.gate(Duration::ZERO), Ok(()));
    // Resuming a ready terminal changes nothing.
    assert!(!log.resume(3_100).await.unwrap());
    log.close().await;

    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    assert_eq!(
        log.write_status(),
        WriteStatus {
            state: WriteState::Ready,
            changed_at_ms: Some(3_000),
        }
    );
    log.close().await;
}

#[tokio::test]
async fn a_refused_key_is_cleared_only_by_registering_it_again() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    let request = request("command");
    let id = log
        .begin(&request, Duration::ZERO, &key_of(&log))
        .await
        .unwrap();
    log.complete(
        &id,
        hub_error(Outcome::NotSent, ErrorKind::Unauthorized, 2_000),
    )
    .await
    .unwrap();
    assert_eq!(log.gate(Duration::ZERO), Err(Gate::KeyInvalid));
    assert!(!log.resume(2_100).await.unwrap());
    assert_eq!(log.write_status().state, WriteState::KeyInvalid);
    log.key_registered(2_200, &key_ref("k1")).await.unwrap();
    assert_eq!(log.gate(Duration::ZERO), Ok(()));
    // Other outcomes leave the state alone.
    for finish in [
        finish(Outcome::Ok, 2_300),
        hub_error(Outcome::NotSent, ErrorKind::WriteForbidden, 2_400),
        hub_error(Outcome::Uncertain, ErrorKind::WriteUncertain, 2_500),
    ] {
        let id = log
            .begin(&request, Duration::ZERO, &key_of(&log))
            .await
            .unwrap();
        log.complete(&id, finish).await.unwrap();
        assert_eq!(log.write_status().state, WriteState::Ready);
    }
    log.close().await;
}

#[tokio::test]
async fn a_state_that_could_not_be_saved_holds_and_is_saved_later() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    let request = request("command");
    let id = log
        .begin(&request, Duration::ZERO, &key_of(&log))
        .await
        .unwrap();
    log.db()
        .execute_for_test(
            "CREATE TRIGGER fail_state BEFORE INSERT ON terminal_write BEGIN SELECT RAISE(ABORT, 'disk full'); END",
        )
        .await;
    // The row and the state are one transaction: neither is written.
    let tripped = hub_error(Outcome::Stopped, ErrorKind::KeyTripped, 2_000);
    assert!(log.complete(&id, tripped.clone()).await.is_err());
    assert!(log.db().row(&id).await.unwrap().unwrap().finish.is_none());
    // The state holds in this process; the slot is free.
    assert_eq!(log.gate(Duration::ZERO), Err(Gate::Stopped));
    assert!(!log.is_sending());
    // The record takes writes but the state still fails: the trip's row
    // stays pending, so a restart never reads it with `ready`.
    log.refuse(&request, "write_stopped", 2_050).await.unwrap();
    assert!(log.db().row(&id).await.unwrap().unwrap().finish.is_none());
    log.db().execute_for_test("DROP TRIGGER fail_state").await;
    // The next write the DB takes saves both.
    log.refuse(&request, "write_stopped", 2_100).await.unwrap();
    assert_eq!(
        log.db().row(&id).await.unwrap().unwrap().finish,
        Some(tripped)
    );
    log.close().await;
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    assert_eq!(keyed(db).write_status().state, WriteState::Stopped);
}

#[tokio::test]
async fn a_process_that_ends_after_a_trip_restarts_stopped() {
    // The outcome and the state commit together: a process killed right
    // after `complete` (no close) never restarts `ready` with the trip in
    // the record. Both moving outcomes.
    for (outcome, kind, state) in [
        (Outcome::Stopped, ErrorKind::KeyTripped, WriteState::Stopped),
        (
            Outcome::NotSent,
            ErrorKind::Unauthorized,
            WriteState::KeyInvalid,
        ),
    ] {
        let file = temp_file();
        let (db, _) = OperationDb::open(&file, 0).await.unwrap();
        let log = keyed(db);
        let request = request("command");
        let id = log
            .begin(&request, Duration::ZERO, &key_of(&log))
            .await
            .unwrap();
        log.complete(&id, hub_error(outcome, kind, 2_000))
            .await
            .unwrap();
        drop(log);

        let (db, recovered) = OperationDb::open(&file, 0).await.unwrap();
        assert_eq!(recovered, 0, "{state:?}");
        let log = keyed(db);
        assert_eq!(log.write_status().state, state);
        let finish = log.db().row(&id).await.unwrap().unwrap().finish.unwrap();
        assert_eq!(finish.outcome, outcome);
        log.close().await;
    }
}

#[tokio::test]
async fn sends_keep_the_minimum_interval() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    let request = request("command");
    let interval = Duration::from_millis(300);
    let id = log.begin(&request, interval, &key_of(&log)).await.unwrap();
    log.complete(&id, finish(Outcome::Ok, 2_000)).await.unwrap();
    assert_eq!(log.gate(interval), Err(Gate::TooSoon));
    assert!(matches!(
        log.begin(&request, interval, &key_of(&log)).await,
        Err(BeginError::Gate(Gate::TooSoon))
    ));
    // The refused begin took no slot and did not move the interval.
    assert!(!log.is_sending());
    assert_eq!(log.gate(Duration::ZERO), Ok(()));
    tokio::time::sleep(interval + Duration::from_millis(100)).await;
    assert_eq!(log.gate(interval), Ok(()));
    log.begin(&request, interval, &key_of(&log)).await.unwrap();
    log.close().await;
}

#[tokio::test]
async fn a_format_1_file_gets_the_write_state_and_keeps_its_rows() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    let id = log
        .refuse(&request("command"), "too_soon", 1_010)
        .await
        .unwrap();
    log.db()
        .execute_for_test("DROP TABLE terminal_write; PRAGMA user_version = 1;")
        .await;
    log.close().await;

    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let version: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(version, 3);
    let log = OperationLog::new(db);
    assert_eq!(log.write_status(), WriteStatus::default());
    assert_eq!(log.key_endpoint(), None);
    assert!(log.db().row(&id).await.unwrap().is_some());
    log.close().await;
}

#[tokio::test]
async fn a_format_2_file_gets_the_key_endpoint_and_keeps_its_state() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    let request = request("command");
    let id = log
        .begin(&request, Duration::ZERO, &key_of(&log))
        .await
        .unwrap();
    log.complete(
        &id,
        hub_error(Outcome::Stopped, ErrorKind::KeyTripped, 2_000),
    )
    .await
    .unwrap();
    // Back to format 2: the table without `key_endpoint`.
    log.db()
        .execute_for_test(
            "ALTER TABLE terminal_write DROP COLUMN key_endpoint; ALTER TABLE terminal_write DROP COLUMN key_id; PRAGMA user_version = 2;",
        )
        .await;
    log.close().await;

    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = OperationLog::new(db);
    assert_eq!(log.write_status().state, WriteState::Stopped);
    assert_eq!(log.key_endpoint(), None);
    log.key_registered(3_000, &key_ref("k1")).await.unwrap();
    log.close().await;
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    assert_eq!(log.key(), Some(key_ref("k1")));
    assert_eq!(log.write_status().state, WriteState::Ready);
    log.close().await;
}

#[tokio::test]
async fn a_deleted_key_keeps_the_state_and_drops_the_endpoint() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = keyed(db);
    log.key_registered(1_000, &key_ref("k1")).await.unwrap();
    let request = request("command");
    let id = log
        .begin(&request, Duration::ZERO, &key_of(&log))
        .await
        .unwrap();
    log.complete(
        &id,
        hub_error(Outcome::Stopped, ErrorKind::KeyTripped, 2_000),
    )
    .await
    .unwrap();
    // A trip keeps the key's endpoint.
    assert_eq!(log.key_endpoint().as_deref(), Some("http://127.0.0.1:8722"));
    assert_eq!(log.key_deleted().await.unwrap(), Some(key_ref("k1")));
    assert_eq!(log.key_endpoint(), None);
    log.close().await;
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = OperationLog::new(db);
    assert_eq!(log.key_endpoint(), None);
    assert_eq!(log.write_status().state, WriteState::Stopped);
    log.close().await;
}

#[tokio::test]
async fn a_late_trip_of_the_previous_key_leaves_the_new_key_ready() {
    // #320 review: a key registered again while a write with the previous
    // key is in flight; the previous key's trip (or 401) comes back late.
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = OperationLog::new(db);
    let cases = [
        (Outcome::Stopped, ErrorKind::KeyTripped),
        (Outcome::NotSent, ErrorKind::Unauthorized),
    ];
    for (round, (outcome, kind)) in cases.into_iter().enumerate() {
        let old = key_ref(&format!("old-{round}"));
        log.key_registered(1_000, &old).await.unwrap();
        let request = request("command");
        let id = log.begin(&request, Duration::ZERO, &old.id).await.unwrap();
        log.key_registered(2_000, &key_ref(&format!("new-{round}")))
            .await
            .unwrap();
        log.complete(&id, hub_error(outcome, kind, 3_000))
            .await
            .unwrap();
        // The outcome is recorded as it is; the state stays as the new key
        // made it.
        let (row, _) = log
            .latest(&request.project_id, "eq-1", "command")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.finish.unwrap().outcome, outcome, "{kind:?}");
        assert_eq!(
            log.write_status(),
            WriteStatus {
                state: WriteState::Ready,
                changed_at_ms: Some(2_000),
            },
            "{kind:?}"
        );
        assert!(!log.is_sending());
    }
    log.close().await;
    // The file has `ready` too.
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = OperationLog::new(db);
    assert_eq!(log.write_status().state, WriteState::Ready);
    log.close().await;
}

#[tokio::test]
async fn a_late_trip_after_the_key_was_deleted_leaves_the_state() {
    let (db, _) = OperationDb::open(&temp_file(), 0).await.unwrap();
    let log = OperationLog::new(db);
    log.key_registered(1_000, &key_ref("k1")).await.unwrap();
    let id = log
        .begin(&request("command"), Duration::ZERO, "k1")
        .await
        .unwrap();
    log.key_deleted().await.unwrap();
    log.complete(
        &id,
        hub_error(Outcome::Stopped, ErrorKind::KeyTripped, 3_000),
    )
    .await
    .unwrap();
    assert_eq!(log.write_status().state, WriteState::Ready);
    log.close().await;
}

#[tokio::test]
async fn a_key_changed_before_the_send_slot_is_not_sent() {
    let (db, _) = OperationDb::open(&temp_file(), 0).await.unwrap();
    let log = OperationLog::new(db);
    let request = request("command");
    // No key at all, a key registered again, a key deleted.
    assert!(matches!(
        log.begin(&request, Duration::ZERO, "k1").await,
        Err(BeginError::KeyChanged)
    ));
    log.key_registered(1_000, &key_ref("k2")).await.unwrap();
    assert!(matches!(
        log.begin(&request, Duration::ZERO, "k1").await,
        Err(BeginError::KeyChanged)
    ));
    log.key_deleted().await.unwrap();
    assert!(matches!(
        log.begin(&request, Duration::ZERO, "k2").await,
        Err(BeginError::KeyChanged)
    ));
    assert!(!log.is_sending());
    log.close().await;
}
