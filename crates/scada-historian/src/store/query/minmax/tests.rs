use super::*;
use crate::store::query::{Boundary, QueryControl};
use crate::store::test_support::*;
use crate::store::{ObservationValue, Quality, Reason, Source};
use std::time::Duration;

fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(10)).unwrap()
}
fn request(ids: &[&str], from: i64, to: i64, points: i64) -> Value {
    json!({"version":1,"kind":"query","requestId":"minmax-query","seriesIds":ids,"fromMs":from,"toMs":to,"mode":"minmax","maxPointsPerSeries":points})
}

#[test]
fn common_grid_preserves_number_peaks_bool_states_and_nondivisible_boundaries() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    for (sequence, time, number, boolean) in [
        (1, 0, 0.0, false),
        (2, 1, 42.0, true),
        (3, 3, -2.0, false),
        (4, 4, 100.0, true),
        (5, 5, 999.0, true),
    ] {
        let mut input = tick("session-a", sequence, time);
        input.observations[0].value = Some(ObservationValue::Number(number));
        input.observations[1].value = Some(ObservationValue::Bool(boolean));
        store.append_tick(input).unwrap();
    }
    let mut reader = store.reader().unwrap();
    let result = reader
        .query_minmax(
            &request(&["number", "unknown", "bool"], 0, 5, 4),
            &control(),
        )
        .unwrap();
    let number = result["series"][0]["bins"].as_array().unwrap();
    let boolean = result["series"][2]["bins"].as_array().unwrap();
    assert_eq!(
        number
            .iter()
            .map(|b| (b["fromMs"].as_i64().unwrap(), b["toMs"].as_i64().unwrap()))
            .collect::<Vec<_>>(),
        [(0, 1), (1, 2), (2, 3), (3, 5)]
    );
    for (a, b) in number.iter().zip(boolean) {
        assert_eq!(a["fromMs"], b["fromMs"]);
        assert_eq!(a["toMs"], b["toMs"]);
    }
    assert_eq!(number[0]["min"], 0.0);
    assert_eq!(number[0]["max"], 0.0);
    assert_eq!(number[1]["min"], 42.0);
    assert_eq!(number[1]["max"], 42.0);
    assert_eq!(number[2]["state"], "gap");
    assert_eq!(number[3]["min"], -2.0);
    assert_eq!(number[3]["max"], 100.0);
    assert_eq!(number[3]["validCount"], 2);
    assert_eq!(boolean[3]["min"], 0.0);
    assert_eq!(boolean[3]["max"], 1.0);
    assert!(number.iter().all(|b| b["state"] != "complete"));
    assert_eq!(result["series"][1]["status"], "unknownSeries");
    assert!(result["series"][0]["raw"].as_array().unwrap().is_empty());
    assert_eq!(
        result["series"][0]["coverage"],
        json!([{"fromMs":0,"toMs":5,"reason":"unknownCoverage"}])
    );
    assert_eq!(crate::validate_history_contract(&result), Ok(()));
}

#[test]
fn millisecond_and_safe_integer_edges_use_exact_integer_grid_arithmetic() {
    for from in [-9_007_199_254_740_991, 9_007_199_254_740_986] {
        let directory = TempStore::new();
        let mut store = directory.create();
        store.begin_session(spec("session-a")).unwrap();
        for offset in 0..=5 {
            let mut input = tick("session-a", offset as u64 + 1, from + offset);
            input.ingested_at_ms = input.sample_time_ms;
            for observation in &mut input.observations {
                observation.source_time_ms = Some(input.sample_time_ms);
            }
            store.append_tick(input).unwrap();
        }
        let mut reader = store.reader().unwrap();
        let result = reader
            .query_minmax(&request(&["number"], from, from + 5, 4), &control())
            .unwrap();
        let bins = result["series"][0]["bins"].as_array().unwrap();
        assert_eq!(bins[0]["fromMs"], from);
        assert_eq!(bins[3]["toMs"], from + 5);
        assert_eq!(
            bins.iter()
                .map(|b| b["validCount"].as_i64().unwrap())
                .sum::<i64>(),
            5
        );
        let tiny = reader
            .query_minmax(&request(&["number"], from, from + 1, 2000), &control())
            .unwrap();
        assert_eq!(tiny["series"][0]["bins"].as_array().unwrap().len(), 1);
        assert_eq!(tiny["series"][0]["bins"][0]["validCount"], 1);
    }
}

