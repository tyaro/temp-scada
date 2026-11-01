use super::*;
use crate::store::test_support::*;
use crate::store::{ObservationValue, SessionState};
use std::sync::Barrier;

fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(10)).unwrap()
}
fn request(ids: &[&str], from: i64, to: i64, points: i64) -> Value {
    json!({"version":1,"kind":"query","requestId":"request-a","seriesIds":ids,"fromMs":from,"toMs":to,"mode":"raw","maxPointsPerSeries":points})
}
fn assert_finished(reader: &HistoryReader) {
    assert!(reader.connection.as_ref().unwrap().is_autocommit());
}

#[test]
fn raw_query_preserves_types_clock_order_half_open_range_and_unknown_series() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    for (sequence, time) in [(1, 1000), (2, 1000), (3, 500), (4, 2000)] {
        let mut input = tick("session-a", sequence, time);
        if sequence == 3 {
            input.clock_epoch = "clock-b".into();
        }
        store.append_tick(input).unwrap();
    }
    let mut reader = store.reader().unwrap();
    let query = request(&["bool", "unknown", "number"], 500, 2000, 20);
    let result = reader.query_raw(&query, &control()).unwrap();
    assert_eq!(result["query"], query);
    assert_eq!(result["status"], "ready");
    assert_eq!(
        uuid::Uuid::parse_str(result["snapshotId"].as_str().unwrap())
            .unwrap()
            .get_version_num(),
        4
    );
    let boolean = &result["series"][0];
    assert_eq!(
        boolean["raw"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["recordId"]["sequence"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [3, 1, 2]
    );
    assert_eq!(boolean["raw"][0]["clockEpoch"], "clock-b");
    assert_eq!(boolean["raw"][0]["sourceTimeMs"], 490);
    assert_eq!(boolean["raw"][0]["ingestedAtMs"], 520);
    assert_eq!(boolean["raw"][0]["value"], false);
    assert_eq!(result["series"][2]["raw"][0]["value"], 0.0);
    assert_eq!(
        boolean["watermark"],
        json!({"sessionId":"session-a","committedThrough":4})
    );
    assert_eq!(
        boolean["coverage"],
        json!([{"fromMs":500,"toMs":2000,"reason":"unknownCoverage"}])
    );
    assert_eq!(
        result["series"][1],
        json!({"seriesId":"unknown","status":"unknownSeries","segments":[],"raw":[],"bins":[],"coverage":[],"watermark":null})
    );
    assert!(!result.to_string().contains("sourceEpoch"));
    assert_eq!(crate::validate_history_contract(&result), Ok(()));
    assert_finished(&reader);
}

#[test]
fn one_snapshot_keeps_metadata_observations_and_watermark_consistent_during_append() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    store.append_tick(tick("session-a", 1, 1000)).unwrap();
    let mut reader = store.reader().unwrap();
    let query = request(&["number", "bool"], 0, 3000, 20);
    let old = reader
        .query_with_hook(&query, &control(), &mut |at| {
            if at == Boundary::Snapshot {
                store.close_session("session-a").unwrap();
                let mut next = spec("session-b");
                next.members[0].segment_id = "segment-b".into();
                next.members[0].external_name = "Plant.Renamed".into();
                store.begin_session(next).unwrap();
                let mut input = tick("session-b", 1, 1000);
                input.observations[0].value = Some(ObservationValue::Number(42.0));
                store.append_tick(input).unwrap();
            }
            Ok(())
        })
        .unwrap();
    for series in old["series"].as_array().unwrap() {
        assert_eq!(series["segments"].as_array().unwrap().len(), 1);
        assert_eq!(series["raw"].as_array().unwrap().len(), 1);
        assert_eq!(
            series["watermark"],
            json!({"sessionId":"session-a","committedThrough":1})
        );
    }
    let new = reader.query_raw(&query, &control()).unwrap();
    assert_ne!(old["snapshotId"], new["snapshotId"]);
    assert_eq!(new["series"][0]["segments"].as_array().unwrap().len(), 2);
    assert_eq!(new["series"][0]["raw"].as_array().unwrap().len(), 2);
    assert_eq!(new["series"][0]["raw"][1]["value"], 42.0);
    assert_eq!(new["series"][1]["raw"].as_array().unwrap().len(), 2);
    assert_eq!(
        new["series"][0]["watermark"],
        json!({"sessionId":"session-b","committedThrough":1})
    );
    assert_finished(&reader);
}

