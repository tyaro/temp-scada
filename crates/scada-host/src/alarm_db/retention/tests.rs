//! Retention deletion on an isolated temporary alarm DB (terminal settings §3).
use std::sync::Arc;

use super::*;
use crate::alarm_terminal::AlarmTerminal;

const DAY: i64 = MS_PER_DAY;

struct Fixture {
    dir: std::path::PathBuf,
    db: AlarmDb,
    session: Session,
}

/// A DB owned by a running session, with events of `(at_ms, condition,
/// has display)` in seq order from 1 and `last_state` rows for `states`.
async fn fixture(events: &[(i64, Option<&str>, bool)], states: &[&str]) -> Fixture {
    let dir = std::env::temp_dir().join(format!("alarm-retention-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let terminal = Arc::new(AlarmTerminal::open(&dir).await.unwrap());
    let db = AlarmDb::open(terminal, &uuid::Uuid::new_v4().to_string())
        .await
        .unwrap();
    let session = Session {
        id: "session-a".into(),
        generation: 7,
    };
    sqlx::query("INSERT INTO session (id, session_id, generation, stopped) VALUES (1, ?, 7, 0)")
        .bind(&session.id)
        .execute(&db.pool)
        .await
        .unwrap();
    for (at_ms, condition, display) in events {
        sqlx::query("INSERT INTO event (session_id, at_ms, condition_id, kind, detail, display) VALUES ('session-a', ?, ?, 'test', '{}', ?)")
            .bind(at_ms)
            .bind(condition)
            .bind(display.then_some("{}"))
            .execute(&db.pool)
            .await
            .unwrap();
    }
    for id in states {
        sqlx::query("INSERT INTO last_state (condition_id, evaluation_hash, endpoint, state, session_id) VALUES (?, 'h', 'e', '{}', 'session-a')")
            .bind(id)
            .execute(&db.pool)
            .await
            .unwrap();
    }
    Fixture { dir, db, session }
}

impl Fixture {
    async fn seqs(&self) -> Vec<i64> {
        sqlx::query_scalar("SELECT seq FROM event ORDER BY seq")
            .fetch_all(&self.db.pool)
            .await
            .unwrap()
    }

    async fn close(self) {
        self.db.close().await;
        let _ = std::fs::remove_dir_all(self.dir);
    }
}

fn outcome(deleted: u64, reached_batch: bool) -> PruneOutcome {
    PruneOutcome {
        deleted,
        reached_batch,
    }
}

#[tokio::test]
async fn days_delete_the_old_end_skipping_kept_events_and_stop_within_the_limit() {
    // 3 is the newest display event of A (kept), 4 is a later ACK of A
    // without display, B has a state but no event, 6 is the newest (kept).
    let f = fixture(
        &[
            (100, None, false),
            (200, Some("A"), true),
            (300, Some("A"), true),
            (400, Some("A"), false),
            (5_000, None, false),
            (6_000, None, false),
        ],
        &["A", "B"],
    )
    .await;
    assert_eq!(
        f.db.retention_status().await.unwrap(),
        RetentionStatus {
            event_count: 6,
            oldest_at_ms: Some(100),
        }
    );
    let now = DAY + 1_000;
    let result =
        f.db.prune(&f.session, RetentionLimit::Days(1), now, 100)
            .await;
    assert_eq!(result.unwrap(), outcome(3, false));
    assert_eq!(f.seqs().await, vec![3, 5, 6]);
    // The kept event is not reported as the oldest one.
    assert_eq!(
        f.db.retention_status().await.unwrap(),
        RetentionStatus {
            event_count: 3,
            oldest_at_ms: Some(5_000),
        }
    );
    // Nothing more has expired.
    let again =
        f.db.prune(&f.session, RetentionLimit::Days(1), now, 100)
            .await;
    assert_eq!(again.unwrap(), outcome(0, false));
    f.close().await;
}

#[tokio::test]
async fn a_head_event_from_a_clock_jump_stops_the_deletion_without_a_hole() {
    // The wall clock was ahead at seq 1 and went back afterwards.
    let f = fixture(
        &[
            (9_000, None, false),
            (100, None, false),
            (200, None, false),
            (300, None, false),
        ],
        &[],
    )
    .await;
    let result =
        f.db.prune(&f.session, RetentionLimit::Days(1), DAY + 1_000, 100)
            .await;
    assert_eq!(result.unwrap(), outcome(0, false));
    assert_eq!(f.seqs().await, vec![1, 2, 3, 4]);
    // Once that time is past the limit, the old end moves on.
    let result =
        f.db.prune(&f.session, RetentionLimit::Days(1), DAY + 10_000, 100)
            .await;
    assert_eq!(result.unwrap(), outcome(3, false));
    assert_eq!(f.seqs().await, vec![4]);
    f.close().await;
}

#[tokio::test]
async fn count_deletes_seqs_at_or_below_the_newest_seq_minus_the_count() {
    // Seq 2 is the newest display event of A and stays beyond the count.
    let mut events = vec![(1, None, false); 10];
    events[1] = (1, Some("A"), true);
    let f = fixture(&events, &["A"]).await;
    // The time does not matter for a count limit.
    let result =
        f.db.prune(&f.session, RetentionLimit::Count(3), 0, 100)
            .await;
    assert_eq!(result.unwrap(), outcome(6, false));
    assert_eq!(f.seqs().await, vec![2, 8, 9, 10]);
    f.close().await;
}

#[tokio::test]
async fn one_round_deletes_at_most_the_batch_and_reports_the_rest() {
    let f = fixture(&[(1, None, false); 10], &[]).await;
    let limit = RetentionLimit::Days(1);
    let now = 2 * DAY;
    let first = f.db.prune(&f.session, limit, now, 4).await.unwrap();
    assert_eq!(first, outcome(4, true));
    assert_eq!(f.seqs().await, (5..=10).collect::<Vec<_>>());
    let second = f.db.prune(&f.session, limit, now, 4).await.unwrap();
    assert_eq!(second, outcome(4, true));
    // The newest event is kept, so one is left to delete.
    let third = f.db.prune(&f.session, limit, now, 4).await.unwrap();
    assert_eq!(third, outcome(1, false));
    assert_eq!(f.seqs().await, vec![10]);
    f.close().await;
}

#[tokio::test]
async fn a_db_owned_by_another_session_is_not_deleted() {
    let f = fixture(&[(1, None, false); 5], &[]).await;
    let limit = RetentionLimit::Days(1);
    let stale = Session {
        id: f.session.id.clone(),
        generation: 6,
    };
    let result = f.db.prune(&stale, limit, 2 * DAY, 100).await;
    assert!(matches!(result, Err(AlarmDbError::InvalidRow)));
    let other = Session {
        id: "session-b".into(),
        generation: 7,
    };
    let result = f.db.prune(&other, limit, 2 * DAY, 100).await;
    assert!(matches!(result, Err(AlarmDbError::InvalidRow)));
    // A stopped session no longer owns the DB either.
    sqlx::query("UPDATE session SET stopped = 1")
        .execute(&f.db.pool)
        .await
        .unwrap();
    let result = f.db.prune(&f.session, limit, 2 * DAY, 100).await;
    assert!(matches!(result, Err(AlarmDbError::InvalidRow)));
    assert_eq!(f.seqs().await, vec![1, 2, 3, 4, 5]);
    f.close().await;
}

#[tokio::test]
async fn an_empty_db_has_no_oldest_event_and_nothing_to_delete() {
    let f = fixture(&[], &["A"]).await;
    assert_eq!(
        f.db.retention_status().await.unwrap(),
        RetentionStatus {
            event_count: 0,
            oldest_at_ms: None,
        }
    );
    let result =
        f.db.prune(&f.session, RetentionLimit::Count(10_000), 0, 100)
            .await;
    assert_eq!(result.unwrap(), outcome(0, false));
    f.close().await;
}