#[test]
fn same_timestamp_distinct_records_are_counted_and_half_open_adjacent_windows_do_not_overlap() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    for (sequence, time) in [(1, 999), (2, 1000), (3, 1000), (4, 2000)] {
        store
            .append_tick(tick("session-a", sequence, time))
            .unwrap();
    }
    let mut reader = store.reader().unwrap();
    let left = reader
        .query_minmax(&request(&["number"], 0, 1000, 1), &control())
        .unwrap();
    let right = reader
        .query_minmax(&request(&["number"], 1000, 2000, 1), &control())
        .unwrap();
    assert_eq!(left["series"][0]["bins"][0]["validCount"], 1);
    assert_eq!(right["series"][0]["bins"][0]["validCount"], 2);
    assert_eq!(right["series"][0]["watermark"]["committedThrough"], 4);
}

#[test]
fn empty_and_invalid_only_bins_are_gaps_and_unobserved_epoch_does_not_create_mixing() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    let mut reader = store.reader().unwrap();
    let query = request(&["number"], 0, 3000, 3);
    let empty = reader.query_minmax(&query, &control()).unwrap();
    assert!(empty["series"][0]["bins"]
        .as_array()
        .unwrap()
        .iter()
        .all(|b| b["state"] == "gap" && b["validCount"] == 0 && b["invalidCount"] == 0));
    let mut bad = tick("session-a", 1, 1000);
    for o in &mut bad.observations {
        o.value = None;
        o.quality = Some(Quality::Bad);
        o.reason = Some(Reason::Bad);
    }
    store.append_tick(bad).unwrap();
    let mut good = tick("session-a", 2, 2000);
    good.observations[0].value = Some(ObservationValue::Number(42.0));
    store.append_tick(good).unwrap();
    let mut missing = tick("session-a", 3, 2000);
    for o in &mut missing.observations {
        o.value = None;
        o.quality = None;
        o.source = None;
        o.source_time_ms = None;
        o.source_epoch = None;
        o.reason = Some(Reason::SourceUnavailable);
    }
    store.append_tick(missing).unwrap();
    let result = reader.query_minmax(&query, &control()).unwrap();
    let bins = &result["series"][0]["bins"];
    assert_eq!(bins[1]["state"], "gap");
    assert_eq!(bins[1]["invalidCount"], 1);
    assert!(bins[1]["min"].is_null());
    assert_eq!(bins[2]["state"], "partial");
    assert_eq!(bins[2]["validCount"], 1);
    assert_eq!(bins[2]["invalidCount"], 1);
    assert_eq!(bins[2]["min"], 42.0);
    assert_eq!(bins[2]["max"], 42.0);
}

#[test]
fn simulation_and_unknown_source_remain_invalid_observations_without_envelopes() {
    for source in [
        Source::Simulation,
        Source::DerivedSimulation,
        Source::Unknown,
    ] {
        let directory = TempStore::new();
        let mut store = directory.create();
        let mut plan = spec("session-a");
        for m in &mut plan.members {
            m.source = source;
        }
        store.begin_session(plan).unwrap();
        let mut input = tick("session-a", 1, 1000);
        for o in &mut input.observations {
            o.source = Some(source);
            o.value = None;
            o.reason = Some(if source == Source::Unknown {
                Reason::UnknownSource
            } else {
                Reason::SimulationExcluded
            });
        }
        store.append_tick(input).unwrap();
        let mut reader = store.reader().unwrap();
        let result = reader
            .query_minmax(&request(&["number", "bool"], 0, 2000, 1), &control())
            .unwrap();
        for series in result["series"].as_array().unwrap() {
            assert_eq!(series["bins"][0]["state"], "gap");
            assert_eq!(series["bins"][0]["validCount"], 0);
            assert_eq!(series["bins"][0]["invalidCount"], 1);
            assert!(series["bins"][0]["max"].is_null());
        }
    }
}

