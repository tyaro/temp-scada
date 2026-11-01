use super::*;
use crate::store::test_support::*;
fn control() -> QueryControl {
    QueryControl::with_timeout(std::time::Duration::from_secs(10)).unwrap()
}
fn begin_request() -> JobRequest {
    JobRequest {
        job_id: "job".into(),
        cutoff_ms: 2000,
        expected_cutoff_ms: None,
    }
}
fn step(step: u64, max_ticks: u32) -> JobStepRequest {
    JobStepRequest {
        job_id: "job".into(),
        step,
        max_ticks,
    }
}
#[test]
fn persistent_small_steps_finish_and_preserve_stable_receipts() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    for n in 1..=3 {
        store.append_tick(tick("a", n, 1000)).unwrap();
    }
    store.close_session("a").unwrap();
    let begun = store
        .begin_retention_job(begin_request(), &control())
        .unwrap();
    let first = store.step_retention_job(step(1, 2), &control()).unwrap();
    assert!(!first.completed);
    assert_eq!(count(&store, "observations"), 2);
    assert!(matches!(
        store.begin_session(spec("b")),
        Err(StoreError::Busy)
    ));
    drop(store);
    let mut store = directory.open();
    assert_eq!(
        store
            .begin_retention_job(begin_request(), &control())
            .unwrap(),
        begun
    );
    assert_eq!(
        store.step_retention_job(step(1, 2), &control()).unwrap(),
        first
    );
    let last = store.step_retention_job(step(2, 2), &control()).unwrap();
    assert!(last.completed);
    assert_eq!(count(&store, "observations"), 0);
    assert_eq!(
        fence(&store.connection).unwrap(),
        (Some(2000), last.commit_version as i64)
    );
    store.begin_session(spec("b")).unwrap();
    assert!(matches!(
        store.append_tick(tick("b", 1, 1000)),
        Err(StoreError::RetentionCutoff)
    ));
}

