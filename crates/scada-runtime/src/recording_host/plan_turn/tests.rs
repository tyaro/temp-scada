use super::*;
use crate::recording_host::retention::tests::{clean_host, control, identity, input, plan};
use futures_util::FutureExt;
use scada_historian::{
    recorder::{CleanupOutcome, StopCause},
    store::{
        query::QueryError,
        recording_plan::{RecordingMapping, RecordingMappingMember},
        StoreError,
    },
};
use serde_json::json;
use std::time::{Duration, Instant};

fn mapping(key: &str, previous: Option<u64>) -> RecordingPlanTurnIntent {
    RecordingPlanTurnIntent::RegisterMapping(RegisterMappingRequest {
        request_id: key.into(),
        expected_mapping_revision: previous,
        mapping: RecordingMapping {
            hub_ref: "hub".into(),
            hub_instance_id: "hub-a".into(),
            members: plan()
                .session()
                .members
                .iter()
                .enumerate()
                .map(|(n, identity)| RecordingMappingMember {
                    member_id: format!("member:{n}"),
                    identity: identity.clone(),
                })
                .collect(),
        },
    })
}
fn apply(key: &str, previous: Option<u64>) -> RecordingPlanTurnIntent {
    RecordingPlanTurnIntent::Apply(ApplyRecordingPlanRequest {
        request_id: key.into(),
        expected_applied_revision: previous,
        expected_mapping_revision: None,
        expected_retention_applied_revision: None,
        desired: json!({"version":1,"kind":"recordingPlan","planId":"desired","revision":1,"enabled":false,"group":{"groupId":"group","hubRef":"hub","periodMs":1000,"members":[{"memberId":"member:0","externalName":plan().session().members[0].external_name,"valueType":"number"}]}}),
    })
}
fn recording_run(host: &RecordingHost) -> RecordingRun {
    host.completion.as_ref().unwrap().run.clone()
}
async fn turn(
    host: &mut RecordingHost,
    intent: RecordingPlanTurnIntent,
) -> Arc<RecordingPlanTurnCompletion> {
    let recording = recording_run(host);
    let run = host
        .start_recording_plan_turn(&recording, intent, control())
        .unwrap();
    host.join_recording_plan_turn(&run).await.unwrap()
}
#[tokio::test]
async fn mapping_and_apply_are_separate_commits_and_keep_both_success_receipts() {
    let (mut host, _dir) = clean_host();
    let recording = recording_run(&host);
    let original = host.completion.clone().unwrap();
    let map = turn(&mut host, mapping("map", None)).await;
    assert_eq!(map.recording_run, recording);
    let Ok(RecordingPlanTurnReceipt::Mapping(map_receipt)) = &map.outcome else {
        panic!("mapping")
    };
    let state = host
        .store
        .as_mut()
        .unwrap()
        .recording_plan_state(&control())
        .unwrap();
    assert!(state.applied.is_none());
    assert_eq!(state.mapping.unwrap().receipt, *map_receipt);
    let applied = turn(&mut host, apply("apply", None)).await;
    let Ok(RecordingPlanTurnReceipt::Applied(receipt)) = &applied.outcome else {
        panic!("apply")
    };
    assert_eq!(receipt.commit_version, map_receipt.commit_version + 1);
    let guard = host.recording_plan_guard_state();
    assert!(!guard.recovery_required);
    assert_eq!(guard.last_mapping.as_ref().unwrap().run, map.run);
    assert_eq!(
        guard.last_mapping.as_ref().unwrap().recording_run,
        recording
    );
    assert_eq!(guard.last_applied.as_ref().unwrap().run, applied.run);
    assert_eq!(
        guard.last_mapping.as_ref().map(|s| s.receipt.clone()),
        Some(map_receipt.clone())
    );
    assert_eq!(
        guard.last_applied.as_ref().map(|s| s.receipt.clone()),
        Some(receipt.clone())
    );
    assert!(Arc::ptr_eq(&original, host.completion.as_ref().unwrap()));
    assert_eq!(host.last_clock_epoch.as_deref(), Some("record-epoch"));
    assert_eq!(host.state().phase, RecordingPhase::Joined);
    assert!(Arc::ptr_eq(
        &applied,
        &host.join_recording_plan_turn(&applied.run).await.unwrap()
    ));
    // Native old-request replay remains explicit, never implicitly applies/activates.
    let replay = turn(&mut host, mapping("map", None)).await;
    assert_eq!(
        replay.outcome.as_ref().unwrap(),
        &RecordingPlanTurnReceipt::Mapping(map_receipt.clone())
    );
    assert!(host
        .store
        .as_mut()
        .unwrap()
        .recording_activation_state(&control())
        .unwrap()
        .latest
        .is_none());
}
#[tokio::test]
async fn native_failure_keeps_prior_receipts_and_blocks_every_resume_or_management_path() {
    let (mut host, _dir) = clean_host();
    let map = turn(&mut host, mapping("map", None)).await;
    let applied = turn(&mut host, apply("apply", None)).await;
    let failure = turn(&mut host, apply("conflict", None)).await;
    assert!(matches!(failure.outcome, Err(StoreError::Conflict)));
    let guard = host.recording_plan_guard_state();
    assert!(guard.recovery_required);
    assert!(
        matches!(map.outcome, Ok(RecordingPlanTurnReceipt::Mapping(ref r)) if Some(r)==guard.last_mapping.as_ref().map(|s| s.receipt.clone()).as_ref())
    );
    assert!(
        matches!(applied.outcome, Ok(RecordingPlanTurnReceipt::Applied(ref r)) if Some(r)==guard.last_applied.as_ref().map(|s| s.receipt.clone()).as_ref())
    );
    let recording = recording_run(&host);
    assert!(matches!(
        host.start_recording_plan_turn(&recording, mapping("again", Some(1)), control()),
        Err(RecordingHostError::PlanRecoveryRequired)
    ));
    assert!(matches!(
        host.start_retention_turn(input(0), control()),
        Err(RecordingHostError::PlanRecoveryRequired)
    ));
    assert!(matches!(
        host.rearm_retention(),
        Err(RecordingHostError::PlanRecoveryRequired)
    ));
    // Gate rejection happens before SDK source creation.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = banto_tagclient::RestClient::new(
        banto_tagclient::Endpoint::new(format!("http://{}", listener.local_addr().unwrap()))
            .unwrap(),
        banto_tagclient::SecretApiKey::new("plan-turn-test-only-key".into()).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        host.start(
            plan(),
            super::super::RecordingOptions {
                plan: scada_historian::store::evidence::PlanRef {
                    plan_id: "new".into(),
                    revision: 1
                },
                slot_count: Some(1),
                max_clock_skew_ms: 1000,
                clock_epoch: "new".into()
            },
            client
        ),
        Err(RecordingHostError::PlanRecoveryRequired)
    ));
    let mut store = host.take_store().unwrap();
    assert_eq!(
        store
            .recording_plan_state(&control())
            .unwrap()
            .applied
            .unwrap()
            .receipt
            .applied_revision,
        1
    );
}
#[tokio::test]
async fn pure_invalid_requests_and_stale_recording_tokens_do_not_take_or_poison_writer() {
    let (mut host, _dir) = clean_host();
    let record = recording_run(&host);
    for kind in 0..4 {
        let mut intent = if kind == 0 {
            mapping("bad", None)
        } else {
            apply("bad", None)
        };
        match &mut intent {
            RecordingPlanTurnIntent::RegisterMapping(r) => r.mapping.members[0].member_id.clear(),
            RecordingPlanTurnIntent::Apply(r) => match kind {
                1 => r.desired["secret"] = json!("forbidden"),
                2 => r.expected_applied_revision = Some(0),
                _ => r.desired["group"]["periodMs"] = json!(99),
            },
        }
        assert!(matches!(
            host.start_recording_plan_turn(&record, intent, control()),
            Err(RecordingHostError::PlanRequest(_))
        ));
        assert!(!host.recording_plan_guard_state().recovery_required);
        assert!(host.store.is_some());
        assert_eq!(host.state().phase, RecordingPhase::Joined);
    }
    assert!(matches!(
        host.start_recording_plan_turn(
            &RecordingRun(Arc::new(())),
            mapping("map", None),
            control()
        ),
        Err(RecordingHostError::RecordingRunMismatch)
    ));
    assert!(host.plan_turn.running.is_none());
    assert!(turn(&mut host, mapping("map", None)).await.outcome.is_ok());
}
#[tokio::test]
async fn every_unclean_pause_and_existing_retention_latch_stays_closed() {
    for kind in 0..11 {
        let (mut host, _dir) = clean_host();
        let record = recording_run(&host);
        match kind {
            0 => host.completion = None,
            1 => {
                Arc::get_mut(host.completion.as_mut().unwrap())
                    .unwrap()
                    .start_error =
                    Some(scada_historian::recorder::RecorderStartError::InvalidConfig)
            }
            2 => {
                Arc::get_mut(host.completion.as_mut().unwrap())
                    .unwrap()
                    .source_shutdown = Err(banto_tagclient::ErrorKind::Transport)
            }
            3 => {
                Arc::get_mut(host.completion.as_mut().unwrap())
                    .unwrap()
                    .report
                    .as_mut()
                    .unwrap()
                    .terminal
                    .as_mut()
                    .unwrap()
                    .cause = StopCause::Clock(scada_historian::recorder::ClockError::EpochChanged)
            }
            4 => {
                Arc::get_mut(host.completion.as_mut().unwrap())
                    .unwrap()
                    .report
                    .as_mut()
                    .unwrap()
                    .terminal
                    .as_mut()
                    .unwrap()
                    .cleanup = CleanupOutcome::Failed(StoreError::NeedsReopen)
            }
            5 => host.retention.job_pending = true,
            6 => host.retention.rearm_required = true,
            7 => {
                host.store.take();
            }
            8 => {
                host.status
                    .send_modify(|s| Arc::make_mut(s).phase = RecordingPhase::Faulted);
            }
            9 => {
                Arc::get_mut(host.completion.as_mut().unwrap())
                    .unwrap()
                    .report = None
            }
            _ => {
                let c = Arc::get_mut(host.completion.as_mut().unwrap()).unwrap();
                let terminal = c.report.as_mut().unwrap().terminal.as_mut().unwrap();
                let CleanupOutcome::Closed(status) = &terminal.cleanup else {
                    panic!()
                };
                terminal.cleanup = CleanupOutcome::Interrupted(status.clone());
            }
        }
        let result = host.start_recording_plan_turn(&record, mapping("map", None), control());
        assert!(
            matches!((kind,result), (0..=4|9..=10,Err(RecordingHostError::UncleanPause))|(5,Err(RecordingHostError::RetentionPending))|(6,Err(RecordingHostError::RetentionRearmRequired))|(7,Err(RecordingHostError::NoStore))|(8,Err(RecordingHostError::WorkerFailed))),
            "case {kind}"
        );
        assert!(!host.recording_plan_guard_state().recovery_required);
    }
}
#[test]
fn queued_turn_keeps_original_deadline_token_and_single_writer_slot() {
    for expire in [false, true] {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let (mut host, _dir) = clean_host();
            let recording = recording_run(&host);
            let (release, receive) = std::sync::mpsc::sync_channel(0);
            let (entered, ready) = tokio::sync::oneshot::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                entered.send(()).unwrap();
                receive.recv().unwrap();
            });
            ready.await.unwrap();
            let mut c = control();
            if expire {
                c.deadline = Instant::now() + Duration::from_millis(30);
            }
            let cancel = c.cancellation.clone();
            let turn = host
                .start_recording_plan_turn(&recording, mapping("map", None), c)
                .unwrap();
            let wrong = RecordingPlanTurnRun(Arc::new(()));
            assert!(matches!(
                host.cancel_recording_plan_turn(&wrong),
                Err(RecordingHostError::PlanTurnMismatch)
            ));
            assert!(!cancel.is_cancelled());
            assert!(matches!(
                host.join_recording_plan_turn(&wrong).await,
                Err(RecordingHostError::PlanTurnMismatch)
            ));
            assert!(host
                .join_recording_plan_turn(&turn)
                .now_or_never()
                .is_none());
            assert!(matches!(host.take_store(), Err(RecordingHostError::Busy)));
            assert!(matches!(host.join().await, Err(RecordingHostError::Busy)));
            assert!(matches!(
                host.join_retention_turn().await,
                Err(RecordingHostError::Busy)
            ));
            assert!(matches!(
                host.start_retention_turn(input(0), control()),
                Err(RecordingHostError::Busy)
            ));
            assert!(matches!(
                host.rearm_retention(),
                Err(RecordingHostError::Busy)
            ));
            assert!(matches!(
                host.start_recording_plan_turn(&recording, apply("apply", None), control()),
                Err(RecordingHostError::Busy)
            ));
            if expire {
                tokio::time::sleep(Duration::from_millis(40)).await;
            } else {
                host.cancel_recording_plan_turn(&turn).unwrap();
                assert!(cancel.is_cancelled());
            }
            release.send(()).unwrap();
            blocker.await.unwrap();
            let done = host.join_recording_plan_turn(&turn).await.unwrap();
            assert!(matches!(
                (&done.outcome, expire),
                (Err(StoreError::Control(QueryError::Deadline)), true)
                    | (Err(StoreError::Control(QueryError::Cancelled)), false)
            ));
            assert!(host.recording_plan_guard_state().recovery_required);
            assert!(host
                .store
                .as_mut()
                .unwrap()
                .recording_mapping_receipt("map", &control())
                .unwrap()
                .is_none());
        });
    }
}

