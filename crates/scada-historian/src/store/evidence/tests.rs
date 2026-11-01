use super::*;
use crate::store::test_support::*;
use crate::store::{query::QueryControl, STORE_FORMAT_VERSION};
use serde_json::json;
use std::{process::Command, time::Duration};

fn start(at_ms: i64) -> TimedStart {
    TimedStart {
        clock_epoch: "clock-a".into(),
        at_ms,
        plan: PlanRef {
            plan_id: "plan-a".into(),
            revision: 1,
        },
    }
}
fn stamp(at_ms: i64) -> ClockStamp {
    ClockStamp {
        clock_epoch: "clock-a".into(),
        at_ms,
    }
}
fn gap(session: &str, id: &str, from: i64, to: i64, observed: i64) -> GapEvidence {
    GapEvidence {
        session_id: session.into(),
        gap_id: id.into(),
        clock_epoch: "clock-a".into(),
        from_ms: from,
        to_ms: to,
        observed_at_ms: observed,
        reason: GapReason::SamplingMissed,
    }
}
fn evidence_count(store: &SqliteStore, table: &str) -> i64 {
    assert!(["recording_plans", "session_evidence", "recording_gaps"].contains(&table));
    store
        .connection
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn timed_lifecycle_saves_plan_and_boundaries_with_stable_receipts() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let begun = store
        .begin_timed_session(spec("session-a"), start(0))
        .unwrap();
    let first = tick("session-a", 1, 1000);
    let receipt = store.append_tick(first.clone()).unwrap();
    let missing = gap("session-a", "gap-a", 2000, 3000, 3000);
    let gap_receipt = store.record_gap(missing.clone()).unwrap();
    assert!(gap_receipt.commit_version > receipt.commit_version);
    assert_eq!(
        store
            .session_status("session-a")
            .unwrap()
            .unwrap()
            .committed_through,
        1
    );
    store.append_tick(tick("session-a", 2, 3000)).unwrap();
    let closed = store.close_timed_session("session-a", stamp(4000)).unwrap();
    let e = store.session_evidence("session-a").unwrap().unwrap();
    assert_eq!(e.start, start(0));
    assert_eq!(e.end_ms, Some(4000));
    assert_eq!(e.observed_frontier_ms, 4000);
    assert_eq!(
        store
            .begin_timed_session(spec("session-a"), start(0))
            .unwrap(),
        closed
    );
    assert_eq!(
        store.close_timed_session("session-a", stamp(4000)).unwrap(),
        closed
    );
    assert_eq!(store.record_gap(missing.clone()).unwrap(), gap_receipt);
    assert_eq!(store.append_tick(first.clone()).unwrap(), receipt);
    assert_eq!(closed.begin_commit_version, begun.begin_commit_version);
    let baseline = counter(&store);
    drop(store);
    let mut store = directory.open();
    assert_eq!(store.session_evidence("session-a").unwrap().unwrap(), e);
    assert_eq!(store.record_gap(missing).unwrap(), gap_receipt);
    assert_eq!(store.append_tick(first).unwrap(), receipt);
    assert_eq!(counter(&store), baseline);
}

#[test]
fn immutable_plan_content_is_canonical_and_cannot_be_rewritten_by_a_new_session() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store
        .begin_timed_session(spec("session-a"), start(0))
        .unwrap();
    store.close_timed_session("session-a", stamp(1000)).unwrap();
    let mut next = spec("session-b");
    next.members.reverse();
    store.begin_timed_session(next, start(1000)).unwrap();
    store.close_timed_session("session-b", stamp(2000)).unwrap();
    assert_eq!(evidence_count(&store, "recording_plans"), 1);
    let mut changed = spec("session-c");
    changed.members.pop();
    let baseline = counter(&store);
    assert!(matches!(
        store.begin_timed_session(changed.clone(), start(2000)),
        Err(StoreError::Conflict)
    ));
    assert_eq!(counter(&store), baseline);
    assert_eq!(count(&store, "sessions"), 2);
    let mut revision = start(2000);
    revision.plan.revision = 2;
    store.begin_timed_session(changed, revision).unwrap();
    assert_eq!(evidence_count(&store, "recording_plans"), 2);
}

