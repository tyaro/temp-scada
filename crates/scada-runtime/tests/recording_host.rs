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
