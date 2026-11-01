//! Paused retention turns and explicit resume over real temporary SQLite/SDK.
use scada_historian::{
    recorder::StopCause,
    store::{
        query::QueryControl,
        retention::{
            application::{PolicyApplyRequest, PolicyPreparationRequest},
            clock_guard::{ClockSample, CutoffRule, GuardState, RetentionClockPolicy},
            coordinator::{CoordinatorIntent, CoordinatorOutcome, NoWriteReason},
            jobs::{JobRequest, JobStepRequest},
        },
        Source, SqliteStore, StoreIdentity,
    },
};
use scada_runtime::{
    recorder_source::{SdkBindingPin, SdkGenerationPin, SdkRecorderPlan},
    recording_host::{
        RecordingCompletion, RecordingHost, RecordingHostError, RecordingOptions, RecordingPhase,
        RetentionTurnCompletion, RetentionTurnInput,
    },
};
use serde_json::json;
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
fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(5)).unwrap()
}
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
fn policy() -> RetentionClockPolicy {
    RetentionClockPolicy {
        policy_id: "retention".into(),
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
fn options(slots: u64, epoch: &str) -> RecordingOptions {
    RecordingOptions {
        plan: scada_historian::store::evidence::PlanRef {
            plan_id: "plan".into(),
            revision: 1,
        },
        slot_count: Some(slots),
        max_clock_skew_ms: 1000,
        clock_epoch: epoch.into(),
    }
}
fn new_plan(session: &str) -> SdkRecorderPlan {
    let mut spec = plan(Some(7), Source::Real, false).session().clone();
    spec.session_id = session.into();
    SdkRecorderPlan::new(
        spec,
        SdkGenerationPin {
            catalog_revision: 3,
            run_id: Some(7),
            collection_mode: banto_tagclient::CollectionMode::Configured,
        },
        vec![SdkBindingPin {
            series_id: "series-0".into(),
            stable_id: banto_tagclient::StableTagId::new(1, 2, 1),
            tag_key: NUMBER.into(),
            data_type: "f64".into(),
        }],
    )
    .unwrap()
}
fn host(applied: bool) -> (RecordingHost, Directory) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let directory = Directory(std::env::temp_dir().join(format!(
        "scada-recording-retention-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    let mut store = SqliteStore::create(
        &directory.0,
        StoreIdentity {
            store_id: "host-store".into(),
            deployment_id: "test-deployment".into(),
        },
    )
    .unwrap();
    if applied {
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
    }
    (RecordingHost::new(store), directory)
}
async fn paused(
    applied: bool,
    slots: u64,
) -> (RecordingHost, Directory, Hub, Arc<RecordingCompletion>) {
    let hub = Hub::new().await;
    let (mut host, directory) = host(applied);
    host.start(
        new_plan("first"),
        options(slots, "record-first"),
        hub.client(),
    )
    .unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    let completion = timeout(Duration::from_secs(5), host.join())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        completion
            .report
            .as_ref()
            .unwrap()
            .terminal
            .as_ref()
            .unwrap()
            .cause,
        StopCause::Completed
    ));
    assert_eq!(completion.source_shutdown, Ok(()));
    closed(&mut socket).await;
    (host, directory, hub, completion)
}
fn input(wall: i64, mono: u64, intent: CoordinatorIntent) -> RetentionTurnInput {
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
async fn turn(host: &mut RecordingHost, input: RetentionTurnInput) -> Arc<RetentionTurnCompletion> {
    host.start_retention_turn(input, control()).unwrap();
    host.join_retention_turn().await.unwrap()
}

#[tokio::test]
async fn clean_pause_bound_job_exact_steps_and_new_clock_resume_preserve_evidence() {
    let (mut host, _directory, hub, old) = paused(true, 2).await;
    assert_eq!(old.progress.as_ref().unwrap().counters.committed_ticks, 2);
    let first_time = old
        .progress
        .as_ref()
        .unwrap()
        .observation
        .as_ref()
        .unwrap()
        .observed
        .wall_time_ms
        - 1000;
    // Explicit fixture trust samples: elapsed cutoff stays safely behind the
    // local resume clock. This does not certify SystemTime's UTC accuracy.
    let wall = now() + 900;
    turn(&mut host, input(wall, 0, CoordinatorIntent::Observe)).await;
    let begin = turn(
        &mut host,
        input(
            wall,
            1,
            CoordinatorIntent::Begin(JobRequest {
                job_id: "job".into(),
                cutoff_ms: wall + 1 - 1000,
                expected_cutoff_ms: None,
            }),
        ),
    )
    .await;
    assert!(matches!(
        begin.report.outcome,
        Ok(CoordinatorOutcome::Begun(_))
    ));
    assert!(host.retention_guard_state().job_pending);
    assert!(matches!(
        host.start(
            new_plan("second"),
            options(1, "record-second"),
            hub.client()
        ),
        Err(RecordingHostError::RetentionPending)
    ));
    assert!(Arc::ptr_eq(&old, &host.join().await.unwrap()));
    let step = JobStepRequest {
        job_id: "job".into(),
        step: 1,
        max_ticks: 1,
    };
    let first = turn(
        &mut host,
        input(wall, 2, CoordinatorIntent::ContinueExisting(step.clone())),
    )
    .await;
    let Ok(CoordinatorOutcome::Stepped(first_receipt)) = &first.report.outcome else {
        panic!("{first:?}")
    };
    assert!(!first_receipt.completed);
    assert_eq!(first_receipt.deleted_ticks, 1);
    assert_eq!(
        first
            .report
            .recovery
            .as_ref()
            .unwrap()
            .active_job
            .as_ref()
            .unwrap()
            .status
            .policy_applied_revision,
        Some(1)
    );
    let replay = turn(
        &mut host,
        input(wall, 3, CoordinatorIntent::ContinueExisting(step)),
    )
    .await;
    let Ok(CoordinatorOutcome::Stepped(replayed)) = &replay.report.outcome else {
        panic!("{replay:?}")
    };
    assert_eq!(first_receipt, replayed);
    // Existing fixed-cutoff work may finish despite clock suspension; it may
    // not silently authorize another Begin or recording resume.
    let mut last = input(
        wall,
        4,
        CoordinatorIntent::ContinueExisting(JobStepRequest {
            job_id: "job".into(),
            step: 2,
            max_ticks: 1,
        }),
    );
    last.sample.trusted = false;
    let last = turn(&mut host, last).await;
    assert!(matches!(last.report.outcome,Ok(CoordinatorOutcome::Stepped(ref r)) if r.completed));
    assert!(!host.retention_guard_state().job_pending);
    assert!(host.retention_guard_state().rearm_required);
    assert!(matches!(
        host.start(
            new_plan("second"),
            options(1, "record-second"),
            hub.client()
        ),
        Err(RecordingHostError::RetentionRearmRequired)
    ));
    host.rearm_retention().unwrap();
    assert_eq!(
        host.retention_guard_state().guard_state,
        GuardState::Unarmed
    );
    host.start(
        new_plan("second"),
        options(1, "record-second"),
        hub.client(),
    )
    .unwrap();
    assert!(matches!(
        host.join_retention_turn().await,
        Err(RecordingHostError::Busy)
    ));
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    let resumed = host.join().await.unwrap();
    closed(&mut socket).await;
    assert_eq!(
        resumed.progress.as_ref().unwrap().counters.committed_ticks,
        1
    );
    let store = host.take_store().unwrap();
    let first = store.session_evidence("first").unwrap().unwrap();
    let second = store.session_evidence("second").unwrap().unwrap();
    assert_ne!(first.start.clock_epoch, second.start.clock_epoch);
    assert!(second.start.at_ms >= first.end_ms.unwrap());
    let raw=store.reader().unwrap().query_raw(&json!({"version":1,"kind":"query","requestId":"paused","seriesIds":["series-0"],"fromMs":first_time-100,"toMs":second.start.at_ms+1001,"mode":"raw","maxPointsPerSeries":8}),&control()).unwrap();
    let series = &raw["series"][0];
    assert_eq!(series["raw"].as_array().unwrap().len(), 1);
    assert_eq!(series["raw"][0]["recordId"]["sessionId"], "second");
    assert!(series["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["reason"] == "expired"));
    assert!(!series["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["reason"] == "samplingMissed"));
}

#[tokio::test]
async fn cancelled_turn_cannot_resume_until_explicit_rearm_and_fresh_observation() {
    let (mut host, _directory, hub, _old) = paused(false, 1).await;
    let wall = now();
    let cancelled = control();
    cancelled.cancellation.cancel();
    host.start_retention_turn(input(wall, 0, CoordinatorIntent::Observe), cancelled)
        .unwrap();
    let failed = host.join_retention_turn().await.unwrap();
    assert!(failed.report.outcome.is_err());
    host.rearm_retention().unwrap();
    assert!(matches!(
        host.start(new_plan("second"), options(1, "second-clock"), hub.client()),
        Err(RecordingHostError::RetentionPending)
    ));
    turn(&mut host, input(wall, 1, CoordinatorIntent::Observe)).await;
    assert!(!host.retention_guard_state().job_pending);
    host.start(new_plan("second"), options(1, "second-clock"), hub.client())
        .unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    host.join().await.unwrap();
    closed(&mut socket).await;
    assert!(matches!(
        host.join_retention_turn().await,
        Err(RecordingHostError::NotRunning)
    ));
}

#[tokio::test]
async fn begin_requires_actual_applied_policy_even_after_clean_pause_and_stable_clock() {
    let (mut host, _directory, _hub, _old) = paused(false, 1).await;
    let wall = now();
    turn(&mut host, input(wall, 0, CoordinatorIntent::Observe)).await;
    let completion = turn(
        &mut host,
        input(
            wall,
            1,
            CoordinatorIntent::Begin(JobRequest {
                job_id: "unapplied".into(),
                cutoff_ms: wall + 1 - 1000,
                expected_cutoff_ms: None,
            }),
        ),
    )
    .await;
    assert!(matches!(
        completion.report.outcome,
        Ok(CoordinatorOutcome::NoWrite {
            reason: NoWriteReason::PolicyNotApplied
        })
    ));
    let mut store = host.take_store().unwrap();
    assert!(store
        .recovery_state(&control())
        .unwrap()
        .active_job
        .is_none());
}

#[tokio::test]
async fn idle_running_unjoined_and_reused_session_or_clock_are_rejected() {
    let hub = Hub::new().await;
    let (mut host, _directory) = host(false);
    let wall = now();
    assert!(matches!(
        host.start_retention_turn(input(wall, 0, CoordinatorIntent::Observe), control()),
        Err(RecordingHostError::UncleanPause)
    ));
    host.start(new_plan("first"), options(1, "first-clock"), hub.client())
        .unwrap();
    assert!(matches!(
        host.start_retention_turn(input(wall, 0, CoordinatorIntent::Observe), control()),
        Err(RecordingHostError::Busy)
    ));
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    timeout(Duration::from_secs(3), async {
        while host.state().phase != RecordingPhase::FinishedUnjoined {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(matches!(
        host.start_retention_turn(input(wall, 0, CoordinatorIntent::Observe), control()),
        Err(RecordingHostError::Busy)
    ));
    host.join().await.unwrap();
    closed(&mut socket).await;
    assert!(matches!(
        host.start(new_plan("first"), options(1, "second-clock"), hub.client()),
        Err(RecordingHostError::SessionReuse)
    ));
    assert!(matches!(
        host.start(new_plan("second"), options(1, "first-clock"), hub.client()),
        Err(RecordingHostError::ClockEpochReuse)
    ));
    turn(&mut host, input(now(), 0, CoordinatorIntent::Observe)).await;
}

#[tokio::test]
async fn abnormal_source_exit_cannot_be_rearmed_into_a_clean_pause() {
    let hub = Hub::new().await;
    let (mut host, _directory) = host(false);
    host.start(new_plan("first"), options(5, "first-clock"), hub.client())
        .unwrap();
    let (mut stream, _) = timeout(Duration::from_secs(3), hub.listener.accept())
        .await
        .unwrap()
        .unwrap();
    request(&mut stream).await;
    reply(&mut stream, 401, &json!({"error":"test"})).await;
    let completion = host.join().await.unwrap();
    assert!(completion.source_shutdown.is_err());
    assert!(matches!(
        host.start_retention_turn(input(now(), 0, CoordinatorIntent::Observe), control()),
        Err(RecordingHostError::UncleanPause)
    ));
    assert!(matches!(
        host.rearm_retention(),
        Err(RecordingHostError::UncleanPause)
    ));
    assert!(matches!(
        host.start(new_plan("second"), options(1, "second-clock"), hub.client()),
        Err(RecordingHostError::UncleanPause)
    ));
    assert!(host.take_store().is_ok());
}