#[test]
fn timing_evidence_cannot_be_added_omitted_or_changed_by_retries() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("untimed")).unwrap();
    assert!(matches!(
        store.begin_timed_session(spec("untimed"), start(0)),
        Err(StoreError::Conflict)
    ));
    assert!(store.close_timed_session("untimed", stamp(1000)).is_err());
    assert!(store
        .record_gap(gap("untimed", "g", 0, 1000, 1000))
        .is_err());
    assert!(store.session_evidence("untimed").unwrap().is_none());
    store.close_session("untimed").unwrap();
    store.begin_timed_session(spec("timed"), start(0)).unwrap();
    assert!(matches!(
        store.begin_session(spec("timed")),
        Err(StoreError::Conflict)
    ));
    assert!(matches!(
        store.begin_timed_session(spec("timed"), start(1)),
        Err(StoreError::Conflict)
    ));
    assert!(store.close_session("timed").is_err());
    store.close_timed_session("timed", stamp(1000)).unwrap();
    assert!(matches!(
        store.close_timed_session("timed", stamp(2000)),
        Err(StoreError::Conflict)
    ));
    assert_eq!(
        store.session_evidence("timed").unwrap().unwrap().end_ms,
        Some(1000)
    );
}

#[test]
fn timed_clock_is_monotonic_with_equal_tick_times_and_explicit_interruption_on_rollback() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store
        .begin_timed_session(spec("session-a"), start(1000))
        .unwrap();
    assert!(store.append_tick(tick("session-a", 1, 999)).is_err());
    store.append_tick(tick("session-a", 1, 1000)).unwrap();
    store.append_tick(tick("session-a", 2, 1000)).unwrap();
    assert!(store.close_timed_session("session-a", stamp(1000)).is_err());
    let mut wrong = tick("session-a", 3, 2000);
    wrong.clock_epoch = "clock-b".into();
    assert!(store.append_tick(wrong).is_err());
    let stopped = store.interrupt_session("session-a").unwrap();
    assert_eq!(stopped.state, SessionState::Interrupted);
    assert_eq!(store.interrupt_session("session-a").unwrap(), stopped);
    assert!(store
        .session_evidence("session-a")
        .unwrap()
        .unwrap()
        .end_ms
        .is_none());
    assert!(matches!(
        store.close_timed_session("session-a", stamp(2000)),
        Err(StoreError::SessionInactive)
    ));
    let mut next = start(500);
    next.clock_epoch = "clock-b".into();
    store.begin_timed_session(spec("session-b"), next).unwrap();
    let mut input = tick("session-b", 1, 500);
    input.clock_epoch = "clock-b".into();
    store.append_tick(input).unwrap();
}

#[test]
fn gaps_reject_existing_records_including_null_and_preserve_half_open_edges() {
    for null in [false, true] {
        let directory = TempStore::new();
        let mut store = directory.create();
        store
            .begin_timed_session(spec("session-a"), start(0))
            .unwrap();
        let mut input = tick("session-a", 1, 1000);
        if null {
            for o in &mut input.observations {
                o.value = None;
                o.quality = Some(super::super::Quality::Bad);
                o.reason = Some(super::super::Reason::Bad);
            }
        }
        store.append_tick(input).unwrap();
        assert!(matches!(
            store.record_gap(gap("session-a", "overlap", 1000, 2000, 2000)),
            Err(StoreError::Conflict)
        ));
        assert_eq!(evidence_count(&store, "recording_gaps"), 0);
        // A record at the exclusive end is outside this retrospective gap.
        store
            .record_gap(gap("session-a", "before", 0, 1000, 1000))
            .unwrap();
        store
            .record_gap(gap("session-a", "after", 2000, 3000, 3000))
            .unwrap();
        assert!(store.append_tick(tick("session-a", 2, 2500)).is_err());
        store.append_tick(tick("session-a", 2, 3000)).unwrap();
        assert_eq!(count(&store, "observations"), 4);
    }
}

#[test]
fn gaps_are_nonoverlapping_replayable_and_never_advance_tick_sequence() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store
        .begin_timed_session(spec("session-a"), start(0))
        .unwrap();
    let first = gap("session-a", "g1", 1000, 2000, 2000);
    let receipt = store.record_gap(first.clone()).unwrap();
    store
        .record_gap(gap("session-a", "g2", 2000, 3000, 4000))
        .unwrap();
    for (a, b) in [(1000, 2000), (1500, 2500), (500, 4000), (1500, 1600)] {
        assert!(matches!(
            store.record_gap(gap("session-a", "overlap", a, b, 4000)),
            Err(StoreError::Conflict)
        ));
    }
    assert_eq!(store.record_gap(first.clone()).unwrap(), receipt);
    let mut changed = first;
    changed.reason = GapReason::StorageLoss;
    assert!(matches!(
        store.record_gap(changed),
        Err(StoreError::Conflict)
    ));
    assert_eq!(
        store
            .session_status("session-a")
            .unwrap()
            .unwrap()
            .committed_through,
        0
    );
    assert!(store.append_tick(tick("session-a", 1, 3500)).is_err()); // Before observed frontier.
    store.append_tick(tick("session-a", 1, 4000)).unwrap();
    assert_eq!(
        store
            .session_status("session-a")
            .unwrap()
            .unwrap()
            .committed_through,
        1
    );
}

