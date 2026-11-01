use super::*;
use crate::store::{
    evidence::ClockStamp,
    query::{Boundary, QueryControl},
    test_support::*,
    Quality, Reason as SampleReason, SqliteStore,
};
use std::time::Duration;

fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(10)).unwrap()
}
fn begin(store: &mut SqliteStore, session: &str, at: i64) {
    store
        .begin_timed_session(
            spec(session),
            TimedStart {
                clock_epoch: "clock-a".into(),
                at_ms: at,
                plan: PlanRef {
                    plan_id: "plan-a".into(),
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
fn gap(store: &mut SqliteStore, session: &str, key: &str, from: i64, to: i64, reason: GapReason) {
    store
        .record_gap(GapEvidence {
            session_id: session.into(),
            gap_id: key.into(),
            clock_epoch: "clock-a".into(),
            from_ms: from,
            to_ms: to,
            observed_at_ms: to,
            reason,
        })
        .unwrap();
}
fn request(from: i64, to: i64, mode: &str) -> Value {
    json!({"version":1,"kind":"query","requestId":"q","seriesIds":["number"],"fromMs":from,"toMs":to,"mode":mode,"maxPointsPerSeries":1})
}
fn span(from: i64, to: i64, reason: &str) -> Value {
    json!({"fromMs":from,"toMs":to,"reason":reason})
}
fn query(
    reader: &mut super::super::HistoryReader,
    from: i64,
    to: i64,
    mode: &str,
) -> Result<Value, QueryError> {
    if mode == "raw" {
        reader.query_raw(&request(from, to, mode), &control())
    } else {
        reader.query_minmax(&request(from, to, mode), &control())
    }
}

#[test]
fn proven_gaps_are_clipped_coalesced_and_surrounded_by_unknown_for_raw_and_minmax() {
    let directory = TempStore::new();
    let mut store = directory.create();
    begin(&mut store, "owner", 0);
    store.append_tick(tick("owner", 1, 0)).unwrap();
    gap(
        &mut store,
        "owner",
        "a",
        1000,
        2000,
        GapReason::SamplingMissed,
    );
    gap(
        &mut store,
        "owner",
        "b",
        2000,
        3000,
        GapReason::SamplingMissed,
    );
    gap(&mut store, "owner", "c", 3000, 4000, GapReason::StorageLoss);
    close(&mut store, "owner", 5000);
    let mut reader = store.reader().unwrap();
    let expected = json!([
        span(0, 1000, "unknownCoverage"),
        span(1000, 3000, "samplingMissed"),
        span(3000, 4000, "storageLoss"),
        span(4000, 6000, "unknownCoverage")
    ]);
    for mode in ["raw", "minmax"] {
        let result = query(&mut reader, 0, 6000, mode).unwrap();
        assert_eq!(result["series"][0]["coverage"], expected);
        if mode == "minmax" {
            assert_eq!(result["series"][0]["bins"][0]["state"], "partial");
            assert_eq!(result["series"][0]["bins"][0]["validCount"], 1);
        }
        assert_eq!(crate::validate_history_contract(&result), Ok(()));
    }
    assert_eq!(
        query(&mut reader, 1500, 3500, "raw").unwrap()["series"][0]["coverage"],
        json!([
            span(1500, 3000, "samplingMissed"),
            span(3000, 3500, "storageLoss")
        ])
    );
}

#[test]
fn another_closed_domain_masks_its_full_window_even_with_no_records_or_matching_gap() {
    for matching_gap in [false, true] {
        let directory = TempStore::new();
        let mut store = directory.create();
        begin(&mut store, "owner", 0);
        gap(
            &mut store,
            "owner",
            "a",
            1000,
            5000,
            GapReason::SamplingMissed,
        );
        close(&mut store, "owner", 6000);
        begin(&mut store, "other", 2000);
        if matching_gap {
            gap(
                &mut store,
                "other",
                "b",
                2000,
                4000,
                GapReason::SamplingMissed,
            );
        }
        close(&mut store, "other", 4000);
        let mut reader = store.reader().unwrap();
        let result = query(&mut reader, 1000, 5000, "raw").unwrap();
        assert_eq!(
            result["series"][0]["coverage"],
            json!([
                span(1000, 2000, "samplingMissed"),
                span(2000, 4000, "unknownCoverage"),
                span(4000, 5000, "samplingMissed")
            ])
        );
    }
}

#[test]
fn active_and_interrupted_domains_mask_from_start_without_using_frontier_as_end() {
    for interrupted in [false, true] {
        let directory = TempStore::new();
        let mut store = directory.create();
        begin(&mut store, "owner", 0);
        gap(&mut store, "owner", "a", 1000, 5000, GapReason::StorageLoss);
        close(&mut store, "owner", 6000);
        begin(&mut store, "other", 2000);
        let mut input = tick("other", 1, 2500);
        for o in &mut input.observations {
            o.value = None;
            o.quality = Some(Quality::Bad);
            o.reason = Some(SampleReason::Bad);
        }
        store.append_tick(input).unwrap();
        if interrupted {
            store.interrupt_session("other").unwrap();
        }
        let mut reader = store.reader().unwrap();
        let result = query(&mut reader, 1000, 7000, "raw").unwrap();
        assert_eq!(
            result["series"][0]["coverage"],
            json!([
                span(1000, 2000, "storageLoss"),
                span(2000, 7000, "unknownCoverage")
            ])
        );
        assert_eq!(result["series"][0]["raw"][0]["sampleTimeMs"], 2500);
    }
}

#[test]
fn any_untimed_domain_keeps_the_series_unknown_including_windows_before_its_samples() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("untimed")).unwrap();
    store.append_tick(tick("untimed", 1, 10000)).unwrap();
    store.close_session("untimed").unwrap();
    begin(&mut store, "owner", 0);
    gap(
        &mut store,
        "owner",
        "g",
        1000,
        2000,
        GapReason::SamplingMissed,
    );
    let mut reader = store.reader().unwrap();
    assert_eq!(
        query(&mut reader, 1000, 2000, "raw").unwrap()["series"][0]["coverage"],
        json!([span(1000, 2000, "unknownCoverage")])
    );
}

#[test]
fn gap_and_session_boundaries_are_half_open_and_safe_integer_exact() {
    for from in [-(MAX_SAFE as i64), MAX_SAFE as i64 - 10] {
        let directory = TempStore::new();
        let mut store = directory.create();
        begin(&mut store, "owner", from);
        gap(
            &mut store,
            "owner",
            "g",
            from,
            from + 10,
            GapReason::SamplingMissed,
        );
        close(&mut store, "owner", from + 10);
        begin(&mut store, "other", from + 10); // Exclusive end does not mask the preceding gap.
        let mut reader = store.reader().unwrap();
        assert_eq!(
            query(&mut reader, from, from + 10, "raw").unwrap()["series"][0]["coverage"],
            json!([span(from, from + 10, "samplingMissed")])
        );
    }
}

#[test]
fn query_snapshot_does_not_mix_new_gap_close_or_new_domain_evidence() {
    let directory = TempStore::new();
    let mut store = directory.create();
    begin(&mut store, "owner", 0);
    let mut reader = store.reader().unwrap();
    let request = request(1000, 4000, "raw");
    let old = reader
        .query_with_hook(&request, &control(), &mut |at| {
            if at == Boundary::Snapshot {
                gap(
                    &mut store,
                    "owner",
                    "g",
                    1000,
                    4000,
                    GapReason::SamplingMissed,
                );
                close(&mut store, "owner", 5000);
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(
        old["series"][0]["coverage"],
        json!([span(1000, 4000, "unknownCoverage")])
    );
    let old = reader
        .query_with_hook(&request, &control(), &mut |at| {
            if at == Boundary::Snapshot {
                begin(&mut store, "other", 2000);
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(
        old["series"][0]["coverage"],
        json!([span(1000, 4000, "samplingMissed")])
    );
    assert_eq!(
        reader.query_raw(&request, &control()).unwrap()["series"][0]["coverage"],
        json!([
            span(1000, 2000, "samplingMissed"),
            span(2000, 4000, "unknownCoverage")
        ])
    );
}

#[test]
fn final_interval_limit_counts_unknown_complement_and_never_truncates_or_falls_back() {
    let directory = TempStore::new();
    let mut store = directory.create();
    begin(&mut store, "owner", 0);
    for i in 0..128 {
        gap(
            &mut store,
            "owner",
            &format!("g{i}"),
            i * 2,
            i * 2 + 1,
            GapReason::SamplingMissed,
        );
    }
    let mut reader = store.reader().unwrap();
    assert_eq!(
        query(&mut reader, 0, 256, "raw").unwrap()["series"][0]["coverage"]
            .as_array()
            .unwrap()
            .len(),
        256
    );
    gap(
        &mut store,
        "owner",
        "g128",
        256,
        257,
        GapReason::SamplingMissed,
    );
    assert_eq!(
        query(&mut reader, 0, 258, "raw"),
        Err(QueryError::CoverageLimit)
    );
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
}

#[test]
fn adjacent_input_gaps_coalesce_before_final_limit_but_evidence_input_has_a_cap() {
    let directory = TempStore::new();
    let mut store = directory.create();
    begin(&mut store, "owner", 0);
    for i in 0..1024 {
        gap(
            &mut store,
            "owner",
            &format!("g{i}"),
            i,
            i + 1,
            GapReason::SamplingMissed,
        );
    }
    let mut reader = store.reader().unwrap();
    assert_eq!(
        query(&mut reader, 0, 1024, "raw").unwrap()["series"][0]["coverage"],
        json!([span(0, 1024, "samplingMissed")])
    );
    gap(
        &mut store,
        "owner",
        "g1024",
        1024,
        1025,
        GapReason::SamplingMissed,
    );
    assert_eq!(
        query(&mut reader, 0, 1025, "raw"),
        Err(QueryError::EvidenceLimit)
    );
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
}

#[test]
fn session_limit_applies_before_an_untimed_fallback() {
    let directory = TempStore::new();
    let mut store = directory.create();
    for i in 0..257 {
        let s = format!("s{i}");
        store.begin_session(spec(&s)).unwrap();
        store.close_session(&s).unwrap();
    }
    let mut reader = store.reader().unwrap();
    assert_eq!(
        query(&mut reader, 0, 1000, "raw"),
        Err(QueryError::EvidenceLimit)
    );
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
}

#[test]
fn corrupted_local_gap_cannot_hide_an_existing_good_or_null_record_in_either_mode() {
    for null in [false, true] {
        let directory = TempStore::new();
        let mut store = directory.create();
        begin(&mut store, "owner", 0);
        let mut input = tick("owner", 1, 0);
        if null {
            for o in &mut input.observations {
                o.value = None;
                o.quality = Some(Quality::Bad);
                o.reason = Some(SampleReason::Bad);
            }
        }
        store.append_tick(input).unwrap();
        gap(&mut store, "owner", "g", 1000, 2000, GapReason::StorageLoss);
        store
            .connection
            .execute(
                "UPDATE observations SET sample_time_ms=1500 WHERE session_id='owner'",
                [],
            )
            .unwrap();
        let mut reader = store.reader().unwrap();
        for mode in ["raw", "minmax"] {
            assert_eq!(
                query(&mut reader, 0, 3000, mode),
                Err(QueryError::CorruptData)
            );
        }
        assert!(reader.connection.as_ref().unwrap().is_autocommit());
    }
}

#[test]
fn malformed_plan_gap_clock_state_and_receipt_evidence_is_rejected() {
    for edit in [
        "UPDATE recording_plans SET members_json='[]'",
        "UPDATE session_evidence SET clock_epoch='clock-a'||char(0)||'bad'",
        "UPDATE session_evidence SET end_ms=2500",
        "UPDATE recording_gaps SET to_ms=1500",
        "UPDATE recording_gaps SET reason='expired'",
        "UPDATE recording_gaps SET commit_version=99999",
        "UPDATE sessions SET state='active'",
    ] {
        let directory = TempStore::new();
        let mut store = directory.create();
        begin(&mut store, "owner", 0);
        gap(
            &mut store,
            "owner",
            "g",
            1000,
            2000,
            GapReason::SamplingMissed,
        );
        close(&mut store, "owner", 3000);
        store
            .connection
            .execute_batch("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON;")
            .unwrap();
        store.connection.execute_batch(edit).unwrap();
        let mut reader = store.reader().unwrap();
        assert_eq!(
            query(&mut reader, 1000, 2000, "raw"),
            Err(QueryError::CorruptData),
            "{edit}"
        );
        assert!(reader.connection.as_ref().unwrap().is_autocommit());
    }
}

#[test]
fn oversized_evidence_and_low_execution_budgets_fail_and_release_the_snapshot() {
    let directory = TempStore::new();
    let mut store = directory.create();
    begin(&mut store, "owner", 0);
    gap(
        &mut store,
        "owner",
        "g",
        1000,
        2000,
        GapReason::SamplingMissed,
    );
    let mut reader = store.reader().unwrap();
    let mut low = control();
    low.limits.max_decoded_rows = 5;
    assert_eq!(
        reader.query_raw(&request(0, 3000, "raw"), &low),
        Err(QueryError::WorkLimit)
    );
    let late = control();
    assert_eq!(
        reader.query_with_hook(&request(0, 3000, "raw"), &late, &mut |at| {
            if at == Boundary::BeforeReturn {
                late.cancellation.cancel();
            }
            Ok(())
        }),
        Err(QueryError::Cancelled)
    );
    store
        .connection
        .execute(
            "UPDATE sessions SET spec_json=?1",
            ["x".repeat(64 * 1024 + 1)],
        )
        .unwrap();
    assert_eq!(
        query(&mut reader, 0, 3000, "raw"),
        Err(QueryError::EvidenceLimit)
    );
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
}

#[test]
fn orphaned_session_members_are_not_dropped_before_domain_validation() {
    let directory = TempStore::new();
    let mut store = directory.create();
    begin(&mut store, "owner", 0);
    gap(
        &mut store,
        "owner",
        "g",
        1000,
        2000,
        GapReason::SamplingMissed,
    );
    store.connection.execute_batch("PRAGMA foreign_keys=OFF; INSERT INTO session_members VALUES ('orphan','number','segment-a');").unwrap();
    let mut reader = store.reader().unwrap();
    assert_eq!(
        query(&mut reader, 1000, 2000, "raw"),
        Err(QueryError::CorruptData)
    );
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
}

#[test]
fn matching_plan_and_session_cannot_disagree_with_the_permanent_member_descriptor() {
    let directory = TempStore::new();
    let mut store = directory.create();
    begin(&mut store, "owner", 0);
    gap(
        &mut store,
        "owner",
        "g",
        1000,
        2000,
        GapReason::SamplingMissed,
    );
    let mut changed = spec("owner").validated().unwrap();
    changed
        .members
        .iter_mut()
        .find(|m| m.series_id == "number")
        .unwrap()
        .unit = Some("F".into());
    store
        .connection
        .execute(
            "UPDATE sessions SET spec_json=?1",
            [serde_json::to_string(&changed).unwrap()],
        )
        .unwrap();
    store
        .connection
        .execute(
            "UPDATE recording_plans SET members_json=?1",
            [serde_json::to_string(&changed.members).unwrap()],
        )
        .unwrap();
    let mut reader = store.reader().unwrap();
    assert_eq!(
        query(&mut reader, 1000, 2000, "raw"),
        Err(QueryError::CorruptData)
    );
}