fn setup(times: impl IntoIterator<Item = i64>) -> (TempStore, SqliteStore) {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    for (index, time) in times.into_iter().enumerate() {
        store
            .append_tick(tick("a", index as u64 + 1, time))
            .unwrap();
    }
    store.close_session("a").unwrap();
    (directory, store)
}
fn query(
    store: &SqliteStore,
    mode: &str,
) -> Result<serde_json::Value, crate::store::query::QueryError> {
    let mut reader = store.reader().unwrap();
    let q = serde_json::json!({"version":1,"kind":"query","requestId":"q","seriesIds":["number","bool"],"fromMs":0,"toMs":4000,"mode":mode,"maxPointsPerSeries":2});
    if mode == "raw" {
        reader.query_raw(&q, &control())
    } else {
        reader.query_minmax(&q, &control())
    }
}
fn rows(store: &SqliteStore, table: &str) -> i64 {
    assert!([
        "retention_jobs",
        "retention_job_steps",
        "retention_job_pending",
        "job_expired_samples"
    ]
    .contains(&table));
    store
        .connection
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn same_timestamp_1025_ticks_progress_without_publishing_expiry_over_remaining_raw() {
    let (_directory, mut store) = setup(std::iter::repeat_n(1000, 1025));
    assert!(matches!(
        store.trim(
            TrimRequest {
                request_id: "single".into(),
                cutoff_ms: 2000,
                expected_cutoff_ms: None
            },
            &control()
        ),
        Err(StoreError::RetentionLimit)
    ));
    store
        .begin_retention_job(begin_request(), &control())
        .unwrap();
    let first = store.step_retention_job(step(1, 1024), &control()).unwrap();
    assert_eq!(first.deleted_ticks, 1024);
    assert!(!first.completed);
    assert_eq!(rows(&store, "retention_job_pending"), 2);
    assert_eq!(rows(&store, "job_expired_samples"), 0);
    for mode in ["raw", "minmax"] {
        let result = query(&store, mode).unwrap();
        assert_eq!(
            result["series"][0]["coverage"],
            serde_json::json!([{"fromMs":0,"toMs":4000,"reason":"unknownCoverage"}])
        );
    }
    let last = store.step_retention_job(step(2, 1024), &control()).unwrap();
    assert!(last.completed);
    assert_eq!(last.deleted_ticks, 1);
    assert_eq!(rows(&store, "retention_job_pending"), 0);
    assert_eq!(rows(&store, "job_expired_samples"), 2);
    let records: i64 = store
        .connection
        .query_row(
            "SELECT deleted_records FROM job_expired_samples WHERE series_id='number'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(records, 1025);
    for mode in ["raw", "minmax"] {
        let result = query(&store, mode).unwrap();
        assert_eq!(
            result["series"][0]["coverage"],
            serde_json::json!([{"fromMs":0,"toMs":1000,"reason":"unknownCoverage"},{"fromMs":1000,"toMs":1001,"reason":"expired"},{"fromMs":1001,"toMs":4000,"reason":"unknownCoverage"}])
        );
    }
    let status = store
        .retention_job_status("job", &control())
        .unwrap()
        .unwrap();
    assert_eq!(status.deleted_ticks, 1025);
    assert_eq!(status.deleted_observations, 2050);
    assert_eq!(status.next_step, None);
}

#[test]
fn dense_1025_times_are_sql_coalesced_and_completed_jobs_compose_with_single_trim() {
    let (_directory, mut store) = setup(1..=1025);
    store
        .begin_retention_job(begin_request(), &control())
        .unwrap();
    for n in 1..=9 {
        let receipt = store.step_retention_job(step(n, 128), &control()).unwrap();
        assert_eq!(receipt.completed, n == 9);
    }
    let result = query(&store, "minmax").unwrap();
    assert_eq!(
        result["series"][0]["coverage"],
        serde_json::json!([{"fromMs":0,"toMs":1,"reason":"unknownCoverage"},{"fromMs":1,"toMs":1026,"reason":"expired"},{"fromMs":1026,"toMs":4000,"reason":"unknownCoverage"}])
    );
    store.begin_session(spec("b")).unwrap();
    store.append_tick(tick("b", 1, 2500)).unwrap();
    store.close_session("b").unwrap();
    store
        .trim(
            TrimRequest {
                request_id: "after-job".into(),
                cutoff_ms: 3000,
                expected_cutoff_ms: Some(2000),
            },
            &control(),
        )
        .unwrap();
    let result = query(&store, "raw").unwrap();
    assert_eq!(result["series"][0]["coverage"].as_array().unwrap().len(), 5);
}

#[test]
fn job_admission_sequence_payload_and_no_active_recording_are_enforced() {
    let (directory, mut store) = setup([1000, 1500]);
    assert_eq!(
        store.retention_job_status("unknown", &control()).unwrap(),
        None
    );
    let original = store.append_tick(tick("a", 1, 1000)).unwrap();
    let started = store
        .begin_retention_job(begin_request(), &control())
        .unwrap();
    let before = counter(&store);
    let mut wrong = begin_request();
    wrong.cutoff_ms = 2001;
    assert!(matches!(
        store.begin_retention_job(wrong, &control()),
        Err(StoreError::Conflict)
    ));
    let mut other = begin_request();
    other.job_id = "other".into();
    assert!(matches!(
        store.begin_retention_job(other, &control()),
        Err(StoreError::Busy)
    ));
    assert!(matches!(
        store.begin_session(spec("b")),
        Err(StoreError::Busy)
    ));
    assert!(matches!(
        store.trim(
            TrimRequest {
                request_id: "trim".into(),
                cutoff_ms: 2000,
                expected_cutoff_ms: None
            },
            &control()
        ),
        Err(StoreError::Busy)
    ));
    assert_eq!(store.append_tick(tick("a", 1, 1000)).unwrap(), original);
    assert!(matches!(
        store.append_tick(tick("a", 3, 1800)),
        Err(StoreError::Busy)
    ));
    assert!(store.step_retention_job(step(2, 1), &control()).is_err());
    assert_eq!(counter(&store), before);
    let first = store.step_retention_job(step(1, 1), &control()).unwrap();
    assert!(!first.completed);
    assert!(matches!(
        store.step_retention_job(step(1, 2), &control()),
        Err(StoreError::Conflict)
    ));
    assert_eq!(
        store
            .begin_retention_job(begin_request(), &control())
            .unwrap(),
        started
    );
    drop(store);
    let mut store = directory.open();
    let last = store.step_retention_job(step(2, 1), &control()).unwrap();
    assert!(last.completed);
    assert_eq!(
        store.step_retention_job(step(1, 1), &control()).unwrap(),
        first
    );
    assert!(store.step_retention_job(step(3, 1), &control()).is_err());
}

#[test]
fn expired_source_must_reference_the_latest_step_even_when_published_earlier() {
    use crate::store::query::QueryError;
    let (_directory, mut store) = setup([1000, 1500]);
    store
        .begin_retention_job(begin_request(), &control())
        .unwrap();
    store.step_retention_job(step(1, 1), &control()).unwrap();
    assert!(query(&store, "raw").is_ok());
    store
        .connection
        .execute("UPDATE retention_jobs SET last_step=2", [])
        .unwrap();
    assert_eq!(query(&store, "raw"), Err(QueryError::CorruptData));
}

#[test]
fn failed_chunks_are_fully_atomic_and_postcommit_retry_is_stable() {
    for boundary in [
        Boundary::Metadata,
        Boundary::Observation,
        Boundary::Watermark,
        Boundary::BeforeCommit,
        Boundary::AfterCommit,
    ] {
        let (directory, mut store) = setup([1000, 1500]);
        store
            .begin_retention_job(begin_request(), &control())
            .unwrap();
        let before = counter(&store);
        assert!(store
            .step_job_with_hook(step(1, 2), &control(), &mut |at| if at == boundary {
                invalid("fault")
            } else {
                Ok(())
            })
            .is_err());
        assert!(store.connection.is_autocommit());
        if boundary != Boundary::AfterCommit {
            assert_eq!(counter(&store), before);
            assert_eq!(count(&store, "observations"), 4);
            assert_eq!(rows(&store, "retention_job_steps"), 0);
            assert_eq!(rows(&store, "retention_job_pending"), 0);
            assert_eq!(rows(&store, "job_expired_samples"), 0);
            assert_eq!(fence(&store.connection).unwrap(), (None, 0));
        }
        drop(store);
        let mut store = directory.open();
        let receipt = store.step_retention_job(step(1, 2), &control()).unwrap();
        assert!(receipt.completed);
        let before = counter(&store);
        assert_eq!(
            store.step_retention_job(step(1, 2), &control()).unwrap(),
            receipt
        );
        assert_eq!(counter(&store), before);
    }
}

#[test]
fn empty_job_finishes_without_expiry_and_format_three_is_refused() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store
        .begin_retention_job(begin_request(), &control())
        .unwrap();
    let receipt = store.step_retention_job(step(1, 1), &control()).unwrap();
    assert!(receipt.completed);
    assert_eq!(receipt.deleted_ticks, 0);
    assert_eq!(rows(&store, "job_expired_samples"), 0);
    drop(store);
    let path = directory.0.join("store.sqlite3");
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("PRAGMA user_version=3").unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();
    assert!(matches!(
        reopen_unowned(&directory.0, &identity()),
        Err(StoreError::UnsupportedStore)
    ));
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn past_step_replay_cannot_escape_latest_commit_or_state_bounds() {
    for corruption in [
        "UPDATE retention_job_steps SET commit_version=999999 WHERE step=1",
        "UPDATE retention_job_steps SET completed=1 WHERE step=1",
    ] {
        let (_directory, mut store) = setup([1000, 1200, 1400]);
        store
            .begin_retention_job(begin_request(), &control())
            .unwrap();
        store.step_retention_job(step(1, 1), &control()).unwrap();
        store.step_retention_job(step(2, 1), &control()).unwrap();
        store.connection.execute_batch(corruption).unwrap();
        assert!(
            matches!(
                store.step_retention_job(step(1, 1), &control()),
                Err(StoreError::CorruptData)
            ),
            "{corruption}"
        );
    }
}

#[test]
fn active_recording_and_invalid_job_requests_leave_no_partial_job() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    let before = counter(&store);
    assert!(matches!(
        store.begin_retention_job(begin_request(), &control()),
        Err(StoreError::Busy)
    ));
    assert_eq!(counter(&store), before);
    assert_eq!(rows(&store, "retention_jobs"), 0);
    store.close_session("a").unwrap();
    let before = counter(&store);
    let mut bad = begin_request();
    bad.expected_cutoff_ms = Some(0);
    assert!(matches!(
        store.begin_retention_job(bad, &control()),
        Err(StoreError::Conflict)
    ));
    let mut bad = begin_request();
    bad.cutoff_ms = MAX_SAFE as i64 + 1;
    assert!(matches!(
        store.begin_retention_job(bad, &control()),
        Err(StoreError::Invalid(_))
    ));
    assert_eq!(counter(&store), before);
    assert_eq!(rows(&store, "retention_jobs"), 0);
    store
        .begin_retention_job(begin_request(), &control())
        .unwrap();
    for bad in [step(0, 1), step(1, 0), step(1, 1025), step(MAX_SAFE + 1, 1)] {
        assert!(matches!(
            store.step_retention_job(bad, &control()),
            Err(StoreError::Invalid(_))
        ));
    }
}

#[test]
fn full_and_capacity_recovery_keep_the_job_resumable_without_partial_expiry() {
    let (directory, mut store) = setup([1000]);
    store
        .begin_retention_job(begin_request(), &control())
        .unwrap();
    store.connection.execute_batch("CREATE TABLE job_pressure(value BLOB); CREATE TEMP TRIGGER full_step AFTER DELETE ON observations BEGIN INSERT INTO job_pressure VALUES(zeroblob(1048576)); END;").unwrap();
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
    let before = counter(&store);
    let error = store
        .step_retention_job(step(1, 1), &control())
        .unwrap_err();
    assert!(
        matches!(&error,StoreError::Sqlite(e)if e.sqlite_error_code()==Some(rusqlite::ErrorCode::DiskFull)),
        "{error:?}"
    );
    assert!(store.needs_reopen);
    assert!(store.connection.is_autocommit());
    assert_eq!(counter(&store), before);
    assert_eq!(count(&store, "observations"), 2);
    assert_eq!(rows(&store, "retention_job_steps"), 0);
    assert_eq!(rows(&store, "job_expired_samples"), 0);
    assert_eq!(rows(&store, "retention_job_pending"), 0);
    store
        .connection
        .pragma_update(None, "max_page_count", maximum)
        .unwrap();
    store
        .connection
        .execute_batch("DROP TRIGGER full_step")
        .unwrap();
    drop(store);
    let mut store = directory.open();
    assert!(matches!(
        store.begin_session(spec("b")),
        Err(StoreError::Busy)
    ));
    assert!(
        store
            .step_retention_job(step(1, 1), &control())
            .unwrap()
            .completed
    );
}

#[test]
fn cancellation_limits_and_unwind_leave_an_uncommitted_step_reusable() {
    let (_directory, mut store) = setup([1000, 1500]);
    store
        .begin_retention_job(begin_request(), &control())
        .unwrap();
    let before = counter(&store);
    for kind in 0..5 {
        let mut c = control();
        match kind {
            0 => c.cancellation.cancel(),
            1 => c.deadline = std::time::Instant::now(),
            2 => c.limits.max_decoded_rows = 1,
            3 => c.limits.max_output_bytes = 1,
            _ => c.limits.max_vm_steps = 1000,
        }
        assert!(matches!(
            store.step_retention_job(step(1, 2), &c),
            Err(StoreError::Control(_))
        ));
        assert!(store.connection.is_autocommit());
        assert_eq!(counter(&store), before);
        assert_eq!(count(&store, "observations"), 4);
        assert_eq!(rows(&store, "retention_job_steps"), 0);
    }
    let c = control();
    assert!(matches!(
        store.step_job_with_hook(step(1, 2), &c, &mut |at| {
            if at == Boundary::Observation {
                c.cancellation.cancel();
            }
            Ok(())
        }),
        Err(StoreError::Control(_))
    ));
    assert_eq!(counter(&store), before);
    assert!(store.connection.is_autocommit());
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = store.step_job_with_hook(step(1, 2), &control(), &mut |at| {
            if at == Boundary::Observation {
                panic!("fault unwind");
            }
            Ok(())
        });
    }));
    assert!(panic.is_err());
    assert!(store.connection.is_autocommit());
    assert!(!store.needs_reopen);
    assert_eq!(counter(&store), before);
    assert!(
        !store
            .step_retention_job(step(1, 1), &control())
            .unwrap()
            .completed
    );
}