#[test]
fn uncommitted_append_is_absent_and_never_labelled_as_pending_flush() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    let mut reader = store.reader().unwrap();
    let query = request(&["number", "bool"], 0, 3000, 20);
    store
        .append_with_hook(tick("session-a", 1, 1000), &mut |at| {
            if at == super::super::Boundary::Observation {
                let result = reader.query_raw(&query, &control()).unwrap();
                for series in result["series"].as_array().unwrap() {
                    assert!(series["raw"].as_array().unwrap().is_empty());
                    assert!(series["watermark"].is_null());
                    assert_eq!(series["coverage"][0]["reason"], "unknownCoverage");
                }
            }
            Ok(())
        })
        .unwrap();
    let result = reader.query_raw(&query, &control()).unwrap();
    assert_eq!(result["series"][0]["raw"].as_array().unwrap().len(), 1);
    assert_eq!(
        store.session_status("session-a").unwrap().unwrap().state,
        SessionState::Active
    );
}

#[test]
fn latest_empty_session_does_not_borrow_an_old_watermark_or_invent_missing_intervals() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    store.append_tick(tick("session-a", 1, 1000)).unwrap();
    store.close_session("session-a").unwrap();
    store.begin_session(spec("session-b")).unwrap();
    let mut reader = store.reader().unwrap();
    let result = reader
        .query_raw(&request(&["number"], 0, 3000, 20), &control())
        .unwrap();
    assert!(result["series"][0]["watermark"].is_null());
    assert_eq!(
        result["series"][0]["raw"][0]["recordId"]["sessionId"],
        "session-a"
    );
    drop(reader);
    drop(store);
    let store = directory.open();
    assert_eq!(
        store.session_status("session-b").unwrap().unwrap().state,
        SessionState::Interrupted
    );
    let mut reader = store.reader().unwrap();
    let empty = reader
        .query_raw(&request(&["number"], 2000, 3000, 20), &control())
        .unwrap();
    assert_eq!(empty["series"][0]["status"], "ready");
    assert!(empty["series"][0]["raw"].as_array().unwrap().is_empty());
    assert_eq!(
        empty["series"][0]["coverage"],
        json!([{"fromMs":2000,"toMs":3000,"reason":"unknownCoverage"}])
    );
    assert!(empty["series"][0]["watermark"].is_null());
}

#[test]
fn raw_point_overflow_fails_the_whole_request_without_truncation() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    store.append_tick(tick("session-a", 1, 1000)).unwrap();
    store.append_tick(tick("session-a", 2, 1000)).unwrap();
    let mut reader = store.reader().unwrap();
    assert_eq!(
        reader.query_raw(&request(&["unknown", "number"], 0, 2000, 1), &control()),
        Err(QueryError::TooManyPoints)
    );
    assert_finished(&reader);
    assert!(reader
        .query_raw(&request(&["number"], 0, 2000, 2), &control())
        .is_ok());
}

#[test]
fn metadata_history_is_bounded_instead_of_silently_losing_segments() {
    let directory = TempStore::new();
    let mut store = directory.create();
    for index in 0..32 {
        let session = format!("session-{index}");
        let mut plan = spec(&session);
        plan.members[0].segment_id = format!("segment-{index}");
        store.begin_session(plan).unwrap();
        store.close_session(&session).unwrap();
    }
    let mut reader = store.reader().unwrap();
    let query = request(&["number"], 0, 2000, 20);
    assert_eq!(
        reader.query_raw(&query, &control()).unwrap()["series"][0]["segments"]
            .as_array()
            .unwrap()
            .len(),
        32
    );
    let mut plan = spec("session-32");
    plan.members[0].segment_id = "segment-32".into();
    store.begin_session(plan).unwrap();
    assert_eq!(
        reader.query_raw(&query, &control()),
        Err(QueryError::MetadataLimit)
    );
    assert_finished(&reader);
}