#[test]
fn evidence_domains_do_not_erase_another_sessions_overlapping_utc_record() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store
        .begin_timed_session(spec("session-a"), start(0))
        .unwrap();
    store.append_tick(tick("session-a", 1, 1000)).unwrap();
    store.interrupt_session("session-a").unwrap();
    store
        .begin_timed_session(spec("session-b"), start(0))
        .unwrap();
    store
        .record_gap(gap("session-b", "g", 0, 2000, 2000))
        .unwrap();
    let mut reader = store.reader().unwrap();
    let query = json!({"version":1,"kind":"query","requestId":"q","seriesIds":["number"],"fromMs":0,"toMs":2000,"mode":"raw","maxPointsPerSeries":1});
    let result = reader
        .query_raw(
            &query,
            &QueryControl::with_timeout(Duration::from_secs(10)).unwrap(),
        )
        .unwrap();
    assert_eq!(
        result["series"][0]["raw"][0]["recordId"]["sessionId"],
        "session-a"
    );
    assert_eq!(
        result["series"][0]["coverage"][0]["reason"],
        "unknownCoverage"
    );
    let mut minmax = query;
    minmax["mode"] = json!("minmax");
    let result = reader
        .query_minmax(
            &minmax,
            &QueryControl::with_timeout(Duration::from_secs(10)).unwrap(),
        )
        .unwrap();
    assert_eq!(result["series"][0]["bins"][0]["state"], "partial");
    assert_eq!(result["series"][0]["bins"][0]["validCount"], 1);
}

#[test]
fn invalid_evidence_ranges_domains_revisions_and_frontiers_leave_no_partial_state() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut bad = start(0);
    bad.plan.revision = 0;
    assert!(store.begin_timed_session(spec("session-a"), bad).is_err());
    assert_eq!(counter(&store), 0);
    store
        .begin_timed_session(spec("session-a"), start(1000))
        .unwrap();
    store.append_tick(tick("session-a", 1, 2000)).unwrap();
    let baseline = counter(&store);
    for mut g in [
        gap("session-a", "g", 999, 2000, 3000),
        gap("session-a", "g", 2000, 2000, 3000),
        gap("session-a", "g", 3000, 4000, 3000),
        gap("session-a", "g", 1000, 1500, 1500),
    ] {
        assert!(store.record_gap(g.clone()).is_err());
        g.clock_epoch = "clock-b".into();
        assert!(store.record_gap(g).is_err());
    }
    assert_eq!(counter(&store), baseline);
    assert_eq!(evidence_count(&store, "recording_gaps"), 0);
    let invalid = serde_json::to_value(gap("session-a", "g", 3000, 4000, 4000)).unwrap();
    let mut bad = invalid.clone();
    bad["reason"] = json!("expired");
    assert!(serde_json::from_value::<GapEvidence>(bad).is_err());
    let mut bad = invalid;
    bad["seriesIds"] = json!(["number"]);
    assert!(serde_json::from_value::<GapEvidence>(bad).is_err());
    assert!(store.close_timed_session("session-a", stamp(1999)).is_err());
    assert_eq!(
        store
            .session_evidence("session-a")
            .unwrap()
            .unwrap()
            .observed_frontier_ms,
        2000
    );
}

