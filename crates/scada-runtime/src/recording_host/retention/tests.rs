use super::*;
use crate::{
    recorder_source::{SdkBindingPin, SdkGenerationPin, SdkRecorderPlan},
    recording_host::{RecordingCompletion, RecordingRun},
};
use futures_util::FutureExt;
use scada_historian::{
    recorder::{RecorderCounters, RecorderReport, RecorderState, TerminalReport},
    store::{
        evidence::{ClockStamp, PlanRef, TimedStart},
        query::QueryError,
        retention::{
            clock_guard::{CutoffRule, SuspendReason},
            coordinator::CoordinatorError,
        },
        IdentityDescriptor, SessionSpec, Source, StoreError, StoreIdentity, ValueType,
    },
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
        store_id: "retention-host".into(),
        deployment_id: "test".into(),
    }
}
fn plan() -> SdkRecorderPlan {
    let catalog = crate::tests::catalog();
    let tag = &catalog.tags[0];
    SdkRecorderPlan::new(
        SessionSpec {
            session_id: "recording".into(),
            members: vec![IdentityDescriptor {
                series_id: "number".into(),
                hub_instance_id: "hub-a".into(),
                incarnation_id: "life-a".into(),
                external_name: tag.external_name.clone(),
                segment_id: "segment-a".into(),
                value_type: ValueType::Number,
                unit: tag.unit.clone(),
                period_ms: 1000,
                source: Source::Real,
            }],
        },
        SdkGenerationPin {
            catalog_revision: catalog.revision,
            run_id: catalog.run_id,
            collection_mode: catalog.collection_mode.clone(),
        },
        vec![SdkBindingPin {
            series_id: "number".into(),
            stable_id: tag.ids,
            tag_key: tag.tag_key.clone(),
            data_type: tag.data_type.clone(),
        }],
    )
    .unwrap()
}
fn clean_host() -> (RecordingHost, Directory) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let directory = Directory(std::env::temp_dir().join(format!(
        "scada-retention-host-unit-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )));
    let mut store = SqliteStore::create(&directory.0, identity()).unwrap();
    store
        .begin_timed_session(
            plan().session().clone(),
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
    let closed = store
        .close_timed_session(
            "recording",
            ClockStamp {
                clock_epoch: "record-epoch".into(),
                at_ms: 2000,
            },
        )
        .unwrap();
    let mut host = RecordingHost::new(store);
    let token = RecordingRun(Arc::new(()));
    host.completion = Some(Arc::new(RecordingCompletion {
        run: token.clone(),
        progress: None,
        report: Some(RecorderReport {
            state: RecorderState::Stopped,
            already_stopped: false,
            counters: RecorderCounters::default(),
            observation: None,
            tick_receipt: None,
            gap_receipt: None,
            terminal: Some(TerminalReport {
                cause: StopCause::Cancelled,
                cleanup: CleanupOutcome::Closed(closed),
            }),
        }),
        start_error: None,
        source_shutdown: Ok(()),
    }));
    host.status.send_modify(|s| {
        let s = Arc::make_mut(s);
        s.run = Some(token);
        s.phase = RecordingPhase::Joined;
        s.session_id = Some("recording".into());
    });
    host.last_clock_epoch = Some("record-epoch".into());
    (host, directory)
}
fn input(mono: u64) -> RetentionTurnInput {
    RetentionTurnInput {
        policy: RetentionClockPolicy {
            policy_id: "policy".into(),
            revision: 1,
            cutoff_rule: CutoffRule::Elapsed {
                retain_for_ms: 1000,
            },
            tolerance_ms: 10,
            max_observation_gap_ms: 1000,
            max_cutoff_advance_ms: 1000,
            initial_cutoff_ceiling_ms: Some(5000),
        },
        sample: ClockSample {
            clock_epoch: "retention-clock".into(),
            wall_time_ms: 3000 + mono as i64,
            monotonic_ms: mono,
            trusted: true,
        },
        candidate_cutoff_ms: None,
        intent: CoordinatorIntent::Observe,
    }
}
fn control() -> QueryControl {
    QueryControl::with_timeout(Duration::from_secs(5)).unwrap()
}
async fn turn(host: &mut RecordingHost, input: RetentionTurnInput) -> Arc<RetentionTurnCompletion> {
    host.start_retention_turn(input, control()).unwrap();
    host.join_retention_turn().await.unwrap()
}

#[tokio::test]
async fn owned_guard_advances_once_and_duplicate_or_policy_change_cannot_reset_it() {
    let (mut host, _directory) = clean_host();
    let first = turn(&mut host, input(0)).await;
    assert!(matches!(first.report.next_state, GuardState::Primed { .. }));
    let duplicate = turn(&mut host, input(0)).await;
    assert_eq!(duplicate.report.next_state, first.report.next_state);
    turn(&mut host, input(1)).await;
    assert!(matches!(
        host.retention_guard_state().guard_state,
        GuardState::Tracking { .. }
    ));
    let mut changed = input(2);
    changed.policy.tolerance_ms += 1;
    turn(&mut host, changed).await;
    assert!(matches!(
        host.retention_guard_state().guard_state,
        GuardState::Suspended {
            reason: SuspendReason::PolicyChanged
        }
    ));
    turn(&mut host, input(3)).await;
    assert!(host.retention_guard_state().rearm_required);
    let mut forbidden = input(4);
    forbidden.intent =
        CoordinatorIntent::Begin(scada_historian::store::retention::jobs::JobRequest {
            job_id: "forbidden".into(),
            cutoff_ms: 2000,
            expected_cutoff_ms: None,
        });
    assert!(matches!(
        host.start_retention_turn(forbidden, control()),
        Err(RecordingHostError::RetentionRearmRequired)
    ));
    host.rearm_retention().unwrap();
    assert_eq!(
        host.retention_guard_state().guard_state,
        GuardState::Unarmed
    );
    assert!(matches!(
        turn(&mut host, input(4)).await.report.next_state,
        GuardState::Primed { .. }
    ));
}

#[tokio::test]
async fn cancelled_operation_requires_rearm_and_fresh_discovery_before_resume() {
    let (mut host, _directory) = clean_host();
    let cancelled = control();
    cancelled.cancellation.cancel();
    host.start_retention_turn(input(0), cancelled).unwrap();
    let completion = host.join_retention_turn().await.unwrap();
    assert!(completion.report.outcome.is_err());
    let snapshot = host.retention_guard_state();
    assert!(snapshot.rearm_required && snapshot.job_pending);
    host.rearm_retention().unwrap();
    assert!(host.retention_guard_state().job_pending);
    turn(&mut host, input(1)).await;
    let snapshot = host.retention_guard_state();
    assert!(!snapshot.rearm_required && !snapshot.job_pending);
    assert!(matches!(snapshot.guard_state, GuardState::Primed { .. }));
}

#[tokio::test]
async fn invalid_input_retains_prior_state_and_success_does_not_clear_error_latch() {
    let (mut host, _directory) = clean_host();
    turn(&mut host, input(0)).await;
    turn(&mut host, input(1)).await;
    let before = host.retention_guard_state().guard_state;
    assert!(matches!(before, GuardState::Tracking { .. }));
    let mut invalid = input(1);
    invalid.policy.revision = 0;
    let failed = turn(&mut host, invalid).await;
    assert!(failed.report.rearm_required);
    assert_eq!(failed.report.next_state, before);
    turn(&mut host, input(2)).await;
    assert!(host.retention_guard_state().rearm_required);
}

fn controlled_turn(
    host: &mut RecordingHost,
) -> (
    std::sync::mpsc::SyncSender<()>,
    tokio::sync::oneshot::Receiver<()>,
) {
    let store = host.store.take().unwrap();
    let (send, receive) = std::sync::mpsc::sync_channel(0);
    let (entered, ready) = tokio::sync::oneshot::channel();
    let task = tokio::task::spawn_blocking(move || {
        let _ = entered.send(());
        receive.recv().unwrap();
        TurnResult {
            store,
            completion: RetentionTurnCompletion {
                run: RetentionTurnRun(Arc::new(())),
                report: CoordinatorReport {
                    next_state: GuardState::Suspended {
                        reason: SuspendReason::UntrustedClock,
                    },
                    assessment: None,
                    recovery: None,
                    rearm_required: false,
                    outcome: Err(CoordinatorError::Store(StoreError::Control(
                        QueryError::Cancelled,
                    ))),
                },
            },
        }
    });
    host.retention.running = Some(RetentionRunning {
        cancel: CancellationToken::default(),
        task,
    });
    host.status
        .send_modify(|s| Arc::make_mut(s).phase = RecordingPhase::Retaining);
    (send, ready)
}

#[tokio::test]
async fn retention_join_cancellation_preserves_writer_and_next_guard_state() {
    let (mut host, _directory) = clean_host();
    let (release, ready) = controlled_turn(&mut host);
    ready.await.unwrap();
    assert!(host.join_retention_turn().now_or_never().is_none());
    assert!(matches!(host.take_store(), Err(RecordingHostError::Busy)));
    assert!(matches!(
        host.start_retention_turn(input(0), control()),
        Err(RecordingHostError::Busy)
    ));
    assert!(matches!(
        host.rearm_retention(),
        Err(RecordingHostError::Busy)
    ));
    assert!(matches!(host.join().await, Err(RecordingHostError::Busy)));
    let cancellation = host.retention.running.as_ref().unwrap().cancel.clone();
    host.cancel_retention_turn();
    assert!(cancellation.is_cancelled());
    release.send(()).unwrap();
    let completion = host.join_retention_turn().await.unwrap();
    assert!(Arc::ptr_eq(
        &completion,
        &host.join_retention_turn().await.unwrap()
    ));
    assert!(matches!(
        host.retention_guard_state().guard_state,
        GuardState::Suspended { .. }
    ));
    assert!(host.retention_guard_state().rearm_required);
}

#[tokio::test]
async fn drop_keeps_lock_until_retention_worker_finishes() {
    let (mut host, directory) = clean_host();
    let (release, ready) = controlled_turn(&mut host);
    ready.await.unwrap();
    let cancellation = host.retention.running.as_ref().unwrap().cancel.clone();
    drop(host);
    assert!(cancellation.is_cancelled());
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
async fn retention_worker_panic_faults_the_host_without_releasing_a_reusable_store() {
    let (mut host, _directory) = clean_host();
    let store = host.store.take().unwrap();
    let task = tokio::task::spawn_blocking(move || {
        let _owned = store;
        panic!("retention worker test panic")
    });
    host.retention.running = Some(RetentionRunning {
        cancel: CancellationToken::default(),
        task,
    });
    assert!(matches!(
        host.join_retention_turn().await,
        Err(RecordingHostError::WorkerFailed)
    ));
    assert_eq!(host.state().phase, RecordingPhase::Faulted);
    assert!(matches!(
        host.take_store(),
        Err(RecordingHostError::WorkerFailed)
    ));
}

#[tokio::test]
async fn interrupted_or_failed_completion_is_never_promoted_to_clean_pause() {
    for change in 0..7 {
        let (mut host, _directory) = clean_host();
        let completion = Arc::get_mut(host.completion.as_mut().unwrap()).unwrap();
        match change {
            0 => {
                let terminal = completion
                    .report
                    .as_mut()
                    .unwrap()
                    .terminal
                    .as_mut()
                    .unwrap();
                let CleanupOutcome::Closed(status) = &terminal.cleanup else {
                    panic!("fixture")
                };
                terminal.cleanup = CleanupOutcome::Interrupted(status.clone());
            }
            1 => {
                completion
                    .report
                    .as_mut()
                    .unwrap()
                    .terminal
                    .as_mut()
                    .unwrap()
                    .cause = StopCause::Source(scada_historian::recorder::SourceError("test"))
            }
            2 => {
                completion
                    .report
                    .as_mut()
                    .unwrap()
                    .terminal
                    .as_mut()
                    .unwrap()
                    .cause = StopCause::Clock(scada_historian::recorder::ClockError::EpochChanged)
            }
            3 => {
                completion
                    .report
                    .as_mut()
                    .unwrap()
                    .terminal
                    .as_mut()
                    .unwrap()
                    .cleanup = CleanupOutcome::Failed(StoreError::NeedsReopen)
            }
            4 => {
                completion.start_error =
                    Some(scada_historian::recorder::RecorderStartError::InvalidConfig)
            }
            5 => completion.source_shutdown = Err(banto_tagclient::ErrorKind::Transport),
            _ => completion.report = None,
        }
        assert!(
            matches!(
                host.start_retention_turn(input(0), control()),
                Err(RecordingHostError::UncleanPause)
            ),
            "case {change}"
        );
        assert!(
            matches!(
                host.rearm_retention(),
                Err(RecordingHostError::UncleanPause)
            ),
            "case {change}"
        );
        assert!(host.take_store().is_ok());
    }
}