#[test]
fn input_and_execution_limits_are_validated_without_modifying_the_store() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    let baseline = counter(&store);
    let mut reader = store.reader().unwrap();
    let query = request(&["number"], 0, 2000, 20);
    let mut bad = query.clone();
    bad["mode"] = json!("minmax");
    assert_eq!(
        reader.query_raw(&bad, &control()),
        Err(QueryError::UnsupportedMode)
    );
    bad["seriesIds"] = json!(["number", "number"]);
    assert!(matches!(
        reader.query_raw(&bad, &control()),
        Err(QueryError::InvalidRequest(_))
    ));
    let mut bad = control();
    bad.limits.max_output_bytes = 0;
    assert_eq!(
        reader.query_raw(&query, &bad),
        Err(QueryError::InvalidLimits)
    );
    bad.limits = QueryLimits {
        max_decoded_rows: 9001,
        ..QueryLimits::default()
    };
    assert_eq!(
        reader.query_raw(&query, &bad),
        Err(QueryError::InvalidLimits)
    );
    bad.limits = QueryLimits {
        max_vm_steps: 5_000_001,
        ..QueryLimits::default()
    };
    assert_eq!(
        reader.query_raw(&query, &bad),
        Err(QueryError::InvalidLimits)
    );
    bad.limits = QueryLimits {
        max_output_bytes: 8 * 1024 * 1024 + 1,
        ..QueryLimits::default()
    };
    assert_eq!(
        reader.query_raw(&query, &bad),
        Err(QueryError::InvalidLimits)
    );
    assert!(matches!(
        QueryControl::with_timeout(Duration::from_secs(11)),
        Err(QueryError::InvalidLimits)
    ));
    bad = control();
    bad.deadline += Duration::from_secs(1);
    assert_eq!(
        reader.query_raw(&query, &bad),
        Err(QueryError::InvalidLimits)
    );
    assert_eq!(counter(&store), baseline);
    assert!(reader
        .connection
        .as_ref()
        .unwrap()
        .execute("DELETE FROM observations", [])
        .is_err());
    assert_finished(&reader);
}

#[test]
fn row_and_byte_limits_return_errors_and_release_the_snapshot() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    store.append_tick(tick("session-a", 1, 1000)).unwrap();
    let mut reader = store.reader().unwrap();
    let query = request(&["number"], 0, 2000, 20);
    let mut low = control();
    low.limits.max_vm_steps = 1;
    assert_eq!(reader.query_raw(&query, &low), Err(QueryError::WorkLimit));
    assert_finished(&reader);
    low = control();
    low.limits.max_decoded_rows = 1;
    assert_eq!(reader.query_raw(&query, &low), Err(QueryError::WorkLimit));
    assert_finished(&reader);
    low = control();
    low.limits.max_output_bytes = 1;
    assert_eq!(reader.query_raw(&query, &low), Err(QueryError::ByteLimit));
    assert_finished(&reader);
    let result = reader.query_raw(&query, &control()).unwrap();
    let bytes = serde_json::to_vec(&result).unwrap().len();
    low = control();
    low.limits.max_output_bytes = bytes;
    assert!(reader.query_raw(&query, &low).is_ok());
    low.limits.max_output_bytes -= 1;
    assert_eq!(reader.query_raw(&query, &low), Err(QueryError::ByteLimit));
    assert_finished(&reader);
}

#[test]
fn cancellation_deadline_and_late_cancellation_never_publish_partial_ready() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    let mut reader = store.reader().unwrap();
    let query = request(&["number"], 0, 2000, 20);
    let cancelled = control();
    cancelled.cancellation.cancel();
    assert_eq!(
        reader.query_raw(&query, &cancelled),
        Err(QueryError::Cancelled)
    );
    let elapsed = QueryControl::with_timeout(Duration::ZERO).unwrap();
    assert_eq!(
        reader.query_raw(&query, &elapsed),
        Err(QueryError::Deadline)
    );
    let late = control();
    assert_eq!(
        reader.query_with_hook(&query, &late, &mut |at| {
            if at == Boundary::BeforeReturn {
                late.cancellation.cancel();
            }
            Ok(())
        }),
        Err(QueryError::Cancelled)
    );
    assert_finished(&reader);
    assert!(reader.query_raw(&query, &control()).is_ok());
}

#[test]
fn vm_interrupt_removes_the_handler_before_rollback_and_reader_reuse() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    for sequence in 1..=400 {
        store
            .append_tick(tick("session-a", sequence, 1000))
            .unwrap();
    }
    let mut reader = store.reader().unwrap();
    let query = request(&["number"], 0, 2000, 500);
    let mut low = control();
    low.limits.max_vm_steps = 10_000;
    assert_eq!(reader.query_raw(&query, &low), Err(QueryError::WorkLimit));
    assert_finished(&reader);
    assert_eq!(
        reader.query_raw(&query, &control()).unwrap()["series"][0]["raw"]
            .as_array()
            .unwrap()
            .len(),
        400
    );
}