#[test]
fn precommit_failures_roll_back_plan_boundaries_gaps_and_frontier_together() {
    for at in [Boundary::Metadata, Boundary::BeforeCommit] {
        let directory = TempStore::new();
        let mut store = directory.create();
        assert!(store
            .begin_evidence_with_hook(spec("session-a"), Some(start(0)), &mut |b| if b == at {
                invalid("fault")
            } else {
                Ok(())
            })
            .is_err());
        assert_eq!(counter(&store), 0);
        assert_eq!(count(&store, "sessions"), 0);
        assert_eq!(evidence_count(&store, "recording_plans"), 0);
        assert_eq!(evidence_count(&store, "session_evidence"), 0);
        store
            .begin_timed_session(spec("session-a"), start(0))
            .unwrap();
        let baseline = counter(&store);
        assert!(store
            .gap_with_hook(
                gap("session-a", "g", 1000, 2000, 2000),
                &mut |b| if b == at { invalid("fault") } else { Ok(()) }
            )
            .is_err());
        assert_eq!(counter(&store), baseline);
        assert_eq!(evidence_count(&store, "recording_gaps"), 0);
        assert_eq!(
            store
                .session_evidence("session-a")
                .unwrap()
                .unwrap()
                .observed_frontier_ms,
            0
        );
        assert!(store
            .append_with_hook(tick("session-a", 1, 1000), &mut |b| if b == at {
                invalid("fault")
            } else {
                Ok(())
            })
            .is_err());
        assert_eq!(
            store
                .session_evidence("session-a")
                .unwrap()
                .unwrap()
                .observed_frontier_ms,
            0
        );
        assert_eq!(count(&store, "observations"), 0);
        assert!(store
            .close_evidence_with_hook("session-a", Some(stamp(2000)), &mut |b| if b == at {
                invalid("fault")
            } else {
                Ok(())
            })
            .is_err());
        assert_eq!(
            store.session_status("session-a").unwrap().unwrap().state,
            SessionState::Active
        );
        assert!(store
            .session_evidence("session-a")
            .unwrap()
            .unwrap()
            .end_ms
            .is_none());
        assert_eq!(counter(&store), baseline);
    }
}

#[test]
fn format_one_and_mismatched_metadata_are_refused_without_rewriting_the_database() {
    let directory = TempStore::new();
    let store = directory.create();
    assert_eq!(
        store
            .connection
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        STORE_FORMAT_VERSION
    );
    drop(store);
    let path = directory.0.join("store.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("PRAGMA user_version=1").unwrap();
    drop(connection);
    let bytes = std::fs::read(&path).unwrap();
    assert!(matches!(
        reopen_unowned(&directory.0, &identity()),
        Err(StoreError::UnsupportedStore)
    ));
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("PRAGMA user_version=4; PRAGMA ignore_check_constraints=ON; UPDATE store_meta SET format_version=1").unwrap();
    drop(connection);
    let bytes = std::fs::read(&path).unwrap();
    assert!(matches!(
        reopen_unowned(&directory.0, &identity()),
        Err(StoreError::UnsupportedStore)
    ));
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[test]
fn sql_failure_rolls_back_gap_and_frontier_and_requires_reopen_before_more_writes() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store
        .begin_timed_session(spec("session-a"), start(0))
        .unwrap();
    let baseline = counter(&store);
    store.connection.execute_batch("CREATE TEMP TRIGGER reject_frontier BEFORE UPDATE ON session_evidence BEGIN SELECT RAISE(ABORT, 'injected evidence failure'); END;").unwrap();
    assert!(matches!(
        store.record_gap(gap("session-a", "g", 1000, 2000, 2000)),
        Err(StoreError::Sqlite(_))
    ));
    assert_eq!(counter(&store), baseline);
    assert_eq!(evidence_count(&store, "recording_gaps"), 0);
    assert_eq!(
        store
            .session_evidence("session-a")
            .unwrap()
            .unwrap()
            .observed_frontier_ms,
        0
    );
    assert!(matches!(
        store.record_gap(gap("session-a", "g", 1000, 2000, 2000)),
        Err(StoreError::NeedsReopen)
    ));
    drop(store);
    let mut store = directory.open();
    assert_eq!(
        store.session_status("session-a").unwrap().unwrap().state,
        SessionState::Interrupted
    );
    assert!(store
        .session_evidence("session-a")
        .unwrap()
        .unwrap()
        .end_ms
        .is_none());
    store
        .begin_timed_session(spec("session-b"), start(0))
        .unwrap();
    assert!(store
        .record_gap(gap("session-b", "g", 1000, 2000, 2000))
        .is_ok());
}

#[test]
fn evidence_time_and_revision_limits_are_exact_and_do_not_borrow_query_window_limits() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let mut begin = start(-(MAX_SAFE as i64));
    begin.plan.revision = MAX_SAFE;
    store.begin_timed_session(spec("session-a"), begin).unwrap();
    let mut bad = gap("session-a", "g", -(MAX_SAFE as i64) - 1, 0, 0);
    assert!(store.record_gap(bad.clone()).is_err());
    bad.from_ms = 0;
    bad.to_ms = MAX_SAFE as i64 + 1;
    bad.observed_at_ms = MAX_SAFE as i64 + 1;
    assert!(store.record_gap(bad).is_err());
    store
        .record_gap(gap(
            "session-a",
            "g",
            -(MAX_SAFE as i64),
            MAX_SAFE as i64,
            MAX_SAFE as i64,
        ))
        .unwrap();
    store
        .close_timed_session("session-a", stamp(MAX_SAFE as i64))
        .unwrap();
    let evidence = store.session_evidence("session-a").unwrap().unwrap();
    assert_eq!(evidence.start.plan.revision, MAX_SAFE);
    assert_eq!(evidence.end_ms, Some(MAX_SAFE as i64));
}

