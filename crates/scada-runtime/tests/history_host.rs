//! H1 request/response over real temporary SQLite, including active recording.
use scada_historian::{
    store::{
        evidence::{ClockStamp, PlanRef, TimedStart},
        query::{QueryControl, QueryError},
        retention::{
            application::{PolicyApplyRequest, PolicyPreparationRequest},
            clock_guard::{ClockSample, CutoffRule, RetentionClockPolicy},
            coordinator::{CoordinatorIntent, CoordinatorOutcome},
            jobs::{JobRequest, JobStepRequest},
            TrimRequest,
        },
        ObservationValue, Quality, Reason, Source, SourceEpoch, SqliteStore, StoreError,
        StoreIdentity, Tick, TickObservation,
    },
    validate_history_contract,
};
use scada_runtime::{
    history_host::{HistoryCompletion, HistoryHost, HistoryHostError, HistoryPhase},
    recording_host::{RecordingHost, RecordingOptions, RetentionTurnInput},
};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::{sleep, timeout};

#[allow(dead_code)]
#[path = "support/recorder_hub.rs"]
mod sdk_support;
use sdk_support::*;

struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn identity() -> StoreIdentity {
    StoreIdentity {
        store_id: "history-service".into(),
        deployment_id: "test".into(),
    }
}
fn empty() -> (SqliteStore, Directory) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let directory = Directory(std::env::temp_dir().join(format!(
        "scada-history-service-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    (
        SqliteStore::create(&directory.0, identity()).unwrap(),
        directory,
    )
}
fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(5)).unwrap()
}
fn query(mode: &str, limit: u64, from: i64, to: i64) -> Value {
    json!({"version":1,"kind":"query","requestId":"same-id","seriesIds":["series-0"],"fromMs":from,"toMs":to,"mode":mode,"maxPointsPerSeries":limit})
}
async fn execute(host: &mut HistoryHost, query: Value) -> Arc<HistoryCompletion> {
    let token = host.start_query(query, control()).unwrap();
    host.join_query(&token).await.unwrap()
}
fn seeded() -> (SqliteStore, Directory) {
    let (mut store, directory) = empty();
    store
        .begin_timed_session(
            plan(Some(7), Source::Real, false).session().clone(),
            TimedStart {
                clock_epoch: "record-epoch".into(),
                at_ms: 1000,
                plan: PlanRef {
                    plan_id: "plan".into(),
                    revision: 1,
                },
            },
        )
        .unwrap();
    for (index, time) in [1000, 2000, 3000].into_iter().enumerate() {
        let invalid = index == 1;
        store
            .append_tick(Tick {
                session_id: "recording".into(),
                sequence: index as u64 + 1,
                clock_epoch: "record-epoch".into(),
                sample_time_ms: time,
                ingested_at_ms: time,
                observations: vec![TickObservation {
                    series_id: "series-0".into(),
                    source_time_ms: Some(time - 10),
                    quality: Some(if invalid { Quality::Bad } else { Quality::Good }),
                    source: Some(Source::Real),
                    value: (!invalid).then_some(ObservationValue::Number(if index == 0 {
                        0.0
                    } else {
                        10.0
                    })),
                    reason: invalid.then_some(Reason::Bad),
                    source_epoch: Some(SourceEpoch {
                        hub_instance_id: "test-hub".into(),
                        run_id: Some(u64::MAX),
                        catalog_revision: u64::MAX,
                        sdk_generation: u64::MAX,
                    }),
                }],
            })
            .unwrap();
    }
    store
        .close_timed_session(
            "recording",
            ClockStamp {
                clock_epoch: "record-epoch".into(),
                at_ms: 4000,
            },
        )
        .unwrap();
    (store, directory)
}

