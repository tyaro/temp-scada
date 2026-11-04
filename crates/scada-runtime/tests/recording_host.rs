//! Host ownership and real SDK liveness, using only temporary stores/loopback.
use banto_tagclient::{Endpoint, ErrorKind, RestClient, SecretApiKey};
use futures_util::SinkExt;
use scada_historian::{
    recorder::{RecorderStartError, StopCause},
    store::{
        evidence::PlanRef, query::QueryControl, Source, SqliteStore, StoreError, StoreIdentity,
    },
};
use scada_runtime::{
    recorder_source::SdkRecorderPlan,
    recording_host::{
        RecordingHost, RecordingHostError, RecordingHostStatus, RecordingOptions, RecordingPhase,
        RecordingStopReason,
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
    time::Duration,
};
use tokio::{
    sync::watch,
    time::{sleep, timeout},
};
use tokio_tungstenite::tungstenite::Message;

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
        store_id: "host-store".into(),
        deployment_id: "test-deployment".into(),
    }
}
fn host() -> (RecordingHost, Directory) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let directory = Directory(std::env::temp_dir().join(format!(
        "scada-recording-host-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    let store = SqliteStore::create(&directory.0, identity()).unwrap();
    (RecordingHost::new(store), directory)
}
fn options(slots: Option<u64>) -> RecordingOptions {
    RecordingOptions {
        plan: PlanRef {
            plan_id: "plan".into(),
            revision: 1,
        },
        slot_count: slots,
        max_clock_skew_ms: 1000,
        clock_epoch: "host-epoch".into(),
    }
}
fn new_session(session: &str) -> SdkRecorderPlan {
    // Public plan stays immutable; construct the new session from caller pins.
    let base = plan(Some(7), Source::Real, false);
    let mut spec = base.session().clone();
    spec.session_id = session.into();
    SdkRecorderPlan::new(
        spec,
        scada_runtime::recorder_source::SdkGenerationPin {
            catalog_revision: 3,
            run_id: Some(7),
            collection_mode: banto_tagclient::CollectionMode::Configured,
        },
        vec![scada_runtime::recorder_source::SdkBindingPin {
            series_id: "series-0".into(),
            stable_id: banto_tagclient::StableTagId::new(1, 2, 1),
            tag_key: NUMBER.into(),
            data_type: "f64".into(),
        }],
    )
    .unwrap()
}
async fn wait_status(
    receiver: &mut watch::Receiver<Arc<RecordingHostStatus>>,
    predicate: impl Fn(&RecordingHostStatus) -> bool,
) -> Arc<RecordingHostStatus> {
    timeout(Duration::from_secs(5), async {
        loop {
            let state = receiver.borrow_and_update().clone();
            if predicate(&state) {
                return state;
            }
            receiver.changed().await.unwrap();
        }
    })
    .await
    .expect("expected host state")
}
fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(5)).unwrap()
}
fn reopen_unowned(directory: &Directory) -> SqliteStore {
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    loop {
        match SqliteStore::open_existing(&directory.0, &identity()) {
            Err(StoreError::Busy) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5))
            }
            result => return result.unwrap(),
        }
    }
}

