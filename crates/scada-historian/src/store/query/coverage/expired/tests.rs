use super::*;
use crate::store::{
    evidence::{ClockStamp, GapEvidence, GapReason, PlanRef, TimedStart},
    query::{Boundary, QueryControl},
    retention::TrimRequest,
    test_support::*,
    SqliteStore,
};
use std::time::Duration;

fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(10)).unwrap()
}
fn request(from: i64, to: i64, mode: &str, points: i64) -> Value {
    json!({"version":1,"kind":"query","requestId":"q","seriesIds":["number"],"fromMs":from,"toMs":to,"mode":mode,"maxPointsPerSeries":points})
}
fn trim(store: &mut SqliteStore, cutoff: i64, expected: Option<i64>) {
    store
        .trim(
            TrimRequest {
                request_id: format!("trim-{cutoff}"),
                cutoff_ms: cutoff,
                expected_cutoff_ms: expected,
            },
            &control(),
        )
        .unwrap();
}
fn range(from: i64, to: i64, reason: &str) -> Value {
    json!({"fromMs":from,"toMs":to,"reason":reason})
}
fn query(reader: &mut crate::store::query::HistoryReader, q: &Value) -> Result<Value, QueryError> {
    if q["mode"] == "raw" {
        reader.query_raw(q, &control())
    } else {
        reader.query_minmax(q, &control())
    }
}
fn begin(store: &mut SqliteStore, session: &str, at: i64) {
    store
        .begin_timed_session(
            spec(session),
            TimedStart {
                clock_epoch: "clock-a".into(),
                at_ms: at,
                plan: PlanRef {
                    plan_id: "plan".into(),
                    revision: 1,
                },
            },
        )
        .unwrap();
}
fn close(store: &mut SqliteStore, session: &str, at: i64) {
    store
        .close_timed_session(
            session,
            ClockStamp {
                clock_epoch: "clock-a".into(),
                at_ms: at,
            },
        )
        .unwrap();
}

#[test]
fn expiry_explains_only_actual_deleted_times_even_with_untimed_sessions() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    for (sequence, time) in [(1, 10), (2, 11), (3, 13), (4, 20)] {
        store.append_tick(tick("a", sequence, time)).unwrap();
    }
    store.close_session("a").unwrap();
    trim(&mut store, 20, None);
    let mut reader = store.reader().unwrap();
    let expected = json!([
        range(0, 10, "unknownCoverage"),
        range(10, 12, "expired"),
        range(12, 13, "unknownCoverage"),
        range(13, 14, "expired"),
        range(14, 30, "unknownCoverage")
    ]);
    for mode in ["raw", "minmax"] {
        let result = query(&mut reader, &request(0, 30, mode, 1)).unwrap();
        assert_eq!(result["series"][0]["coverage"], expected);
        assert_eq!(result["series"][0]["watermark"]["committedThrough"], 4);
        if mode == "minmax" {
            assert_eq!(result["series"][0]["bins"][0]["validCount"], 1);
            assert_eq!(result["series"][0]["bins"][0]["state"], "partial");
        }
    }
    assert_eq!(
        query(&mut reader, &request(10, 12, "minmax", 1)).unwrap()["series"][0]["coverage"],
        json!([range(10, 12, "expired")])
    );
}