#[test]
fn segment_clock_session_and_source_generations_each_create_mixed_bins_without_extrema() {
    for reason in ["segment", "clock", "session", "source"] {
        let directory = TempStore::new();
        let mut store = directory.create();
        store.begin_session(spec("session-a")).unwrap();
        store.append_tick(tick("session-a", 1, 1000)).unwrap();
        let mut input = tick("session-a", 2, 500);
        if reason == "segment" || reason == "session" {
            store.close_session("session-a").unwrap();
            let mut plan = spec("session-b");
            if reason == "segment" {
                for m in &mut plan.members {
                    m.segment_id = "segment-b".into();
                }
            }
            store.begin_session(plan).unwrap();
            input.session_id = "session-b".into();
            input.sequence = 1;
        }
        if reason == "clock" {
            input.clock_epoch = "clock-b".into();
        }
        for o in &mut input.observations {
            o.value = None;
            o.quality = Some(Quality::Bad);
            o.reason = Some(Reason::Bad);
            if reason == "source" {
                o.source_epoch.as_mut().unwrap().sdk_generation -= 1;
            }
        }
        store.append_tick(input).unwrap();
        let mut reader = store.reader().unwrap();
        let result = reader
            .query_minmax(&request(&["number", "bool"], 0, 2000, 1), &control())
            .unwrap();
        for series in result["series"].as_array().unwrap() {
            let b = &series["bins"][0];
            assert_eq!(b["state"], "mixedSegment", "{reason}");
            assert_eq!(b["validCount"], 1);
            assert_eq!(b["invalidCount"], 1);
            for field in ["min", "max", "segmentId", "source"] {
                assert!(b[field].is_null());
            }
        }
    }
}

#[test]
fn multiple_descriptors_with_empty_bins_fail_instead_of_guessing_latest_metadata() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    store.append_tick(tick("session-a", 1, 1000)).unwrap();
    store.close_session("session-a").unwrap();
    let mut plan = spec("session-b");
    plan.members[0].segment_id = "segment-b".into();
    plan.members[0].unit = Some("F".into());
    store.begin_session(plan).unwrap();
    let mut reader = store.reader().unwrap();
    assert_eq!(
        reader.query_minmax(&request(&["unknown", "number"], 0, 3000, 3), &control()),
        Err(QueryError::MetadataAmbiguous)
    );
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
    let populated = reader
        .query_minmax(&request(&["number"], 1000, 1001, 1), &control())
        .unwrap();
    assert_eq!(populated["series"][0]["bins"][0]["segmentId"], "segment-a");
    assert!(populated["series"][0]["watermark"].is_null());
}