#[tokio::test]
async fn finite_recording_keeps_sdk_executor_live_and_returns_writer_only_after_join() {
    let hub = Hub::new().await;
    let (mut host, directory) = host();
    let mut status = host.state_watch();
    let token = host
        .start(
            plan(Some(7), Source::Real, false),
            options(Some(2)),
            hub.client(),
        )
        .unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    // Updates and this sleep need the same current-thread SDK executor that
    // would be blocked if recorder wait/SQLite ran on the async thread.
    socket
        .send(Message::Text(
            json!({"op":"data","id":1,"t":200,"values":[{"tag":NUMBER,"v":42,"q":"good","t":200}]})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    sleep(Duration::from_millis(20)).await;
    let terminal = wait_status(&mut status, |s| s.phase == RecordingPhase::FinishedUnjoined).await;
    assert_eq!(terminal.run.as_ref(), Some(&token));
    assert_eq!(
        terminal.progress.as_ref().unwrap().counters.committed_ticks,
        2
    );
    assert_eq!(
        terminal.progress.as_ref().unwrap().stop_reason,
        Some(RecordingStopReason::Completed)
    );
    assert!(matches!(host.take_store(), Err(RecordingHostError::Busy)));
    assert!(matches!(
        host.start(new_session("next"), options(None), hub.client()),
        Err(RecordingHostError::Busy)
    ));
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &identity()),
        Err(StoreError::Busy)
    ));
    let completion = host.join().await.unwrap();
    assert!(completion.start_error.is_none());
    assert_eq!(completion.source_shutdown, Ok(()));
    assert_eq!(
        completion
            .progress
            .as_ref()
            .unwrap()
            .tick_receipt
            .as_ref()
            .unwrap()
            .committed_through,
        2
    );
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
    assert!(Arc::ptr_eq(&completion, &host.join().await.unwrap()));
    assert_eq!(host.state().phase, RecordingPhase::Joined);
    closed(&mut socket).await;
    let store = host.take_store().unwrap();
    assert_eq!(host.state().phase, RecordingPhase::NoStore);
    assert!(matches!(
        host.start(new_session("next"), options(None), hub.client()),
        Err(RecordingHostError::NoStore)
    ));
    let evidence = store.session_evidence("recording").unwrap().unwrap();
    let start = evidence.start.at_ms;
    let raw=store.reader().unwrap().query_raw(&json!({"version":1,"kind":"query","requestId":"host-raw","seriesIds":["series-0"],"fromMs":start,"toMs":start+2001,"mode":"raw","maxPointsPerSeries":3}),&control()).unwrap();
    let values = raw["series"][0]["raw"].as_array().unwrap();
    assert_eq!(values.len(), 2);
    assert_eq!(values[1]["value"], 42.0);
    assert_eq!(values[1]["sourceTimeMs"], 200);
    drop(store);
    drop(reopen_unowned(&directory));
}

#[tokio::test]
async fn cancelled_join_keeps_owner_busy_then_allows_explicit_new_session() {
    let hub = Hub::new().await;
    let (mut host, _directory) = host();
    let mut status = host.state_watch();
    let old = host
        .start(new_session("first"), options(None), hub.client())
        .unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    let old_frame = wait_status(&mut status, |s| {
        s.progress
            .as_ref()
            .is_some_and(|p| p.counters.committed_ticks >= 1)
    })
    .await;
    assert!(timeout(Duration::from_millis(20), host.join())
        .await
        .is_err());
    assert!(matches!(host.take_store(), Err(RecordingHostError::Busy)));
    assert!(matches!(
        host.start(new_session("second"), options(None), hub.client()),
        Err(RecordingHostError::Busy)
    ));
    host.request_stop();
    let stopped = host.join().await.unwrap();
    assert_eq!(stopped.run, old);
    assert!(host.state().stop_requested);
    assert!(matches!(
        stopped
            .report
            .as_ref()
            .unwrap()
            .terminal
            .as_ref()
            .unwrap()
            .cause,
        StopCause::Cancelled
    ));
    closed(&mut socket).await;
    let mut resumed_options = options(Some(1));
    resumed_options.clock_epoch = "host-epoch-next".into();
    let new = host
        .start(new_session("second"), resumed_options, hub.client())
        .unwrap();
    assert_ne!(new, old);
    assert_eq!(old_frame.run.as_ref(), Some(&old));
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    let completed = host.join().await.unwrap();
    assert_eq!(completed.run, new);
    closed(&mut socket).await;
    let store = host.take_store().unwrap();
    assert!(store.session_status("first").unwrap().is_some());
    assert!(store.session_status("second").unwrap().is_some());
}

