//! Capacity is limited on disposable SQLite connections, never on a real volume.
use super::*;
use super::{
    evidence::{ClockStamp, GapEvidence, GapReason, PlanRef, TimedStart},
    query::QueryControl,
    retention::TrimRequest,
    test_support::*,
};
use serde_json::{json, Value};

fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(10)).unwrap()
}
fn start(at: i64) -> TimedStart {
    TimedStart {
        clock_epoch: "clock-a".into(),
        at_ms: at,
        plan: PlanRef {
            plan_id: "plan".into(),
            revision: 1,
        },
    }
}
fn gap(key: &str, from: i64, to: i64) -> GapEvidence {
    GapEvidence {
        session_id: "a".into(),
        gap_id: key.into(),
        clock_epoch: "clock-a".into(),
        from_ms: from,
        to_ms: to,
        observed_at_ms: to,
        reason: GapReason::SamplingMissed,
    }
}
fn table_rows(store: &SqliteStore, table: &str) -> i64 {
    assert!([
        "recording_plans",
        "session_evidence",
        "recording_gaps",
        "retention_operations",
        "expired_samples",
        "capacity_probe"
    ]
    .contains(&table));
    store
        .connection
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn inject_full(store: &mut SqliteStore, at: &str) -> i64 {
    // The trigger executes a real allocation as part of the tested write's tx.
    store
        .connection
        .execute_batch("CREATE TABLE capacity_probe (value BLOB)")
        .unwrap();
    store.connection.execute_batch(&format!("CREATE TEMP TRIGGER exhaust_pages {at} BEGIN INSERT INTO capacity_probe VALUES (zeroblob(1048576)); END;")).unwrap();
    let previous: i64 = store
        .connection
        .query_row("PRAGMA max_page_count", [], |r| r.get(0))
        .unwrap();
    let pages: i64 = store
        .connection
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .unwrap();
    store
        .connection
        .pragma_update(None, "max_page_count", pages)
        .unwrap();
    previous
}
fn restore_capacity(store: &mut SqliteStore, maximum: i64) {
    // Fault removal is private test setup, not a public bypass of NeedsReopen.
    store
        .connection
        .pragma_update(None, "max_page_count", maximum)
        .unwrap();
    store
        .connection
        .execute_batch("DROP TRIGGER exhaust_pages")
        .unwrap();
}
fn full<T: std::fmt::Debug>(result: StoreResult<T>) {
    assert!(
        matches!(&result,Err(StoreError::Sqlite(error)) if error.sqlite_error_code()==Some(rusqlite::ErrorCode::DiskFull)),
        "{result:?}"
    );
}
fn query(reader: &mut query::HistoryReader, mode: &str) -> Value {
    let q = json!({"version":1,"kind":"query","requestId":"q","seriesIds":["number","bool"],"fromMs":0,"toMs":10000,"mode":mode,"maxPointsPerSeries":10});
    let mut result = if mode == "raw" {
        reader.query_raw(&q, &control()).unwrap()
    } else {
        reader.query_minmax(&q, &control()).unwrap()
    };
    result["snapshotId"] = json!("normalized");
    result
}

#[test]
fn full_after_member_insert_rolls_back_tick_epochs_frontier_and_receipt() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_timed_session(spec("a"), start(0)).unwrap();
    let first = tick("a", 1, 1000);
    let receipt = store.append_tick(first.clone()).unwrap();
    let before = counter(&store);
    let evidence = store.session_evidence("a").unwrap();
    let epochs = count(&store, "source_epochs");
    let mut reader = store.reader().unwrap();
    let raw = query(&mut reader, "raw");
    let bins = query(&mut reader, "minmax");
    let maximum = inject_full(
        &mut store,
        "AFTER INSERT ON observations WHEN NEW.series_id='number'",
    );
    let mut failed = tick("a", 2, 2000);
    for observation in &mut failed.observations {
        observation.source_epoch.as_mut().unwrap().sdk_generation = 42;
    }
    full(store.append_tick(failed.clone()));
    assert!(store.needs_reopen);
    assert!(store.connection.is_autocommit());
    assert_eq!(counter(&store), before);
    assert_eq!(count(&store, "observations"), 2);
    assert_eq!(count(&store, "commits"), 1);
    assert_eq!(count(&store, "source_epochs"), epochs);
    assert_eq!(store.session_evidence("a").unwrap(), evidence);
    assert_eq!(table_rows(&store, "capacity_probe"), 0);
    assert_eq!(query(&mut reader, "raw"), raw);
    assert_eq!(query(&mut reader, "minmax"), bins);
    assert!(matches!(
        store.append_tick(first.clone()),
        Err(StoreError::NeedsReopen)
    ));
    restore_capacity(&mut store, maximum);
    drop(store);
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &identity()),
        Err(StoreError::Busy)
    ));
    drop(reader);
    let mut store = directory.open();
    let session = store.session_status("a").unwrap().unwrap();
    assert_eq!(session.state, SessionState::Interrupted);
    assert_eq!(session.committed_through, 1);
    assert!(store
        .session_evidence("a")
        .unwrap()
        .unwrap()
        .end_ms
        .is_none());
    assert_eq!(store.append_tick(first).unwrap(), receipt);
    assert!(matches!(
        store.append_tick(failed),
        Err(StoreError::SessionInactive)
    ));
    store.begin_timed_session(spec("b"), start(2000)).unwrap();
    store.append_tick(tick("b", 1, 2000)).unwrap();
    assert_eq!(count(&store, "observations"), 4);
}