#[test]
fn snapshot_aggregation_does_not_mix_later_appends_or_new_metadata() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    store.append_tick(tick("session-a", 1, 1000)).unwrap();
    let mut reader = store.reader().unwrap();
    let query = request(&["number", "bool"], 0, 2000, 1);
    let old = reader
        .query_with_mode(&query, &control(), "minmax", &mut |at| {
            if at == Boundary::Snapshot {
                store.close_session("session-a").unwrap();
                let mut plan = spec("session-b");
                plan.members[0].segment_id = "segment-b".into();
                store.begin_session(plan).unwrap();
                store.append_tick(tick("session-b", 1, 1000)).unwrap();
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(old["series"][0]["segments"].as_array().unwrap().len(), 1);
    for series in old["series"].as_array().unwrap() {
        assert_eq!(series["bins"][0]["state"], "partial");
        assert_eq!(series["bins"][0]["validCount"], 1);
        assert_eq!(series["watermark"]["sessionId"], "session-a");
    }
    let new = reader.query_minmax(&query, &control()).unwrap();
    assert_eq!(new["series"][0]["segments"].as_array().unwrap().len(), 2);
    assert_eq!(new["series"][0]["bins"][0]["state"], "mixedSegment");
    assert_eq!(new["series"][0]["bins"][0]["validCount"], 2);
    assert_eq!(new["series"][0]["watermark"]["sessionId"], "session-b");
}

#[test]
fn dense_series_aggregate_more_than_decode_budget_without_materializing_raw_in_rust() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    for sequence in 1..=9001 {
        let mut input = tick("session-a", sequence, 1000);
        input.observations[0].value = Some(ObservationValue::Number(if sequence == 4500 {
            12345.0
        } else {
            0.0
        }));
        store.append_tick(input).unwrap();
    }
    let mut reader = store.reader().unwrap();
    let mut limited = control();
    limited.limits.max_decoded_rows = 20;
    let query = request(&["number", "bool"], 0, 2000, 1);
    let result = reader.query_minmax(&query, &limited).unwrap();
    assert_eq!(result["series"][0]["bins"][0]["validCount"], 9001);
    assert_eq!(result["series"][0]["bins"][0]["min"], 0.0);
    assert_eq!(result["series"][0]["bins"][0]["max"], 12345.0);
    assert_eq!(result["series"][1]["bins"][0]["max"], 0.0);
    let mut raw = query.clone();
    raw["mode"] = json!("raw");
    assert_eq!(
        reader.query_raw(&raw, &control()),
        Err(QueryError::TooManyPoints)
    );
    let mut restricted = control();
    restricted.limits.max_vm_steps = 10_000;
    assert_eq!(
        reader.query_minmax(&query, &restricted),
        Err(QueryError::WorkLimit)
    );
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
}

#[test]
fn corrupted_values_quality_reasons_and_references_are_not_hidden_in_invalid_or_mixed_bins() {
    let edits = [
        "UPDATE observations SET bool_value = 2 WHERE series_id = 'bool'",
        "UPDATE observations SET number_value = 1.0, bool_value = 1 WHERE series_id = 'number'",
        "UPDATE observations SET number_value = 1e999 WHERE series_id = 'number'",
        "UPDATE observations SET source = 'simulation' WHERE series_id = 'number'",
        "UPDATE observations SET quality = 'bad' WHERE series_id = 'number'",
        "UPDATE observations SET number_value = NULL, reason = 'bad' WHERE series_id = 'number'",
        "UPDATE observations SET source_epoch_id = NULL WHERE series_id = 'number'",
        "UPDATE observations SET segment_id = 'missing' WHERE series_id = 'number'",
        "UPDATE observations SET commit_version = 999 WHERE series_id = 'number'",
        "UPDATE observations SET clock_epoch = 'invalid clock' WHERE series_id = 'number'",
        "UPDATE observations SET clock_epoch = 'clock-a' || char(0) || 'bad!' WHERE series_id = 'number'",
        "UPDATE source_epochs SET hub_id = 'wrong-hub'",
    ];
    for edit in edits {
        let directory = TempStore::new();
        let mut store = directory.create();
        store.begin_session(spec("session-a")).unwrap();
        store.append_tick(tick("session-a", 1, 1000)).unwrap();
        let mut next = tick("session-a", 2, 1000);
        next.clock_epoch = "clock-b".into();
        store.append_tick(next).unwrap();
        store
            .connection
            .execute_batch("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;")
            .unwrap();
        store.connection.execute_batch(edit).unwrap();
        let mut reader = store.reader().unwrap();
        assert_eq!(
            reader.query_minmax(&request(&["number", "bool"], 0, 2000, 1), &control()),
            Err(QueryError::CorruptData),
            "{edit}"
        );
        assert!(reader.connection.as_ref().unwrap().is_autocommit());
    }
}

#[test]
fn minmax_reuses_mode_cancellation_deadline_and_byte_row_limits() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    store.append_tick(tick("session-a", 1, 1000)).unwrap();
    let mut reader = store.reader().unwrap();
    let query = request(&["number"], 0, 2000, 2);
    assert_eq!(
        reader.query_raw(&query, &control()),
        Err(QueryError::UnsupportedMode)
    );
    let mut raw = query.clone();
    raw["mode"] = json!("raw");
    assert_eq!(
        reader.query_minmax(&raw, &control()),
        Err(QueryError::UnsupportedMode)
    );
    let cancelled = control();
    cancelled.cancellation.cancel();
    assert_eq!(
        reader.query_minmax(&query, &cancelled),
        Err(QueryError::Cancelled)
    );
    let expired = QueryControl::with_timeout(Duration::ZERO).unwrap();
    assert_eq!(
        reader.query_minmax(&query, &expired),
        Err(QueryError::Deadline)
    );
    let mut row_limit = control();
    row_limit.limits.max_decoded_rows = 1;
    assert_eq!(
        reader.query_minmax(&query, &row_limit),
        Err(QueryError::WorkLimit)
    );
    let mut byte_limit = control();
    byte_limit.limits.max_output_bytes = 1;
    assert_eq!(
        reader.query_minmax(&query, &byte_limit),
        Err(QueryError::ByteLimit)
    );
    assert!(reader.query_minmax(&query, &control()).is_ok());
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
}