#[test]
fn process_exit_at_step_boundaries_preserves_progress_and_stable_retries() {
    for boundary in [
        "Metadata",
        "Observation",
        "Watermark",
        "BeforeCommit",
        "AfterCommit",
    ] {
        let (directory, mut store) = setup([1000, 1500]);
        store
            .begin_retention_job(begin_request(), &control())
            .unwrap();
        let before = counter(&store);
        drop(store);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store::retention::jobs::tests::job_process_worker",
                "--nocapture",
            ])
            .env("SCADA_JOB_TEST_PATH", &directory.0)
            .env("SCADA_JOB_TEST_BOUNDARY", boundary)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(87));
        let mut store = directory.open();
        let committed = boundary == "AfterCommit";
        assert_eq!(count(&store, "observations"), if committed { 0 } else { 4 });
        assert_eq!(rows(&store, "retention_job_steps"), i64::from(committed));
        if !committed {
            assert_eq!(counter(&store), before);
            assert!(matches!(
                store.begin_session(spec("b")),
                Err(StoreError::Busy)
            ));
        }
        let receipt = store.step_retention_job(step(1, 2), &control()).unwrap();
        assert!(receipt.completed);
        let before = counter(&store);
        assert_eq!(
            store.step_retention_job(step(1, 2), &control()).unwrap(),
            receipt
        );
        assert_eq!(counter(&store), before);
    }
}