#[test]
fn failed_timed_begin_has_no_plan_members_or_partial_identity_and_can_retry() {
    let directory = TempStore::new();
    let mut store = directory.create();
    let maximum = inject_full(&mut store, "BEFORE INSERT ON recording_plans");
    let before = counter(&store);
    full(store.begin_timed_session(spec("a"), start(0)));
    assert!(store.needs_reopen);
    assert_eq!(counter(&store), before);
    for table in ["series", "segments", "sessions", "session_members"] {
        assert_eq!(count(&store, table), 0);
    }
    assert_eq!(table_rows(&store, "recording_plans"), 0);
    assert_eq!(table_rows(&store, "session_evidence"), 0);
    restore_capacity(&mut store, maximum);
    drop(store);
    let mut store = directory.open();
    let begun = store.begin_timed_session(spec("a"), start(0)).unwrap();
    assert_eq!(
        store.begin_timed_session(spec("a"), start(0)).unwrap(),
        begun
    );
    assert_eq!(table_rows(&store, "recording_plans"), 1);
}

#[test]
fn full_gap_does_not_advance_frontier_or_invent_missing_records_on_reopen() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_timed_session(spec("a"), start(0)).unwrap();
    store.append_tick(tick("a", 1, 1000)).unwrap();
    let original = gap("good", 2000, 3000);
    let receipt = store.record_gap(original.clone()).unwrap();
    let maximum = inject_full(&mut store, "AFTER INSERT ON recording_gaps");
    let before = counter(&store);
    let evidence = store.session_evidence("a").unwrap();
    let missing = gap("failed", 4000, 5000);
    full(store.record_gap(missing.clone()));
    assert!(store.needs_reopen);
    assert!(store.connection.is_autocommit());
    assert_eq!(counter(&store), before);
    assert_eq!(store.session_evidence("a").unwrap(), evidence);
    assert_eq!(table_rows(&store, "recording_gaps"), 1);
    restore_capacity(&mut store, maximum);
    drop(store);
    let mut store = directory.open();
    assert_eq!(store.record_gap(original).unwrap(), receipt);
    assert!(matches!(
        store.record_gap(missing),
        Err(StoreError::SessionInactive)
    ));
    let mut reader = store.reader().unwrap();
    let result = query(&mut reader, "raw");
    assert_eq!(
        result["series"][0]["coverage"],
        json!([{"fromMs":0,"toMs":2000,"reason":"unknownCoverage"},{"fromMs":2000,"toMs":3000,"reason":"samplingMissed"},{"fromMs":3000,"toMs":10000,"reason":"unknownCoverage"}])
    );
}

#[test]
fn full_close_rolls_back_normal_end_and_reopen_keeps_the_end_unknown() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_timed_session(spec("a"), start(0)).unwrap();
    store.append_tick(tick("a", 1, 1000)).unwrap();
    let maximum = inject_full(&mut store, "AFTER UPDATE ON session_evidence");
    let before = counter(&store);
    let evidence = store.session_evidence("a").unwrap();
    full(store.close_timed_session(
        "a",
        ClockStamp {
            clock_epoch: "clock-a".into(),
            at_ms: 2000,
        },
    ));
    assert_eq!(counter(&store), before);
    assert_eq!(
        store.session_status("a").unwrap().unwrap().state,
        SessionState::Active
    );
    assert_eq!(store.session_evidence("a").unwrap(), evidence);
    restore_capacity(&mut store, maximum);
    drop(store);
    let store = directory.open();
    assert_eq!(
        store.session_status("a").unwrap().unwrap().state,
        SessionState::Interrupted
    );
    assert!(store
        .session_evidence("a")
        .unwrap()
        .unwrap()
        .end_ms
        .is_none());
}

