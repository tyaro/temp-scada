use serde_json::json;

use super::*;
use crate::operation_db::{Finish, Outcome, RequestRecord};

fn temp_file() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("operation-retention-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("operations.db")
}

fn request_at(at: i64) -> RequestRecord {
    RequestRecord {
        requested_at_ms: at,
        user: "未ログイン".into(),
        phase: "setup".into(),
        hub_endpoint: None,
        project_id: "p".into(),
        project_digest: "d".into(),
        screen_id: "main".into(),
        object_id: "pump1".into(),
        equipment_id: "eq-1".into(),
        equipment_code: None,
        slot: "x".into(),
        tag: None,
        value: json!(true),
    }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

const DAY: i64 = MS_PER_DAY;

fn finished(at: i64) -> Finish {
    Finish {
        outcome: Outcome::Ok,
        reason: None,
        audit_id: None,
        finished_at_ms: at,
    }
}

/// A record with one finished row per time in `times` (in that order).
async fn record_with(times: &[i64]) -> OperationDb {
    let (db, _) = OperationDb::open(&temp_file(), 0).await.unwrap();
    for &at in times {
        db.insert_finished(&new_id(), &request_at(at), &finished(at))
            .await
            .unwrap();
    }
    db
}

async fn times_of(db: &OperationDb) -> Vec<i64> {
    sqlx::query_scalar("SELECT requested_at_ms FROM operation ORDER BY requested_at_ms, seq")
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

fn limit(days: u32, count: u32) -> OperationRetention {
    OperationRetention { days, count }
}

#[tokio::test]
async fn rows_older_than_the_days_go_from_the_old_end() {
    let now = 400 * DAY;
    let db = record_with(&[now - 40 * DAY, now - 31 * DAY, now - 29 * DAY, now]).await;
    let outcome = db.prune(limit(30, 100), now, PRUNE_BATCH).await.unwrap();
    assert_eq!(
        outcome,
        PruneOutcome {
            deleted: 2,
            reached_batch: false
        }
    );
    assert_eq!(times_of(&db).await, vec![now - 29 * DAY, now]);
    db.close().await;
}

#[tokio::test]
async fn rows_beyond_the_count_go_even_within_the_days() {
    let now = 10 * DAY;
    let db = record_with(&[now - 4, now - 3, now - 2, now - 1, now]).await;
    let outcome = db.prune(limit(365, 2), now, PRUNE_BATCH).await.unwrap();
    assert_eq!(outcome.deleted, 3);
    assert_eq!(times_of(&db).await, vec![now - 1, now]);
    db.close().await;
}

#[tokio::test]
async fn whichever_limit_deletes_more_applies() {
    let now = 400 * DAY;
    // The days expire three rows, the count one: three go.
    let db = record_with(&[now - 50 * DAY, now - 40 * DAY, now - 35 * DAY, now - DAY]).await;
    assert_eq!(
        db.prune(limit(30, 3), now, PRUNE_BATCH)
            .await
            .unwrap()
            .deleted,
        3
    );
    assert_eq!(times_of(&db).await, vec![now - DAY]);
    db.close().await;
}

#[tokio::test]
async fn a_pending_row_is_never_deleted_but_is_counted() {
    let now = 400 * DAY;
    let (db, _) = OperationDb::open(&temp_file(), 0).await.unwrap();
    db.insert_pending("p-old", &request_at(now - 100 * DAY))
        .await
        .unwrap();
    for at in [now - 90 * DAY, now - 2, now - 1] {
        db.insert_finished(&new_id(), &request_at(at), &finished(at))
            .await
            .unwrap();
    }
    // The days expire the old finished row; the pending one stays. The
    // count (2) counts the pending row too: one more finished row goes.
    let outcome = db.prune(limit(30, 2), now, PRUNE_BATCH).await.unwrap();
    assert_eq!(outcome.deleted, 2);
    assert_eq!(times_of(&db).await, vec![now - 100 * DAY, now - 1]);
    assert_eq!(
        db.retention_status().await.unwrap(),
        RetentionStatus {
            row_count: 2,
            oldest_requested_at_ms: Some(now - 100 * DAY),
        }
    );
    db.close().await;
}

#[tokio::test]
async fn a_round_stops_at_the_batch_and_the_next_one_continues() {
    let now = 400 * DAY;
    let db = record_with(&[1, 2, 3, now]).await;
    let first = db.prune(limit(30, 100), now, 2).await.unwrap();
    assert_eq!(
        first,
        PruneOutcome {
            deleted: 2,
            reached_batch: true
        }
    );
    let second = db.prune(limit(30, 100), now, 2).await.unwrap();
    assert_eq!(
        second,
        PruneOutcome {
            deleted: 1,
            reached_batch: false
        }
    );
    assert_eq!(times_of(&db).await, vec![now]);
    db.close().await;
}

#[tokio::test]
async fn the_log_answers_the_delay_of_the_next_round() {
    let now = 400 * DAY;
    let log = OperationLog::new(record_with(&[1, 2, 3, now]).await);
    log.set_retention(limit(30, 10_000)).await.unwrap();
    assert_eq!(log.prune_at(now, 2).await, PRUNE_CONTINUE);
    assert_eq!(log.prune_at(now, 2).await, PRUNE_INTERVAL);
    assert_eq!(log.retention_status().await.unwrap().row_count, 1);
    // A failure is logged and retried at the next round.
    log.db()
        .execute_for_test("DROP INDEX operation_requested; DROP TABLE operation;")
        .await;
    assert_eq!(log.prune_at(now, 2).await, PRUNE_INTERVAL);
    log.close().await;
}

#[tokio::test]
async fn the_retention_is_the_default_until_saved_and_survives_a_restart() {
    let file = temp_file();
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = OperationLog::new(db);
    assert_eq!(log.retention(), limit(365, 100_000));
    log.set_min_interval(2_000).await.unwrap();
    log.set_retention(limit(30, 20_000)).await.unwrap();
    log.close().await;

    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = OperationLog::new(db);
    assert_eq!(log.retention(), limit(30, 20_000));
    // Saving one setting keeps the other.
    assert_eq!(log.min_interval(), Duration::from_secs(2));
    log.close().await;

    // Saved first, the retention leaves the interval at its default.
    let (db, _) = OperationDb::open(&temp_file(), 0).await.unwrap();
    let log = OperationLog::new(db);
    log.set_retention(limit(1, 10_000_000)).await.unwrap();
    assert_eq!(log.min_interval(), Duration::from_secs(1));
    log.set_min_interval(3_000).await.unwrap();
    assert_eq!(log.retention(), limit(1, 10_000_000));
    log.close().await;
}

#[tokio::test]
async fn a_retention_out_of_range_changes_nothing() {
    let (db, _) = OperationDb::open(&temp_file(), 0).await.unwrap();
    let log = OperationLog::new(db);
    for bad in [
        limit(0, 100_000),
        limit(3_651, 100_000),
        limit(365, 9_999),
        limit(365, 10_000_001),
    ] {
        assert!(
            matches!(
                log.set_retention(bad).await,
                Err(OperationDbError::InvalidSetting)
            ),
            "{bad:?}"
        );
    }
    assert_eq!(log.retention(), OperationRetention::default());
    // The table refuses the same values, and a REAL.
    for sql in [
        "UPDATE terminal_settings SET retention_days = 0",
        "UPDATE terminal_settings SET retention_days = 30.5",
        "UPDATE terminal_settings SET retention_count = 9999",
    ] {
        log.set_retention(limit(30, 20_000)).await.unwrap();
        assert!(
            sqlx::query(sql).execute(&log.db().pool).await.is_err(),
            "{sql}"
        );
    }
    log.close().await;
}

#[tokio::test]
async fn a_change_of_the_retention_runs_a_round_at_once() {
    let now = wall_ms();
    let log = std::sync::Arc::new(OperationLog::new(
        record_with(&[now - 100 * DAY, now - 50 * DAY, now]).await,
    ));
    let task = tokio::spawn(run_retention(std::sync::Arc::downgrade(&log)));
    // The first round (the default 365 days) keeps every row.
    let rows = || async { log.retention_status().await.unwrap().row_count };
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(rows().await, 3);
    log.set_retention(limit(30, 10_000)).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while rows().await != 1 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the change runs a round");
    task.abort();
    let _ = task.await;
    std::sync::Arc::try_unwrap(log)
        .ok()
        .expect("the loop holds the log only during a round")
        .close()
        .await;
}