#[test]
fn old_snapshot_keeps_raw_and_new_snapshot_sees_expiry_atomically() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    store.append_tick(tick("a", 1, 10)).unwrap();
    store.close_session("a").unwrap();
    let mut reader = store.reader().unwrap();
    let q = request(0, 20, "raw", 10);
    let old = reader
        .query_with_hook(&q, &control(), &mut |b| {
            if b == Boundary::Snapshot {
                trim(&mut store, 11, None);
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(old["series"][0]["raw"].as_array().unwrap().len(), 1);
    assert_eq!(
        old["series"][0]["coverage"],
        json!([range(0, 20, "unknownCoverage")])
    );
    let new = query(&mut reader, &q).unwrap();
    assert!(new["series"][0]["raw"].as_array().unwrap().is_empty());
    assert_eq!(
        new["series"][0]["coverage"],
        json!([
            range(0, 10, "unknownCoverage"),
            range(10, 11, "expired"),
            range(11, 20, "unknownCoverage")
        ])
    );
}

#[test]
fn expired_overrides_a_later_local_gap_without_inventing_other_expired_times() {
    let directory = TempStore::new();
    let mut store = directory.create();
    begin(&mut store, "old", 10);
    store.append_tick(tick("old", 1, 10)).unwrap();
    close(&mut store, "old", 11);
    trim(&mut store, 11, None);
    begin(&mut store, "gap", 0);
    store
        .record_gap(GapEvidence {
            session_id: "gap".into(),
            gap_id: "g".into(),
            clock_epoch: "clock-a".into(),
            from_ms: 0,
            to_ms: 20,
            observed_at_ms: 20,
            reason: GapReason::SamplingMissed,
        })
        .unwrap();
    close(&mut store, "gap", 20);
    let mut reader = store.reader().unwrap();
    for mode in ["raw", "minmax"] {
        let result = query(&mut reader, &request(0, 20, mode, 1)).unwrap();
        assert_eq!(
            result["series"][0]["coverage"],
            json!([
                range(0, 10, "samplingMissed"),
                range(10, 11, "expired"),
                range(11, 20, "samplingMissed")
            ])
        );
    }
}

#[test]
fn final_interval_limit_and_input_evidence_limit_are_separate() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    // 128 disjoint expired instants plus 128 unknown intervals: exactly 256.
    for sequence in 1..=128 {
        store
            .append_tick(tick("a", sequence, (sequence as i64 - 1) * 2))
            .unwrap();
    }
    store.close_session("a").unwrap();
    trim(&mut store, 256, None);
    let mut reader = store.reader().unwrap();
    assert_eq!(
        query(&mut reader, &request(0, 256, "raw", 1)).unwrap()["series"][0]["coverage"]
            .as_array()
            .unwrap()
            .len(),
        256
    );
    assert_eq!(
        query(&mut reader, &request(-1, 256, "raw", 1)),
        Err(QueryError::CoverageLimit)
    );
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
    drop(reader);
    // Dense adjacent evidence is aggregated in SQL, including over 1024 points.
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    for sequence in 1..=1024 {
        store
            .append_tick(tick("a", sequence, sequence as i64))
            .unwrap();
    }
    store.close_session("a").unwrap();
    trim(&mut store, 1025, None);
    store.begin_session(spec("b")).unwrap();
    store.append_tick(tick("b", 1, 1025)).unwrap();
    store.close_session("b").unwrap();
    trim(&mut store, 1026, Some(1025));
    let mut reader = store.reader().unwrap();
    assert_eq!(
        query(&mut reader, &request(1, 1025, "raw", 1)).unwrap()["series"][0]["coverage"],
        json!([range(1, 1025, "expired")])
    );
    assert_eq!(
        query(&mut reader, &request(1, 1026, "raw", 1)).unwrap()["series"][0]["coverage"],
        json!([range(1, 1026, "expired")])
    );
}

#[test]
fn corrupt_ledger_state_and_remaining_records_fail_both_query_modes() {
    for corrupt in ["DELETE FROM retention_state", "DELETE FROM retention_operations", "UPDATE expired_samples SET deleted_records=999", "UPDATE expired_samples SET sample_time_ms=11", "UPDATE retention_state SET revision_commit=1", "INSERT INTO observations SELECT series_id,session_id,sequence,segment_id,clock_epoch,10,source_time_ms,ingested_at_ms,quality,source,number_value,bool_value,reason,source_epoch_id,commit_version FROM observations WHERE sample_time_ms=20"] {
        let directory = TempStore::new(); let mut store = directory.create();
        store.begin_session(spec("a")).unwrap();store.append_tick(tick("a",1,10)).unwrap();store.append_tick(tick("a",2,20)).unwrap();store.close_session("a").unwrap();trim(&mut store,11,None);
        store.connection.execute_batch("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON").unwrap();
        // Move retained rows rather than violate their primary keys.
        if corrupt.starts_with("INSERT") { store.connection.execute_batch("UPDATE observations SET sample_time_ms=10 WHERE sample_time_ms=20").unwrap(); }
        else { store.connection.execute_batch(corrupt).unwrap(); }
        let mut reader = store.reader().unwrap();
        for mode in ["raw","minmax"] { assert_eq!(query(&mut reader,&request(0,30,mode,10)),Err(QueryError::CorruptData),"{corrupt}"); assert!(reader.connection.as_ref().unwrap().is_autocommit()); }
    }
}