#[test]
fn job_process_worker() {
    let Ok(path) = std::env::var("SCADA_JOB_TEST_PATH") else {
        return;
    };
    let boundary = std::env::var("SCADA_JOB_TEST_BOUNDARY").unwrap();
    let mut store = reopen_unowned(path, &identity()).unwrap();
    store
        .step_job_with_hook(step(1, 2), &control(), &mut |at| {
            if format!("{at:?}") == boundary {
                std::process::exit(87);
            }
            Ok(())
        })
        .unwrap();
    panic!("step boundary not reached");
}

#[test]
fn completed_job_expiry_requires_a_valid_latest_receipt_and_unique_source() {
    use crate::store::query::QueryError;
    for corruption in ["PRAGMA foreign_keys=OFF; DELETE FROM retention_job_steps WHERE step=2", "UPDATE job_expired_samples SET deleted_records=999999", "INSERT INTO retention_operations VALUES('duplicate','{}',2000,1,1,1); INSERT INTO expired_samples VALUES('number',1000,'duplicate',1)"] {
 let (_directory,mut store)=setup([1000,1500]);store.begin_retention_job(begin_request(),&control()).unwrap();store.step_retention_job(step(1,1),&control()).unwrap();store.step_retention_job(step(2,1),&control()).unwrap();
 store.connection.execute_batch(corruption).unwrap();assert_eq!(query(&store,"raw"),Err(QueryError::CorruptData),"{corruption}");
 }
}

