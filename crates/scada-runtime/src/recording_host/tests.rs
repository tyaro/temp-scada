use super::*;
use futures_util::FutureExt;
use scada_historian::{
    recorder::{
        CleanupOutcome, RecorderCounters, RecorderReport, RecorderState, StopCause, TerminalReport,
    },
    store::{CommitReceipt, StoreError, StoreIdentity},
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn identity() -> StoreIdentity {
    StoreIdentity {
        store_id: "unit-host".into(),
        deployment_id: "unit-deployment".into(),
    }
}
fn host() -> (RecordingHost, Directory) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let directory = Directory(std::env::temp_dir().join(format!(
        "scada-host-unit-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    (
        RecordingHost::new(SqliteStore::create(&directory.0, identity()).unwrap()),
        directory,
    )
}
fn report() -> RecorderReport {
    RecorderReport {
        state: RecorderState::Running,
        already_stopped: false,
        counters: RecorderCounters {
            committed_ticks: 1,
            ..RecorderCounters::default()
        },
        observation: None,
        tick_receipt: Some(CommitReceipt {
            session_id: "recording".into(),
            committed_through: 1,
            commit_version: 2,
        }),
        gap_receipt: None,
        terminal: None,
    }
}

fn recording_plan() -> SdkRecorderPlan {
    let catalog = crate::tests::catalog();
    let tag = &catalog.tags[0];
    SdkRecorderPlan::new(
        scada_historian::store::SessionSpec {
            session_id: "recording".into(),
            members: vec![scada_historian::store::IdentityDescriptor {
                series_id: "number".into(),
                hub_instance_id: "hub-a".into(),
                incarnation_id: "life-a".into(),
                external_name: tag.external_name.clone(),
                segment_id: "segment-a".into(),
                value_type: scada_historian::store::ValueType::Number,
                unit: tag.unit.clone(),
                period_ms: 1000,
                source: scada_historian::store::Source::Real,
            }],
        },
        crate::recorder_source::SdkGenerationPin {
            catalog_revision: catalog.revision,
            run_id: catalog.run_id,
            collection_mode: catalog.collection_mode.clone(),
        },
        vec![crate::recorder_source::SdkBindingPin {
            series_id: "number".into(),
            stable_id: tag.ids,
            tag_key: tag.tag_key.clone(),
            data_type: tag.data_type.clone(),
        }],
    )
    .unwrap()
}

#[test]
fn stop_before_blocking_worker_starts_skips_database_session_creation() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        let (mut host, _directory) = host();
        let (release, receive) = std::sync::mpsc::sync_channel(0);
        let (entered, ready) = tokio::sync::oneshot::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            let _ = entered.send(());
            receive.recv().unwrap();
        });
        ready.await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = banto_tagclient::RestClient::new(
            banto_tagclient::Endpoint::new(format!("http://{}", listener.local_addr().unwrap()))
                .unwrap(),
            banto_tagclient::SecretApiKey::new("host-unit-test-only-key".into()).unwrap(),
        )
        .unwrap();
        host.start(
            recording_plan(),
            RecordingOptions {
                plan: scada_historian::store::evidence::PlanRef {
                    plan_id: "plan".into(),
                    revision: 1,
                },
                slot_count: None,
                max_clock_skew_ms: 1000,
                clock_epoch: "epoch".into(),
            },
            client,
        )
        .unwrap();
        host.request_stop();
        release.send(()).unwrap();
        blocker.await.unwrap();
        let completion = host.join().await.unwrap();
        assert!(completion.report.is_none());
        assert!(completion.start_error.is_none());
        assert_eq!(completion.source_shutdown, Ok(()));
        assert!(host.state().stop_requested);
        assert!(host
            .take_store()
            .unwrap()
            .session_status("recording")
            .unwrap()
            .is_none());
    });
}

#[test]
fn stop_phase_and_latest_receipt_survive_step_publication_and_old_runs_are_rejected() {
    let (mut host, _directory) = host();
    let token = RecordingRun(Arc::new(()));
    host.status.send_modify(|state| {
        let state = Arc::make_mut(state);
        state.run = Some(token.clone());
        state.phase = RecordingPhase::Stopping;
        state.stop_requested = true;
    });
    worker::publish_report(&host.status, &token, &report());
    assert_eq!(host.state().phase, RecordingPhase::Stopping);
    assert_eq!(
        host.state()
            .progress
            .as_ref()
            .unwrap()
            .tick_receipt
            .as_ref()
            .unwrap()
            .committed_through,
        1
    );
    let retained = host.state();
    worker::publish_report(&host.status, &RecordingRun(Arc::new(())), &report());
    assert!(Arc::ptr_eq(&retained, &host.state()));
    let mut terminal = report();
    terminal.state = RecorderState::Stopped;
    terminal.tick_receipt = None;
    terminal.terminal = Some(TerminalReport {
        cause: StopCause::Cancelled,
        cleanup: CleanupOutcome::Failed(StoreError::NeedsReopen),
    });
    worker::publish_report(&host.status, &token, &terminal);
    let progress = host.state().progress.clone().unwrap();
    assert_eq!(progress.tick_receipt.unwrap().committed_through, 1);
    assert_eq!(progress.stop_reason, Some(RecordingStopReason::Cancelled));
    assert!(host.take_store().is_ok());
}