#[test]
fn full_trim_at_each_stage_restores_raw_ledger_fence_and_retry_identity() {
    for stage in [
        "AFTER INSERT ON retention_operations",
        "AFTER INSERT ON expired_samples",
        "AFTER DELETE ON observations",
        "AFTER UPDATE ON retention_state",
    ] {
        let directory = TempStore::new();
        let mut store = directory.create();
        store.begin_session(spec("a")).unwrap();
        let tick = tick("a", 1, 1000);
        let receipt = store.append_tick(tick.clone()).unwrap();
        store.close_session("a").unwrap();
        let request = TrimRequest {
            request_id: "trim".into(),
            cutoff_ms: 2000,
            expected_cutoff_ms: None,
        };
        let maximum = inject_full(&mut store, stage);
        let before = counter(&store);
        let mut reader = store.reader().unwrap();
        let raw = query(&mut reader, "raw");
        let bins = query(&mut reader, "minmax");
        full(store.trim(request.clone(), &control()));
        assert!(store.needs_reopen);
        assert!(store.connection.is_autocommit());
        assert_eq!(counter(&store), before);
        assert_eq!(count(&store, "observations"), 2);
        assert_eq!(count(&store, "commits"), 1);
        assert_eq!(table_rows(&store, "expired_samples"), 0);
        assert_eq!(table_rows(&store, "retention_operations"), 0);
        assert_eq!(retention::fence(&store.connection).unwrap(), (None, 0));
        assert_eq!(query(&mut reader, "raw"), raw);
        assert_eq!(query(&mut reader, "minmax"), bins);
        restore_capacity(&mut store, maximum);
        drop(reader);
        drop(store);
        let mut store = directory.open();
        let trimmed = store.trim(request.clone(), &control()).unwrap();
        assert_eq!(
            (trimmed.deleted_ticks, trimmed.deleted_observations),
            (1, 2)
        );
        let before = counter(&store);
        assert_eq!(store.trim(request, &control()).unwrap(), trimmed);
        assert_eq!(counter(&store), before);
        assert_eq!(store.append_tick(tick).unwrap(), receipt);
        assert_eq!(count(&store, "observations"), 0);
        let mut reader = store.reader().unwrap();
        assert_eq!(
            query(&mut reader, "raw")["series"][0]["coverage"],
            json!([{"fromMs":0,"toMs":1000,"reason":"unknownCoverage"},{"fromMs":1000,"toMs":1001,"reason":"expired"},{"fromMs":1001,"toMs":10000,"reason":"unknownCoverage"}])
        );
    }
}

#[test]
fn ordinary_append_growth_hits_sqlite_full_without_a_pressure_trigger() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_timed_session(spec("a"), start(0)).unwrap();
    let first = tick("a", 1, 1);
    let mut last_receipt = store.append_tick(first).unwrap();
    let maximum: i64 = store
        .connection
        .query_row("PRAGMA max_page_count", [], |r| r.get(0))
        .unwrap();
    let pages: i64 = store
        .connection
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .unwrap();
    store
        .connection
        .pragma_update(None, "max_page_count", pages)
        .unwrap();
    let mut failed = None;
    for sequence in 2..=256 {
        let before = counter(&store);
        let evidence = store.session_evidence("a").unwrap();
        let pending = tick("a", sequence, sequence as i64);
        match store.append_tick(pending.clone()) {
            Ok(receipt) => last_receipt = receipt,
            Err(error) => {
                full::<CommitReceipt>(Err(error));
                assert!(store.needs_reopen);
                assert!(store.connection.is_autocommit());
                assert_eq!(counter(&store), before);
                assert_eq!(store.session_evidence("a").unwrap(), evidence);
                assert_eq!(
                    count(&store, "commits"),
                    last_receipt.committed_through as i64
                );
                assert_eq!(
                    count(&store, "observations"),
                    last_receipt.committed_through as i64 * 2
                );
                failed = Some(pending);
                break;
            }
        }
    }
    let failed = failed.expect("bounded ordinary append workload must hit the page ceiling");
    store
        .connection
        .pragma_update(None, "max_page_count", maximum)
        .unwrap();
    drop(store);
    let mut store = directory.open();
    let last = tick(
        "a",
        last_receipt.committed_through,
        last_receipt.committed_through as i64,
    );
    assert_eq!(store.append_tick(last).unwrap(), last_receipt);
    assert!(matches!(
        store.append_tick(failed),
        Err(StoreError::SessionInactive)
    ));
}