#[test]
fn idle_reader_count_and_writer_ownership_remain_bounded_until_every_drop() {
    let directory = TempStore::new();
    let store = directory.create();
    let first = store.reader().unwrap();
    let second = store.reader().unwrap();
    assert!(matches!(store.reader(), Err(StoreError::Busy)));
    drop(first);
    let replacement = store.reader().unwrap();
    drop(store);
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &identity()),
        Err(StoreError::Busy)
    ));
    drop(second);
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &identity()),
        Err(StoreError::Busy)
    ));
    drop(replacement);
    drop(directory.open());
}

#[test]
fn cancellation_request_keeps_ownership_until_running_query_finishes_and_reader_drops() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    let mut reader = store.reader().unwrap();
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let running = control();
    let cancellation = running.cancellation.clone();
    let signal = Arc::clone(&entered);
    let resume = Arc::clone(&release);
    let thread = std::thread::spawn(move || {
        let result =
            reader.query_with_hook(&request(&["number"], 0, 2000, 20), &running, &mut |at| {
                if at == Boundary::Snapshot {
                    signal.wait();
                    resume.wait();
                }
                Ok(())
            });
        (reader, result)
    });
    entered.wait();
    cancellation.cancel();
    drop(store);
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &identity()),
        Err(StoreError::Busy)
    ));
    release.wait();
    let (mut reader, result) = thread.join().unwrap();
    assert_eq!(result, Err(QueryError::Cancelled));
    assert_finished(&reader);
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &identity()),
        Err(StoreError::Busy)
    ));
    assert!(reader
        .query_raw(&request(&["number"], 0, 2000, 20), &control())
        .is_ok());
    drop(reader);
    drop(directory.open());
}

#[test]
fn inconsistent_database_rows_fail_instead_of_becoming_empty_success() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    store.append_tick(tick("session-a", 1, 1000)).unwrap();
    let mut reader = store.reader().unwrap();
    store.connection.execute_batch("PRAGMA ignore_check_constraints = ON; UPDATE observations SET bool_value = 2 WHERE series_id = 'bool';").unwrap();
    assert_eq!(
        reader.query_raw(&request(&["unknown", "bool"], 0, 2000, 20), &control()),
        Err(QueryError::CorruptData)
    );
    assert_finished(&reader);
    store.connection.execute_batch("UPDATE observations SET bool_value = 0 WHERE series_id = 'bool'; UPDATE segments SET descriptor_json = '{}' WHERE series_id = 'number';").unwrap();
    assert_eq!(
        reader.query_raw(&request(&["number"], 0, 2000, 20), &control()),
        Err(QueryError::CorruptData)
    );
    assert_finished(&reader);
    // A missing table is a database error, not unknownSeries or an empty ready.
    store
        .connection
        .execute_batch("DROP TABLE observations;")
        .unwrap();
    assert_eq!(
        reader.query_raw(&request(&["bool"], 0, 2000, 20), &control()),
        Err(QueryError::Database)
    );
    assert_finished(&reader);
}

#[test]
fn cleanup_failure_closes_the_connection_and_disables_reader_reuse() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    let mut reader = store.reader().unwrap();
    reader
        .connection
        .as_mut()
        .unwrap()
        .authorizer(Some(|context: AuthContext<'_>| {
            if matches!(
                context.action,
                AuthAction::Transaction {
                    operation: TransactionOperation::Rollback
                }
            ) {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }))
        .unwrap();
    let query = request(&["number"], 0, 2000, 20);
    assert_eq!(
        reader.query_raw(&query, &control()),
        Err(QueryError::ReaderUnusable)
    );
    assert!(reader.connection.is_none());
    assert_eq!(
        reader.query_raw(&query, &control()),
        Err(QueryError::ReaderUnusable)
    );
    store.append_tick(tick("session-a", 1, 1000)).unwrap();
    drop(store);
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &identity()),
        Err(StoreError::Busy)
    ));
    drop(reader);
    drop(directory.open());
}

#[test]
fn unwinding_query_code_also_releases_the_transaction_before_reuse() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("session-a")).unwrap();
    let mut reader = store.reader().unwrap();
    let query = request(&["number"], 0, 2000, 20);
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = reader.query_with_hook(&query, &control(), &mut |at| {
            if at == Boundary::Snapshot {
                panic!("injected query unwind");
            }
            Ok(())
        });
    }));
    assert!(panic.is_err());
    assert_finished(&reader);
    assert!(reader.query_raw(&query, &control()).is_ok());
}