#[test]
fn process_exit_before_or_after_commit_preserves_exact_evidence_and_retry_receipts() {
    for mode in [
        "begin-before",
        "begin-after",
        "gap-before",
        "gap-after",
        "close-before",
        "close-after",
        "tick-before",
    ] {
        let directory = TempStore::new();
        drop(directory.create());
        let exit = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store::evidence::tests::process_worker",
                "--nocapture",
            ])
            .env("SCADA_EVIDENCE_DIR", &directory.0)
            .env("SCADA_EVIDENCE_MODE", mode)
            .status()
            .unwrap();
        assert_eq!(exit.code(), Some(73), "{mode}");
        let mut store = directory.open();
        if mode == "begin-before" {
            assert_eq!(evidence_count(&store, "recording_plans"), 0);
            assert!(store.session_status("session-a").unwrap().is_none());
            continue;
        }
        let session = store.session_status("session-a").unwrap().unwrap();
        let e = store.session_evidence("session-a").unwrap().unwrap();
        assert_eq!(
            e.end_ms,
            if mode == "close-after" {
                Some(4000)
            } else {
                None
            }
        );
        assert_eq!(
            session.state,
            if mode == "close-after" {
                SessionState::Closed
            } else {
                SessionState::Interrupted
            }
        );
        if mode.starts_with("gap") {
            assert_eq!(
                evidence_count(&store, "recording_gaps"),
                i64::from(mode == "gap-after")
            );
            assert_eq!(
                e.observed_frontier_ms,
                if mode == "gap-after" { 2000 } else { 0 }
            );
            if mode == "gap-after" {
                let baseline = counter(&store);
                let a = store
                    .record_gap(gap("session-a", "g", 1000, 2000, 2000))
                    .unwrap();
                let b = store
                    .record_gap(gap("session-a", "g", 1000, 2000, 2000))
                    .unwrap();
                assert_eq!(a, b);
                assert_eq!(counter(&store), baseline);
            }
        }
        if mode == "close-after" {
            assert_eq!(
                store.close_timed_session("session-a", stamp(4000)).unwrap(),
                session
            );
        }
        if mode == "tick-before" {
            assert_eq!(count(&store, "observations"), 0);
            assert_eq!(e.observed_frontier_ms, 0);
        }
        assert_eq!(
            store
                .begin_timed_session(spec("session-a"), start(0))
                .unwrap(),
            session
        );
    }
}

#[test]
fn process_worker() {
    let Some(directory) = std::env::var_os("SCADA_EVIDENCE_DIR") else {
        return;
    };
    let mode = std::env::var("SCADA_EVIDENCE_MODE").unwrap();
    let mut store = reopen_unowned(directory, &identity()).unwrap();
    let boundary = if mode.ends_with("after") {
        Boundary::AfterCommit
    } else {
        Boundary::BeforeCommit
    };
    let mut crash = |at| -> StoreResult<()> {
        if at == boundary {
            std::process::exit(73);
        }
        Ok(())
    };
    if mode.starts_with("begin") {
        store
            .begin_evidence_with_hook(spec("session-a"), Some(start(0)), &mut crash)
            .unwrap();
    } else {
        store
            .begin_timed_session(spec("session-a"), start(0))
            .unwrap();
        if mode.starts_with("gap") {
            store
                .gap_with_hook(gap("session-a", "g", 1000, 2000, 2000), &mut crash)
                .unwrap();
        } else if mode.starts_with("close") {
            store.append_tick(tick("session-a", 1, 1000)).unwrap();
            store
                .close_evidence_with_hook("session-a", Some(stamp(4000)), &mut crash)
                .unwrap();
        } else {
            store
                .append_with_hook(tick("session-a", 1, 1000), &mut crash)
                .unwrap();
        }
    }
    panic!("fault boundary not reached");
}