#[tokio::test]
async fn raw_minmax_nulls_unknown_series_and_snapshot_results_keep_the_h1_meaning() {
    let (mut store, _directory) = seeded();
    let mut host = HistoryHost::new(store.reader().unwrap());
    let raw = execute(&mut host, query("raw", 4, 1000, 4000)).await;
    let value = raw.result.as_ref().unwrap();
    validate_history_contract(value).unwrap();
    let samples = value["series"][0]["raw"].as_array().unwrap();
    assert_eq!(samples.len(), 3);
    assert_eq!(samples[0]["value"], 0.0);
    assert_eq!(samples[1]["reason"], "bad");
    assert!(samples[1]["value"].is_null());
    assert_eq!(samples[2]["sourceTimeMs"], 2990);
    let mut mixed = query("minmax", 3, 1000, 4000);
    mixed["seriesIds"] = json!(["series-0", "unknown"]);
    let aggregated = execute(&mut host, mixed).await;
    let result = aggregated.result.as_ref().unwrap();
    validate_history_contract(result).unwrap();
    assert_eq!(result["series"][0]["bins"].as_array().unwrap().len(), 3);
    assert_eq!(result["series"][0]["bins"][1]["state"], "gap");
    assert_eq!(result["series"][0]["bins"][1]["invalidCount"], 1);
    assert_eq!(result["series"][1]["status"], "unknownSeries");
    let old = value.clone();
    store
        .trim(
            TrimRequest {
                request_id: "trim".into(),
                cutoff_ms: 2000,
                expected_cutoff_ms: None,
            },
            &control(),
        )
        .unwrap();
    let after = execute(&mut host, query("raw", 4, 1000, 4000)).await;
    let after = after.result.as_ref().unwrap();
    assert_ne!(after["snapshotId"], value["snapshotId"]);
    assert_eq!(value, &old);
    assert_eq!(after["series"][0]["raw"].as_array().unwrap().len(), 2);
    assert!(after["series"][0]["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["reason"] == "expired"));
}

#[tokio::test]
async fn raw_point_limit_is_an_error_and_caller_explicitly_selects_minmax_afterwards() {
    let (store, _directory) = seeded();
    let mut host = HistoryHost::new(store.reader().unwrap());
    assert_eq!(
        execute(&mut host, query("raw", 2, 1000, 4000)).await.result,
        Err(QueryError::TooManyPoints)
    );
    assert_eq!(host.state().phase, HistoryPhase::Idle);
    let minmax = execute(&mut host, query("minmax", 2, 1000, 4000)).await;
    let value = minmax.result.as_ref().unwrap();
    assert_eq!(value["query"]["mode"], "minmax");
    assert_eq!(value["series"][0]["bins"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn two_hosts_use_only_two_leases_and_same_request_id_does_not_confuse_tokens() {
    let (store, _directory) = seeded();
    let mut first = HistoryHost::new(store.reader().unwrap());
    let mut second = HistoryHost::new(store.reader().unwrap());
    assert!(matches!(store.reader(), Err(StoreError::Busy)));
    let a = first
        .start_query(query("raw", 4, 1000, 4000), control())
        .unwrap();
    let b = second
        .start_query(query("raw", 4, 1000, 4000), control())
        .unwrap();
    assert_ne!(a, b);
    assert_eq!(first.cancel_query(&b), Err(HistoryHostError::WrongRequest));
    let (ra, rb) = tokio::join!(first.join_query(&a), second.join_query(&b));
    assert!(ra.unwrap().result.is_ok());
    assert!(rb.unwrap().result.is_ok());
    drop(first.take_reader().unwrap());
    drop(store.reader().unwrap());
}

#[tokio::test]
async fn invalid_new_request_preserves_last_completion_and_a_fresh_execution_gets_new_token() {
    let (store, _directory) = seeded();
    let mut host = HistoryHost::new(store.reader().unwrap());
    let old = host
        .start_query(query("raw", 4, 1000, 4000), control())
        .unwrap();
    let result = host.join_query(&old).await.unwrap();
    let mut invalid = query("raw", 4, 1000, 4000);
    invalid["requestId"] = Value::String("x".repeat(9000));
    assert_eq!(
        host.start_query(invalid, control()),
        Err(HistoryHostError::Request(QueryError::ByteLimit))
    );
    assert!(Arc::ptr_eq(&result, &host.join_query(&old).await.unwrap()));
    let fresh = host
        .start_query(query("raw", 4, 1000, 4000), control())
        .unwrap();
    assert_ne!(old, fresh);
    assert!(matches!(
        host.join_query(&old).await,
        Err(HistoryHostError::WrongRequest)
    ));
    assert!(host.join_query(&fresh).await.unwrap().result.is_ok());
}

fn policy() -> RetentionClockPolicy {
    RetentionClockPolicy {
        policy_id: "policy".into(),
        revision: 1,
        cutoff_rule: CutoffRule::Elapsed {
            retain_for_ms: 1000,
        },
        tolerance_ms: 20,
        max_observation_gap_ms: 5000,
        max_cutoff_advance_ms: 10000,
        initial_cutoff_ceiling_ms: Some(9_007_199_254_740_991),
    }
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
fn retention_input(wall: i64, mono: u64, intent: CoordinatorIntent) -> RetentionTurnInput {
    RetentionTurnInput {
        policy: policy(),
        sample: ClockSample {
            clock_epoch: "retention-clock".into(),
            wall_time_ms: wall + mono as i64,
            monotonic_ms: mono,
            trusted: true,
        },
        candidate_cutoff_ms: None,
        intent,
    }
}

#[tokio::test]
async fn one_preissued_reader_queries_live_recording_then_expired_after_paused_retention() {
    let hub = Hub::new().await;
    let (mut store, directory) = empty();
    let reference = now();
    let prepared = store
        .preview_retention_policy_application(
            &PolicyPreparationRequest {
                proposed_policy: policy(),
                reference_wall_ms: reference,
            },
            &control(),
        )
        .unwrap();
    store
        .apply_retention_policy(
            &PolicyApplyRequest {
                request_id: "apply".into(),
                expected_applied_revision: prepared.expected_applied_revision,
                expected_preview_snapshot_commit: prepared.snapshot_commit,
                proposed_policy: policy(),
                reference_wall_ms: reference,
            },
            &control(),
        )
        .unwrap();
    let mut history = HistoryHost::new(store.reader().unwrap());
    let mut recording = RecordingHost::new(store);
    recording
        .start(
            plan(Some(7), Source::Real, false),
            RecordingOptions {
                plan: PlanRef {
                    plan_id: "plan".into(),
                    revision: 1,
                },
                slot_count: Some(2),
                max_clock_skew_ms: 1000,
                clock_epoch: "record-clock".into(),
            },
            hub.client(),
        )
        .unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    timeout(Duration::from_secs(3), async {
        while recording.state().progress.is_none() {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let first_time = recording
        .state()
        .progress
        .as_ref()
        .unwrap()
        .observation
        .as_ref()
        .unwrap()
        .observed
        .wall_time_ms;
    let token = history
        .start_query(
            query("raw", 4, first_time - 1, first_time + 3000),
            control(),
        )
        .unwrap();
    // The current-thread SDK executor continues while SQLite runs off-thread.
    sleep(Duration::from_millis(5)).await;
    let live = history.join_query(&token).await.unwrap();
    assert!(!live.result.as_ref().unwrap()["series"][0]["raw"]
        .as_array()
        .unwrap()
        .is_empty());
    recording.join().await.unwrap();
    closed(&mut socket).await;
    let before = execute(
        &mut history,
        query("raw", 4, first_time - 1, first_time + 3000),
    )
    .await;
    assert_eq!(
        before.result.as_ref().unwrap()["series"][0]["raw"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let minmax = execute(
        &mut history,
        query("minmax", 3, first_time - 1, first_time + 3000),
    )
    .await;
    validate_history_contract(minmax.result.as_ref().unwrap()).unwrap();
    // Explicit synthetic trusted fixture samples; no OS clock certification.
    let wall = now() + 900;
    for (mono, intent) in [
        (0, CoordinatorIntent::Observe),
        (
            1,
            CoordinatorIntent::Begin(JobRequest {
                job_id: "job".into(),
                cutoff_ms: wall + 1 - 1000,
                expected_cutoff_ms: None,
            }),
        ),
        (
            2,
            CoordinatorIntent::ContinueExisting(JobStepRequest {
                job_id: "job".into(),
                step: 1,
                max_ticks: 8,
            }),
        ),
    ] {
        recording
            .start_retention_turn(retention_input(wall, mono, intent), control())
            .unwrap();
        let result = recording.join_retention_turn().await.unwrap();
        if mono == 2 {
            assert!(
                matches!(result.report.outcome,Ok(CoordinatorOutcome::Stepped(ref r)) if r.completed)
            );
        }
    }
    let expired = execute(
        &mut history,
        query("raw", 4, first_time - 1, first_time + 3000),
    )
    .await;
    let expired = expired.result.as_ref().unwrap();
    assert!(expired["series"][0]["raw"].as_array().unwrap().is_empty());
    assert!(expired["series"][0]["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["reason"] == "expired"));
    assert_eq!(
        before.result.as_ref().unwrap()["series"][0]["raw"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    drop(recording.take_store().unwrap());
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &identity()),
        Err(StoreError::Busy)
    ));
    drop(history.take_reader().unwrap());
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    loop {
        match SqliteStore::open_existing(&directory.0, &identity()) {
            Err(StoreError::Busy) if std::time::Instant::now() < deadline => {
                sleep(Duration::from_millis(5)).await
            }
            result => {
                drop(result.unwrap());
                break;
            }
        }
    }
}