#[tokio::test]
async fn static_rejections_do_not_start_sdk_or_change_store() {
    let hub = Hub::new().await;
    let (mut host, _directory) = host();
    for change in 0..4 {
        let mut config = options(None);
        match change {
            0 => config.slot_count = Some(0),
            1 => config.plan.revision = 0,
            2 => config.max_clock_skew_ms = u64::MAX,
            _ => config.clock_epoch = "invalid epoch".into(),
        }
        assert!(host
            .start(plan(Some(7), Source::Real, false), config, hub.client())
            .is_err());
        assert_eq!(host.state().phase, RecordingPhase::Idle);
    }
    assert!(timeout(Duration::from_millis(50), hub.listener.accept())
        .await
        .is_err());
    let store = host.take_store().unwrap();
    assert!(store.session_status("recording").unwrap().is_none());
}

#[test]
fn no_runtime_is_a_typed_error_and_preserves_writer() {
    let (mut host, _directory) = host();
    let client = RestClient::new(
        Endpoint::new("http://127.0.0.1:1").unwrap(),
        SecretApiKey::new(KEY.into()).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        host.start(plan(Some(7), Source::Real, false), options(None), client),
        Err(RecordingHostError::NoRuntime)
    ));
    assert!(host.take_store().is_ok());
}