#[test]
fn sparse_job_expiry_still_has_a_finite_final_interval_limit() {
    use crate::store::query::QueryError;
    let (_directory, mut store) = setup((0..257).map(|n| n * 2 + 1));
    store
        .begin_retention_job(begin_request(), &control())
        .unwrap();
    for n in 1..=3 {
        store.step_retention_job(step(n, 128), &control()).unwrap();
    }
    assert_eq!(query(&store, "raw"), Err(QueryError::CoverageLimit));
}

#[test]
fn negative_safe_integer_cutoff_and_expired_end_are_exact() {
    let directory = TempStore::new();
    let mut store = directory.create();
    store.begin_session(spec("a")).unwrap();
    let time = -(MAX_SAFE as i64);
    let mut t = tick("a", 1, time);
    t.ingested_at_ms = time;
    for observation in &mut t.observations {
        observation.source_time_ms = Some(time);
    }
    store.append_tick(t).unwrap();
    store.close_session("a").unwrap();
    let mut request = begin_request();
    request.cutoff_ms = time + 1;
    store.begin_retention_job(request, &control()).unwrap();
    assert!(
        store
            .step_retention_job(step(1, 1), &control())
            .unwrap()
            .completed
    );
    let mut reader = store.reader().unwrap();
    let q = serde_json::json!({"version":1,"kind":"query","requestId":"q","seriesIds":["number"],"fromMs":time,"toMs":time+2,"mode":"raw","maxPointsPerSeries":1});
    let result = reader.query_raw(&q, &control()).unwrap();
    assert_eq!(
        result["series"][0]["coverage"][0],
        serde_json::json!({"fromMs":time,"toMs":time+1,"reason":"expired"})
    );
}

#[test]
fn narrow_expiry_queries_validate_latest_and_past_step_counts() {
    use crate::store::query::QueryError;
    for corruption in [
        "UPDATE retention_job_steps SET deleted_ticks=0,deleted_observations=0 WHERE step=2",
        "UPDATE retention_job_steps SET deleted_ticks=3,deleted_observations=3 WHERE step=1",
    ] {
        let (_directory, mut store) = setup([1000, 1500, 1800]);
        store
            .begin_retention_job(begin_request(), &control())
            .unwrap();
        store.step_retention_job(step(1, 1), &control()).unwrap();
        store.step_retention_job(step(2, 1), &control()).unwrap();
        store.connection.execute_batch(corruption).unwrap();
        let mut reader = store.reader().unwrap();
        let q = serde_json::json!({"version":1,"kind":"query","requestId":"q","seriesIds":["number"],"fromMs":1000,"toMs":1001,"mode":"raw","maxPointsPerSeries":1});
        assert_eq!(
            reader.query_raw(&q, &control()),
            Err(QueryError::CorruptData),
            "{corruption}"
        );
    }
}

#[test]
fn small_step_discovers_only_a_time_index_prefix_in_a_large_history() {
    let (_directory, mut store) = setup(1..=4096);
    let mut request = begin_request();
    request.cutoff_ms = 5000;
    store.begin_retention_job(request, &control()).unwrap();
    let mut bounded = control();
    bounded.limits.max_vm_steps = 80_000;
    let receipt = store.step_retention_job(step(1, 1), &bounded).unwrap();
    assert_eq!(receipt.deleted_ticks, 1);
    assert!(!receipt.completed);
}