#[test]
fn diagnostic_store_failure_never_contains_raw_paths_or_driver_messages() {
    let mut report = report();
    report.state = RecorderState::Stopped;
    report.terminal = Some(TerminalReport {
        cause: StopCause::Store(StoreError::Io(std::io::Error::other(
            "secret-path-and-driver-detail",
        ))),
        cleanup: CleanupOutcome::Failed(StoreError::Io(std::io::Error::other("second-secret"))),
    });
    let progress = RecordingProgress::from(&report);
    let text = format!("{progress:?}");
    assert!(!text.contains("secret"));
    assert_eq!(
        progress.stop_reason,
        Some(RecordingStopReason::Store(
            "Historian store: I/O failure".into()
        ))
    );
    assert!(matches!(
        progress.cleanup,
        Some(RecordingCleanup::Failed(_))
    ));
}

/// Hold an owned writer behind a deterministic gate to test cancellation and
/// Drop without depending on scheduler speed or a real filesystem stall.
fn controlled_worker(
    host: &mut RecordingHost,
) -> (
    std::sync::mpsc::SyncSender<()>,
    tokio::sync::oneshot::Receiver<()>,
) {
    let store = host.store.take().unwrap();
    let token = RecordingRun(Arc::new(()));
    host.status.send_modify(|state| {
        let state = Arc::make_mut(state);
        state.run = Some(token.clone());
        state.phase = RecordingPhase::Starting;
    });
    let (release, receive) = std::sync::mpsc::sync_channel(0);
    let (entered, ready) = tokio::sync::oneshot::channel();
    let task = tokio::task::spawn_blocking(move || {
        let _ = entered.send(());
        receive.recv().unwrap();
        worker::WorkerResult {
            store,
            completion: RecordingCompletion {
                run: token,
                progress: None,
                report: None,
                start_error: None,
                source_shutdown: Ok(()),
            },
        }
    });
    host.running = Some(Running {
        cancel: CancellationToken::default(),
        task,
    });
    (release, ready)
}

#[tokio::test]
async fn cancelling_join_retains_handle_and_no_writer_can_escape_before_completion() {
    let (mut host, directory) = host();
    let (release, ready) = controlled_worker(&mut host);
    ready.await.unwrap();
    assert!(host.join().now_or_never().is_none());
    assert!(matches!(host.take_store(), Err(RecordingHostError::Busy)));
    host.request_stop();
    assert_eq!(host.state().phase, RecordingPhase::Stopping);
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &identity()),
        Err(StoreError::Busy)
    ));
    release.send(()).unwrap();
    host.join().await.unwrap();
    assert_eq!(host.state().phase, RecordingPhase::Joined);
    assert!(host.take_store().is_ok());
}

#[tokio::test]
async fn dropped_host_does_not_release_writer_while_detached_worker_owns_it() {
    let (mut host, directory) = host();
    let (release, ready) = controlled_worker(&mut host);
    ready.await.unwrap();
    drop(host);
    assert!(matches!(
        SqliteStore::open_existing(&directory.0, &identity()),
        Err(StoreError::Busy)
    ));
    release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match SqliteStore::open_existing(&directory.0, &identity()) {
            Err(StoreError::Busy) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(5)).await
            }
            result => {
                drop(result.unwrap());
                break;
            }
        }
    }
}

#[tokio::test]
async fn worker_panic_faults_host_and_requires_external_store_reopen() {
    let (mut host, directory) = host();
    let mut store = host.store.take().unwrap();
    store
        .begin_session(recording_plan().session().clone())
        .unwrap();
    let task = tokio::task::spawn_blocking(move || {
        let _owned = store;
        panic!("test worker panic")
    });
    host.running = Some(Running {
        cancel: CancellationToken::default(),
        task,
    });
    assert!(matches!(
        host.join().await,
        Err(RecordingHostError::WorkerFailed)
    ));
    assert_eq!(host.state().phase, RecordingPhase::Faulted);
    assert!(matches!(
        host.join().await,
        Err(RecordingHostError::WorkerFailed)
    ));
    assert!(matches!(
        host.take_store(),
        Err(RecordingHostError::WorkerFailed)
    ));
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match SqliteStore::open_existing(&directory.0, &identity()) {
            Err(StoreError::Busy) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(5)).await
            }
            result => {
                let reopened = result.unwrap();
                assert_eq!(
                    reopened.session_status("recording").unwrap().unwrap().state,
                    scada_historian::store::SessionState::Interrupted
                );
                break;
            }
        }
    }
}