#[tokio::test]
async fn startup_store_failure_still_shuts_down_sdk_and_returns_writer() {
    let hub = Hub::new().await;
    let (mut host, _directory) = host();
    let mut store = host.take_store().unwrap();
    store
        .begin_session(new_session("existing").session().clone())
        .unwrap();
    let mut host = RecordingHost::new(store);
    host.start(new_session("new"), options(None), hub.client())
        .unwrap();
    let completion = host.join().await.unwrap();
    assert!(matches!(
        completion.start_error,
        Some(RecorderStartError::Store(_))
    ));
    assert!(completion.report.is_none());
    assert_eq!(completion.source_shutdown, Ok(()));
    assert!(host
        .take_store()
        .unwrap()
        .session_status("existing")
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn sdk_unauthorized_is_terminal_and_shutdown_failure_remains_visible() {
    let hub = Hub::new().await;
    let (mut host, _directory) = host();
    host.start(
        plan(Some(7), Source::Real, false),
        options(None),
        hub.client(),
    )
    .unwrap();
    let (mut stream, _) = timeout(Duration::from_secs(3), hub.listener.accept())
        .await
        .unwrap()
        .unwrap();
    request(&mut stream).await;
    reply(&mut stream, 401, &json!({"error":"test"})).await;
    let completion = timeout(Duration::from_secs(3), host.join())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(completion.source_shutdown, Err(ErrorKind::Unauthorized));
    assert!(matches!(
        completion
            .report
            .as_ref()
            .unwrap()
            .terminal
            .as_ref()
            .unwrap()
            .cause,
        StopCause::Source(_)
    ));
    assert_eq!(
        host.state().source_shutdown,
        Some(Err(ErrorKind::Unauthorized))
    );
}

#[tokio::test]
async fn dropping_host_requests_stop_and_worker_eventually_releases_writer() {
    let hub = Hub::new().await;
    let (mut host, directory) = host();
    let mut status = host.state_watch();
    host.start(
        plan(Some(7), Source::Real, false),
        options(None),
        hub.client(),
    )
    .unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    wait_status(&mut status, |s| s.progress.is_some()).await;
    drop(host);
    wait_status(&mut status, |s| s.phase == RecordingPhase::FinishedUnjoined).await;
    closed(&mut socket).await;
    // Publication precedes the final return/drop, so fixture-only Busy retry
    // waits for ownership release. Production locks are never relaxed.
    drop(reopen_unowned(&directory));
}

#[path = "support/managed_recording.rs"]
mod managed_support;
fn prepare_managed(
    store: &mut SqliteStore,
    plan: &SdkRecorderPlan,
    slots: Option<u64>,
) -> (
    RecordingOptions,
    scada_historian::recorder::ManagedRecorderStart,
) {
    let (plan, binding) = managed_support::apply(store, plan.session());
    let mut opts = options(slots);
    opts.plan = plan;
    opts.clock_epoch = "managed-epoch".into();
    (opts, binding)
}
#[tokio::test]
async fn managed_host_binds_sdk_samples_to_atomic_activation_and_keeps_executor_live() {
    let hub = Hub::new().await;
    let (mut host, _directory) = host();
    let sdk_plan = plan(Some(7), Source::Real, false);
    let mut store = host.take_store().unwrap();
    let (options, binding) = prepare_managed(&mut store, &sdk_plan, Some(2));
    let mut host = RecordingHost::new(store);
    let mut states = host.state_watch();
    host.start_managed(sdk_plan, options, binding, control(), hub.client())
        .unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    socket
        .send(Message::Text(
            json!({"op":"data","id":1,"t":200,"values":[{"tag":NUMBER,"v":42,"q":"good","t":200}]})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let before = std::time::Instant::now();
    sleep(Duration::from_millis(250)).await;
    assert!(
        before.elapsed() < Duration::from_secs(1),
        "SDK executor blocked by synchronous recorder"
    );
    wait_status(&mut states, |s| s.phase == RecordingPhase::FinishedUnjoined).await;
    assert!(matches!(host.take_store(), Err(RecordingHostError::Busy)));
    let completion = host.join().await.unwrap();
    assert_eq!(
        completion.report.as_ref().unwrap().counters.committed_ticks,
        2
    );
    assert!(completion.start_error.is_none());
    assert_eq!(completion.source_shutdown, Ok(()));
    let receipt = completion.activation_receipt.as_ref().unwrap();
    assert_eq!(receipt.activation_id, "managed-first");
    assert_eq!(receipt.spec.members.len(), 1);
    let mut store = host.take_store().unwrap();
    let current = store
        .recording_activation("managed-first", &control())
        .unwrap()
        .unwrap();
    assert_eq!(&current.receipt, receipt);
    assert!(current.session.committed_through >= 1);
    let query = json!({"version":1,"kind":"query","requestId":"managed-read","seriesIds":["series-0"],"fromMs":receipt.start.at_ms,"toMs":receipt.start.at_ms+10000,"mode":"raw","maxPointsPerSeries":100});
    let mut reader = store.reader().unwrap();
    let raw = reader.query_raw(&query, &control()).unwrap();
    assert!(!raw["series"][0]["raw"].as_array().unwrap().is_empty());
    assert_eq!(raw["series"][0]["raw"][1]["value"], 42.0);
    assert_eq!(raw["series"][0]["raw"][1]["sourceTimeMs"], 200);
    let mut minmax = query;
    minmax["mode"] = json!("minmax");
    assert_eq!(
        reader.query_minmax(&minmax, &control()).unwrap()["status"],
        "ready"
    );
}
#[tokio::test]
async fn managed_binding_failure_shuts_down_sdk_and_does_not_create_activation() {
    let hub = Hub::new().await;
    let (mut host, _directory) = host();
    let sdk_plan = plan(Some(7), Source::Real, false);
    let mut store = host.take_store().unwrap();
    let (mut managed_options, binding) = prepare_managed(&mut store, &sdk_plan, Some(2));
    managed_options.plan.revision = 2;
    let mut host = RecordingHost::new(store);
    host.start_managed(sdk_plan, managed_options, binding, control(), hub.client())
        .unwrap();
    let completion = timeout(Duration::from_secs(5), host.join())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        completion.start_error,
        Some(RecorderStartError::ManagedBindingMismatch)
    ));
    assert!(completion.activation_receipt.is_none());
    assert!(completion.report.is_none());
    assert_eq!(completion.source_shutdown, Ok(()));
    assert!(matches!(
        host.start_managed(
            new_session("retry"),
            options(Some(1)),
            scada_historian::recorder::ManagedRecorderStart {
                activation_id: "retry".into(),
                expected_applied_revision: 1,
                expected_mapping_revision: 1,
                expected_retention_applied_revision: 1
            },
            control(),
            hub.client()
        ),
        Err(RecordingHostError::UncleanPause)
    ));
    let mut store = host.take_store().unwrap();
    assert!(store
        .recording_activation_state(&control())
        .unwrap()
        .latest
        .is_none());
}
#[tokio::test]
async fn supplied_managed_cancellation_token_stops_run_and_preserves_receipt() {
    let hub = Hub::new().await;
    let (mut host, _directory) = host();
    let sdk_plan = plan(Some(7), Source::Real, false);
    let mut store = host.take_store().unwrap();
    let (options, binding) = prepare_managed(&mut store, &sdk_plan, None);
    let mut host = RecordingHost::new(store);
    let mut status = host.state_watch();
    let ctl = control();
    let cancel = ctl.cancellation.clone();
    host.start_managed(sdk_plan, options, binding, ctl, hub.client())
        .unwrap();
    let _socket = hub.serve(false, Some(7), "real", 3).await;
    wait_status(&mut status, |s| s.phase == RecordingPhase::Running).await;
    cancel.cancel();
    let completion = timeout(Duration::from_secs(5), host.join())
        .await
        .unwrap()
        .unwrap();
    assert!(completion.activation_receipt.is_some());
    assert_eq!(completion.source_shutdown, Ok(()));
    assert!(matches!(
        completion
            .report
            .as_ref()
            .unwrap()
            .terminal
            .as_ref()
            .unwrap()
            .cause,
        StopCause::Cancelled
    ));
}

#[tokio::test]
async fn managed_join_cancellation_keeps_owner_busy_then_resumes_with_fresh_activation() {
    let hub = Hub::new().await;
    let (mut host, _directory) = host();
    let sdk_plan = plan(Some(7), Source::Real, false);
    let mut store = host.take_store().unwrap();
    let (opts, binding) = prepare_managed(&mut store, &sdk_plan, None);
    let mut host = RecordingHost::new(store);
    let mut states = host.state_watch();
    host.start_managed(
        sdk_plan,
        opts.clone(),
        binding.clone(),
        control(),
        hub.client(),
    )
    .unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    wait_status(&mut states, |s| {
        s.progress
            .as_ref()
            .is_some_and(|p| p.counters.committed_ticks >= 1)
    })
    .await;
    assert!(timeout(Duration::from_millis(20), host.join())
        .await
        .is_err());
    assert!(matches!(host.take_store(), Err(RecordingHostError::Busy)));
    assert!(matches!(
        host.start_managed(
            new_session("second"),
            opts.clone(),
            binding.clone(),
            control(),
            hub.client()
        ),
        Err(RecordingHostError::Busy)
    ));
    host.request_stop();
    let first = host.join().await.unwrap();
    let first_receipt = first.activation_receipt.as_ref().unwrap().clone();
    closed(&mut socket).await;
    assert!(matches!(
        first
            .report
            .as_ref()
            .unwrap()
            .terminal
            .as_ref()
            .unwrap()
            .cleanup,
        scada_historian::recorder::CleanupOutcome::Closed(_)
    ));
    let mut next_opts = opts.clone();
    next_opts.clock_epoch = "second-epoch".into();
    next_opts.slot_count = Some(1);
    assert!(matches!(
        host.start_managed(
            new_session("recording"),
            next_opts.clone(),
            binding.clone(),
            control(),
            hub.client()
        ),
        Err(RecordingHostError::SessionReuse)
    ));
    assert!(matches!(
        host.start_managed(
            new_session("second"),
            opts,
            binding.clone(),
            control(),
            hub.client()
        ),
        Err(RecordingHostError::ClockEpochReuse)
    ));
    let mut next_binding = binding;
    next_binding.activation_id = "managed-second".into();
    host.start_managed(
        new_session("second"),
        next_opts,
        next_binding,
        control(),
        hub.client(),
    )
    .unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    let second = timeout(Duration::from_secs(5), host.join())
        .await
        .unwrap()
        .unwrap();
    assert!(second.start_error.is_none());
    let second_receipt = second.activation_receipt.as_ref().unwrap();
    assert_eq!(second_receipt.sequence, 2);
    assert_eq!(second_receipt.spec.session_id, "second");
    closed(&mut socket).await;
    let mut store = host.take_store().unwrap();
    assert_eq!(
        store
            .recording_activation("managed-first", &control())
            .unwrap()
            .unwrap()
            .receipt,
        first_receipt
    );
}
#[tokio::test]
async fn activation_error_remains_unconfirmed_and_never_starts_capture() {
    let hub = Hub::new().await;
    let (mut host, _directory) = host();
    let sdk_plan = plan(Some(7), Source::Real, false);
    let mut store = host.take_store().unwrap();
    let (opts, binding) = prepare_managed(&mut store, &sdk_plan, None);
    store
        .begin_retention_job(
            scada_historian::store::retention::jobs::JobRequest {
                job_id: "active-job".into(),
                cutoff_ms: 1000,
                expected_cutoff_ms: None,
            },
            &control(),
        )
        .unwrap();
    let mut host = RecordingHost::new(store);
    host.start_managed(sdk_plan, opts, binding, control(), hub.client())
        .unwrap();
    let completion = timeout(Duration::from_secs(5), host.join())
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        completion.start_error,
        Some(RecorderStartError::ActivationUnconfirmed(StoreError::Busy))
    ));
    assert!(completion.activation_receipt.is_none());
    assert!(completion.report.is_none());
    assert_eq!(completion.source_shutdown, Ok(()));
    assert_eq!(
        host.state().start_error.as_deref(),
        Some("recording activation unconfirmed; recovery required")
    );
    let mut store = host.take_store().unwrap();
    assert!(store
        .recording_activation_state(&control())
        .unwrap()
        .latest
        .is_none());
    assert!(store
        .recovery_state(&control())
        .unwrap()
        .active_job
        .is_some());
}
#[tokio::test]
async fn managed_drop_cancels_sdk_and_reader_keeps_writer_lease_until_released() {
    let hub = Hub::new().await;
    let (mut host, directory) = host();
    let sdk_plan = plan(Some(7), Source::Real, false);
    let mut store = host.take_store().unwrap();
    let (opts, binding) = prepare_managed(&mut store, &sdk_plan, None);
    let reader = store.reader().unwrap();
    let mut host = RecordingHost::new(store);
    let mut states = host.state_watch();
    host.start_managed(sdk_plan, opts, binding, control(), hub.client())
        .unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    wait_status(&mut states, |s| s.phase == RecordingPhase::Running).await;
    drop(host);
    closed(&mut socket).await;
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &identity()),
        Err(StoreError::Busy)
    ));
    drop(reader);
    // Keep the Tokio executor available while SDK shutdown finishes on the worker.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut reopened = loop {
        match SqliteStore::open_existing(&directory.0, &identity()) {
            Err(StoreError::Busy) if std::time::Instant::now() < deadline => {
                sleep(Duration::from_millis(5)).await
            }
            result => break result.unwrap(),
        }
    };
    let latest = reopened
        .recording_activation_state(&control())
        .unwrap()
        .latest
        .unwrap();
    assert_eq!(latest.receipt.activation_id, "managed-first");
    assert_ne!(
        latest.session.state,
        scada_historian::store::SessionState::Active
    );
}

#[path = "recording_host/plan_turn.rs"]
mod plan_turn;

#[path = "recording_host/supervisor.rs"]
mod supervisor;

#[path = "recording_host/resume.rs"]
mod resume;

#[path = "recording_host/operations.rs"]
mod operations;