#[test]
fn missing_runtime_rejects_without_changing_owner_or_recovery_state() {
    let (mut host, _dir) = clean_host();
    let recording = recording_run(&host);
    assert!(matches!(
        host.start_recording_plan_turn(&recording, mapping("map", None), control()),
        Err(RecordingHostError::NoRuntime)
    ));
    assert!(host.store.is_some());
    assert!(host.plan_turn.running.is_none());
    assert!(!host.recording_plan_guard_state().recovery_required);
}
#[tokio::test]
async fn successful_commit_survives_late_cancellation_and_old_turn_cannot_cancel_new_turn() {
    let (mut host, _dir) = clean_host();
    let recording = recording_run(&host);
    let ctl = control();
    let cancel = ctl.cancellation.clone();
    let first = host
        .start_plan_turn_with(&recording, mapping("map", None), ctl, |intent, store, c| {
            let result = intent.execute(store, c);
            c.cancellation.cancel();
            result
        })
        .unwrap();
    let first_done = host.join_recording_plan_turn(&first).await.unwrap();
    assert!(cancel.is_cancelled());
    assert!(first_done.outcome.is_ok());
    assert!(!host.recording_plan_guard_state().recovery_required);
    host.cancel_recording_plan_turn(&first).unwrap();
    let (release, receive) = std::sync::mpsc::sync_channel(0);
    let (entered, ready) = tokio::sync::oneshot::channel();
    let ctl = control();
    let cancel = ctl.cancellation.clone();
    let second = host
        .start_plan_turn_with(
            &recording,
            apply("apply", None),
            ctl,
            move |intent, store, c| {
                entered.send(()).unwrap();
                receive.recv().unwrap();
                intent.execute(store, c)
            },
        )
        .unwrap();
    ready.await.unwrap();
    assert!(matches!(
        host.cancel_recording_plan_turn(&first),
        Err(RecordingHostError::PlanTurnMismatch)
    ));
    assert!(!cancel.is_cancelled());
    assert!(matches!(
        host.join_recording_plan_turn(&first).await,
        Err(RecordingHostError::PlanTurnMismatch)
    ));
    release.send(()).unwrap();
    assert!(host
        .join_recording_plan_turn(&second)
        .await
        .unwrap()
        .outcome
        .is_ok());
    assert!(matches!(
        host.join_recording_plan_turn(&first).await,
        Err(RecordingHostError::PlanTurnMismatch)
    ));
}
#[tokio::test]
async fn committed_response_loss_preserves_mapping_success_and_exposes_receipt_for_explicit_recovery(
) {
    let (mut host, _dir) = clean_host();
    let mapping = turn(&mut host, mapping("map", None)).await;
    let recording = recording_run(&host);
    let turn = host
        .start_plan_turn_with(
            &recording,
            apply("apply", None),
            control(),
            |intent, store, c| {
                intent.execute(store, c)?;
                Err(StoreError::Invalid("response lost after commit"))
            },
        )
        .unwrap();
    let done = host.join_recording_plan_turn(&turn).await.unwrap();
    assert!(matches!(done.outcome, Err(StoreError::Invalid(_))));
    let state = host.recording_plan_guard_state();
    assert!(state.recovery_required);
    assert_eq!(state.last_mapping.as_ref().unwrap().run, mapping.run);
    assert!(state.last_applied.is_none()); // no successful response to invent
    let mut store = host.take_store().unwrap();
    let receipt = store
        .recording_plan_receipt("apply", &control())
        .unwrap()
        .unwrap();
    assert_eq!(receipt.applied_revision, 1);
    assert_eq!(
        store
            .recording_plan_state(&control())
            .unwrap()
            .applied
            .unwrap()
            .receipt,
        receipt
    );
}
#[tokio::test]
async fn original_storage_failure_stays_in_completion_and_out_of_watch() {
    let (mut host, _dir) = clean_host();
    let recording = recording_run(&host);
    let turn = host
        .start_plan_turn_with(&recording, mapping("map", None), control(), |_, _, c| {
            c.cancellation.cancel();
            Err(StoreError::Io(std::io::Error::other(
                "private-path-and-driver-detail",
            )))
        })
        .unwrap();
    let done = host.join_recording_plan_turn(&turn).await.unwrap();
    assert!(matches!(done.outcome, Err(StoreError::Io(_))));
    assert!(host.recording_plan_guard_state().recovery_required);
    assert!(!format!("{:?}", host.state()).contains("private"));
    assert!(host.take_store().is_ok());
}
#[tokio::test]
async fn dropped_or_panicking_turn_never_releases_a_live_worker_or_recovers_a_fake_store() {
    for panic in [false, true] {
        let (mut host, dir) = clean_host();
        let recording = recording_run(&host);
        let reader = host.store.as_ref().unwrap().reader().unwrap();
        let (release, receive) = std::sync::mpsc::sync_channel(0);
        let (entered, ready) = tokio::sync::oneshot::channel();
        let ctl = control();
        let cancel = ctl.cancellation.clone();
        let turn = host
            .start_plan_turn_with(
                &recording,
                mapping("map", None),
                ctl,
                move |intent, store, c| {
                    entered.send(()).unwrap();
                    receive.recv().unwrap();
                    assert!(panic || c.cancellation.is_cancelled());
                    if panic {
                        panic!("plan turn test panic");
                    }
                    intent.execute(store, c)
                },
            )
            .unwrap();
        ready.await.unwrap();
        if panic {
            release.send(()).unwrap();
            assert!(matches!(
                host.join_recording_plan_turn(&turn).await,
                Err(RecordingHostError::WorkerFailed)
            ));
            assert_eq!(host.state().phase, RecordingPhase::Faulted);
            assert!(host.recording_plan_guard_state().recovery_required);
            assert!(matches!(
                host.take_store(),
                Err(RecordingHostError::WorkerFailed)
            ));
            drop(host);
        } else {
            assert!(host
                .join_recording_plan_turn(&turn)
                .now_or_never()
                .is_none());
            drop(host);
            assert!(cancel.is_cancelled());
            assert!(matches!(
                SqliteStore::open_existing(&dir.0, &identity()),
                Err(StoreError::Busy)
            ));
            release.send(()).unwrap();
        }
        assert!(matches!(
            SqliteStore::open_existing(&dir.0, &identity()),
            Err(StoreError::Busy)
        ));
        drop(reader);
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match SqliteStore::open_existing(&dir.0, &identity()) {
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
}

#[tokio::test]
async fn retention_and_finished_unjoined_plan_work_share_the_same_exclusive_slot() {
    let (mut host, _dir) = clean_host();
    let recording = recording_run(&host);
    let turn = host
        .start_recording_plan_turn(&recording, mapping("map", None), control())
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while !host.plan_turn.running.as_ref().unwrap().task.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(host.state().phase, RecordingPhase::ManagingPlan);
    assert!(matches!(
        host.start_retention_turn(input(0), control()),
        Err(RecordingHostError::Busy)
    ));
    assert!(matches!(host.take_store(), Err(RecordingHostError::Busy)));
    assert!(host
        .join_recording_plan_turn(&turn)
        .await
        .unwrap()
        .outcome
        .is_ok());
    host.start_retention_turn(input(0), control()).unwrap();
    assert!(matches!(
        host.start_recording_plan_turn(&recording, apply("apply", None), control()),
        Err(RecordingHostError::Busy)
    ));
    assert!(matches!(
        host.join_recording_plan_turn(&turn).await,
        Err(RecordingHostError::Busy)
    ));
    host.join_retention_turn().await.unwrap();
}
#[tokio::test]
async fn original_vm_row_and_output_limits_are_not_reset_by_worker_start() {
    for kind in 0..3 {
        let (mut host, _dir) = clean_host();
        let recording = recording_run(&host);
        let mut c = control();
        match kind {
            0 => c.limits.max_vm_steps = 1000,
            1 => c.limits.max_decoded_rows = 1,
            _ => c.limits.max_output_bytes = 1,
        }
        let turn = host
            .start_recording_plan_turn(&recording, mapping("map", None), c)
            .unwrap();
        let result = host.join_recording_plan_turn(&turn).await.unwrap();
        assert!(
            matches!(result.outcome, Err(StoreError::Control(_))),
            "case {kind}"
        );
        assert!(host.recording_plan_guard_state().recovery_required);
        assert!(host
            .store
            .as_mut()
            .unwrap()
            .recording_plan_state(&control())
            .unwrap()
            .mapping
            .is_none());
    }
}
