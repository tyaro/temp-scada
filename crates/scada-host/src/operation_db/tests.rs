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
    for setup in ["PRAGMA user_version = 2", "CREATE TABLE foreign_data (x)"] {
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
    let log = OperationLog::new(db);
    let other = request("speedSp");
    let request = request("command");

    // `latest` reads the row while it is pending; `complete` then writes the
    // outcome and frees the send slot before `latest` takes the lock.
    let id = log.begin(&request).await.unwrap();
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
    let id = log.begin(&request).await.unwrap();
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
    let log = OperationLog::new(db);
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
    let log = OperationLog::new(db);
    let request = request("command");
    let id = log.begin(&request).await.unwrap();
    assert_eq!(id.len(), 36);
    let (_, state) = log
        .latest(&request.project_id, "eq-1", "command")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state, RecordState::Sending);
    assert!(matches!(log.begin(&request).await, Err(BeginError::Busy)));

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
    let next = log.begin(&request).await.unwrap();
    assert_ne!(next, id);
    log.close().await;
}

#[tokio::test]
async fn nothing_is_sent_when_the_pending_row_cannot_be_written() {
    let (db, _) = OperationDb::open(&temp_file(), 0).await.unwrap();
    fail_inserts(&db, true).await;
    let log = OperationLog::new(db);
    let request = request("command");
    assert!(matches!(
        log.begin(&request).await,
        Err(BeginError::Record(_))
    ));
    // The send slot was released.
    fail_inserts(log.db(), false).await;
    log.begin(&request).await.unwrap();
    log.close().await;
}

#[tokio::test]
async fn an_outcome_that_could_not_be_written_is_shown_and_rewritten_later() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = OperationLog::new(db);
    let request = request("command");
    let id = log.begin(&request).await.unwrap();

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
    let log = OperationLog::new(db);
    let request = request("command");
    let first = log.begin(&request).await.unwrap();
    fail_updates(log.db(), true).await;
    let kept = Finish {
        outcome: Outcome::Ok,
        reason: None,
        audit_id: Some(9),
        finished_at_ms: 1_400,
    };
    assert!(log.complete(&first, kept.clone()).await.is_err());
    // The next request starts while updates still fail (its INSERT works).
    let second = log.begin(&request).await.unwrap();
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
    let log = OperationLog::new(db);
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
    let log = OperationLog::new(db);
    let request = request("command");
    {
        let mut begin = Box::pin(log.begin(&request));
        // Hold the pool's only connection, so the INSERT surely waits.
        let held = log.db().pool.acquire().await.unwrap();
        let first = futures_util::poll!(begin.as_mut());
        assert!(first.is_pending());
        assert!(log.in_flight.lock().unwrap().sending.is_some());
        drop(begin);
        drop(held);
    }
    assert!(log.in_flight.lock().unwrap().sending.is_none());
    log.begin(&request).await.unwrap();
    log.close().await;
}