#[test]
fn accepted_h1_sample_reasons_and_value_types_are_not_reclassified_as_corruption() {
    use crate::store::{IdentityDescriptor, SessionSpec, SourceEpoch, Tick, TickObservation};
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../../../examples/history-contract-cases.json"
    ))
    .unwrap();
    let mut replayed = 0;
    for case in cases {
        if case["expected"] != "accepted" || case["input"]["kind"] != "sampleBatch" {
            continue;
        }
        let batch = &case["input"];
        for sample in batch["samples"].as_array().unwrap() {
            let mut descriptor = batch["series"]
                .as_array()
                .unwrap()
                .iter()
                .find(|d| {
                    d["seriesId"] == sample["seriesId"] && d["segmentId"] == sample["segmentId"]
                })
                .unwrap()
                .clone();
            descriptor["periodMs"] = json!(crate::integer(&descriptor["periodMs"]));
            let descriptor: IdentityDescriptor = serde_json::from_value(descriptor).unwrap();
            let series_id = descriptor.series_id.clone();
            let epoch = if !sample["quality"].is_null()
                || !sample["source"].is_null()
                || !sample["sourceTimeMs"].is_null()
            {
                Some(SourceEpoch {
                    hub_instance_id: descriptor.hub_instance_id.clone(),
                    run_id: Some(1),
                    catalog_revision: 1,
                    sdk_generation: 1,
                })
            } else {
                None
            };
            let directory = TempStore::new();
            let mut store = directory.create();
            store
                .begin_session(SessionSpec {
                    session_id: "replay-session".into(),
                    members: vec![descriptor],
                })
                .unwrap();
            // Normalize only the recording position, keeping H1 value/labels/reason.
            store
                .append_tick(Tick {
                    session_id: "replay-session".into(),
                    sequence: 1,
                    clock_epoch: sample["clockEpoch"].as_str().unwrap().into(),
                    sample_time_ms: 1000,
                    ingested_at_ms: crate::integer(&sample["ingestedAtMs"]),
                    observations: vec![TickObservation {
                        series_id: series_id.clone(),
                        source_time_ms: if sample["sourceTimeMs"].is_null() {
                            None
                        } else {
                            Some(crate::integer(&sample["sourceTimeMs"]))
                        },
                        quality: serde_json::from_value(sample["quality"].clone()).unwrap(),
                        source: serde_json::from_value(sample["source"].clone()).unwrap(),
                        value: serde_json::from_value(sample["value"].clone()).unwrap(),
                        reason: serde_json::from_value(sample["reason"].clone()).unwrap(),
                        source_epoch: epoch,
                    }],
                })
                .unwrap();
            let mut reader = store.reader().unwrap();
            let result = reader
                .query_minmax(&request(&[&series_id], 1000, 1001, 1), &control())
                .unwrap_or_else(|e| panic!("{}: {e}", case["name"]));
            let bin = &result["series"][0]["bins"][0];
            let has_value = !sample["value"].is_null();
            assert_eq!(bin["validCount"], i64::from(has_value));
            assert_eq!(bin["invalidCount"], i64::from(!has_value));
            assert_eq!(bin["state"], if has_value { "partial" } else { "gap" });
            if has_value {
                let expected = sample["value"].as_bool().map_or_else(
                    || sample["value"].as_f64().unwrap(),
                    |b| f64::from(u8::from(b)),
                );
                assert_eq!(bin["min"], expected);
                assert_eq!(bin["max"], expected);
            }
            replayed += 1;
        }
    }
    assert!(replayed >= 10);
}

#[test]
fn cancellation_during_sql_aggregation_releases_snapshot_and_keeps_writer_running() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Barrier,
    };
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    for sequence in 1..=50 {
        store
            .append_tick(tick("session-a", sequence, 1000))
            .unwrap();
    }
    let mut reader = store.reader().unwrap();
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let signal = Arc::clone(&entered);
    let resume = Arc::clone(&release);
    let signalled = AtomicBool::new(false);
    reader
        .connection
        .as_mut()
        .unwrap()
        .authorizer(Some(move |context: AuthContext<'_>| {
            if matches!(
                context.action,
                AuthAction::Read {
                    table_name: "observations",
                    ..
                }
            ) && !signalled.swap(true, Ordering::AcqRel)
            {
                signal.wait();
                resume.wait();
            }
            Authorization::Allow
        }))
        .unwrap();
    let running = control();
    let token = running.cancellation.clone();
    let thread = std::thread::spawn(move || {
        let result = reader.query_minmax(&request(&["number"], 0, 2000, 1), &running);
        (reader, result)
    });
    entered.wait();
    // Snapshot is pinned and SQL preparation is in progress, without a sleep.
    let append = store.append_tick(tick("session-a", 51, 1000));
    token.cancel();
    release.wait();
    let (mut reader, result) = thread.join().unwrap();
    assert!(append.is_ok());
    assert_eq!(result, Err(QueryError::Cancelled));
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
    reader
        .connection
        .as_mut()
        .unwrap()
        .authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
        .unwrap();
    let next = reader
        .query_minmax(&request(&["number"], 0, 2000, 1), &control())
        .unwrap();
    assert_eq!(next["series"][0]["bins"][0]["validCount"], 51);
}
