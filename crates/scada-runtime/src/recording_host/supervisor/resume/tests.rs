use super::*;
use crate::recording_host::{
    retention::tests::{control, plan},
    supervisor::tests::setup,
};
use banto_tagclient::{resolve_bindings, BindingRequest, GenerationSnapshot};
use futures_util::FutureExt;
use std::time::{Duration, Instant};

fn ready() -> (
    RecordingSupervisor,
    crate::recording_host::retention::tests::Directory,
) {
    let (mut s, d) = setup();
    crate::recording_host::tests::managed_support::apply(
        s.host.store.as_mut().unwrap(),
        plan().session(),
    );
    (s, d)
}
fn generation() -> Arc<GenerationSnapshot> {
    let catalog = crate::tests::catalog();
    Arc::new(GenerationSnapshot {
        generation: 10,
        resolution: Arc::new(
            resolve_bindings(
                &[BindingRequest {
                    binding_key: "number".into(),
                    external_name: catalog.tags[0].external_name.clone(),
                }],
                &catalog.tags,
            )
            .unwrap(),
        ),
        catalog: Arc::new(catalog),
        values: Some(Arc::new(crate::tests::snapshot())),
    })
}
fn resolution() -> ResumeResolution {
    ResumeResolution {
        sdk_snapshot: generation(),
        session_id: "resume:session".into(),
        clock_epoch: "resume:clock".into(),
        activation_id: "resume:activation".into(),
        slot_count: Some(1),
        max_clock_skew_ms: 1000,
    }
}
async fn inspect(s: &mut RecordingSupervisor) -> ResumeInspectionRun {
    let r = s.start_resume_inspection(control()).unwrap();
    s.join_resume_inspection(&r).await.unwrap();
    r
}
fn client() -> RestClient {
    RestClient::new(
        banto_tagclient::Endpoint::new("http://127.0.0.1:9").unwrap(),
        banto_tagclient::SecretApiKey::new("resume-test-only-key".into()).unwrap(),
    )
    .unwrap()
}
#[tokio::test]
async fn prepare_is_pure_and_ticket_blocks_switches_until_explicit_discard() {
    let (mut s, _d) = ready();
    let r = inspect(&mut s).await;
    let before = s
        .host
        .store
        .as_mut()
        .unwrap()
        .recording_plan_state(&control())
        .unwrap()
        .snapshot_commit;
    let ticket = s.prepare_resume(&r, resolution()).unwrap();
    assert!(s.state().resume_prepared);
    assert!(matches!(
        s.start_resume_inspection(control()),
        Err(SupervisorError::Busy)
    ));
    assert!(matches!(
        s.start_preflight(super::super::tests::mapping("map:next", Some(1)), control()),
        Err(SupervisorError::Busy)
    ));
    assert!(matches!(
        s.start(
            plan(),
            RecordingOptions {
                plan: scada_historian::store::evidence::PlanRef {
                    plan_id: "test".into(),
                    revision: 1
                },
                slot_count: Some(1),
                max_clock_skew_ms: 1000,
                clock_epoch: "test".into()
            },
            client()
        ),
        Err(SupervisorError::Busy)
    ));
    assert_eq!(
        s.host
            .store
            .as_mut()
            .unwrap()
            .recording_plan_state(&control())
            .unwrap()
            .snapshot_commit,
        before
    );
    s.discard_resume(&ticket).unwrap();
    assert!(!s.state().resume_prepared);
    assert!(matches!(
        s.resume(&ticket, control(), client()),
        Err(SupervisorError::WrongResume)
    ));
}
#[tokio::test]
async fn diagnosis_succeeds_in_abnormal_and_latched_hosts_without_authorizing_resume() {
    for kind in 0..5 {
        let (mut s, _d) = ready();
        match kind {
            0 => {
                Arc::get_mut(s.host.completion.as_mut().unwrap())
                    .unwrap()
                    .source_shutdown = Err(banto_tagclient::ErrorKind::Transport)
            }
            1 => s.host.plan_turn.recovery_required = true,
            2 => s.host.retention.job_pending = true,
            3 => s.host.retention.rearm_required = true,
            _ => {
                s.host
                    .store
                    .as_mut()
                    .unwrap()
                    .begin_retention_job(
                        scada_historian::store::retention::jobs::JobRequest {
                            job_id: "job".into(),
                            cutoff_ms: 1000,
                            expected_cutoff_ms: None,
                        },
                        &control(),
                    )
                    .unwrap();
            }
        }
        let r = inspect(&mut s).await;
        assert!(s.resume.completion.as_ref().unwrap().outcome.is_ok());
        assert!(s.prepare_resume(&r, resolution()).is_err(), "case {kind}");
        assert!(s.resume.prepared.is_none());
        if kind == 1 {
            assert!(s.recording_plan_guard_state().recovery_required);
        }
        if kind == 2 {
            assert!(s.retention_guard_state().job_pending);
        }
        if kind == 3 {
            assert!(s.retention_guard_state().rearm_required);
        }
    }
}
#[tokio::test]
async fn new_preflight_invalidates_old_inspection_and_consumed_candidate_stays_consumed() {
    let (mut s, _d) = ready();
    let old = inspect(&mut s).await;
    let pf = s
        .start_preflight(super::super::tests::mapping("map:2", Some(1)), control())
        .unwrap();
    s.join_preflight(&pf).await.unwrap();
    assert!(matches!(
        s.prepare_resume(&old, resolution()),
        Err(SupervisorError::WrongInspection)
    ));
    assert!(matches!(
        s.start_resume_inspection(control()),
        Err(SupervisorError::Busy)
    ));
    s.request_pause(&pf).unwrap();
    s.join_pause(&pf).await.unwrap();
    let turn = s.execute_candidate(&pf, control()).unwrap();
    s.join_recording_plan_turn(&turn).await.unwrap();
    let r = inspect(&mut s).await;
    assert!(s.resume.completion.as_ref().unwrap().outcome.is_ok());
    assert!(matches!(
        s.execute_candidate(&pf, control()),
        Err(SupervisorError::CandidateConsumed)
    ));
    assert!(matches!(
        s.prepare_resume(&r, resolution()),
        Err(SupervisorError::ResumeBlocked(_))
    ));
}
#[test]
fn synchronous_resume_rejection_keeps_prepared_ticket_and_inspection() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (mut s, _d, r, ticket) = rt.block_on(async {
        let (mut s, d) = ready();
        let r = inspect(&mut s).await;
        let t = s.prepare_resume(&r, resolution()).unwrap();
        (s, d, r, t)
    });
    assert!(matches!(
        s.resume(&ticket, control(), client()),
        Err(SupervisorError::Host(RecordingHostError::NoRuntime))
    ));
    assert!(s.state().resume_prepared);
    assert!(s.inspection(&r).is_ok());
    s.discard_resume(&ticket).unwrap();
}
#[tokio::test]
async fn prepared_context_cannot_move_to_another_run_and_safety_recovery_remains_available() {
    let (mut s, _d) = ready();
    let r = inspect(&mut s).await;
    let t = s.prepare_resume(&r, resolution()).unwrap();
    let recording = s.host.state().run.clone().unwrap();
    s.request_stop_recording(&recording).unwrap();
    s.join_recording(&recording).await.unwrap();
    assert!(s.state().resume_prepared);
    let mut store = s.take_store().unwrap();
    assert_eq!(
        store
            .storage_diagnostics(&control())
            .unwrap()
            .live_reader_leases,
        0
    );
    assert!(matches!(
        s.resume(&t, control(), client()),
        Err(SupervisorError::WrongResume)
    ));
}
#[test]
fn inspection_queues_preserve_deadline_token_limits_and_shared_reader_exclusion() {
    for expire in [false, true] {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        rt.block_on(async {
            let (mut s, _d) = ready();
            let (release, receive) = std::sync::mpsc::sync_channel(0);
            let (entered, done) = tokio::sync::oneshot::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                entered.send(()).unwrap();
                receive.recv().unwrap();
            });
            done.await.unwrap();
            let mut c = control();
            if expire {
                c.deadline = Instant::now() + Duration::from_millis(30);
            }
            let token = c.cancellation.clone();
            let r = s.start_resume_inspection(c).unwrap();
            let wrong = ResumeInspectionRun(Arc::new(()));
            assert!(matches!(
                s.cancel_resume_inspection(&wrong),
                Err(SupervisorError::WrongInspection)
            ));
            assert!(!token.is_cancelled());
            assert!(s.join_resume_inspection(&r).now_or_never().is_none());
            assert!(matches!(
                s.start_resume_inspection(control()),
                Err(SupervisorError::Busy)
            ));
            assert!(matches!(
                s.start_preflight(super::super::tests::mapping("map:2", Some(1)), control()),
                Err(SupervisorError::Busy)
            ));
            assert!(matches!(s.take_store(), Err(SupervisorError::Busy)));
            if expire {
                tokio::time::sleep(Duration::from_millis(40)).await;
            } else {
                s.cancel_resume_inspection(&r).unwrap();
            }
            release.send(()).unwrap();
            blocker.await.unwrap();
            let c = s.join_resume_inspection(&r).await.unwrap();
            assert!(c.outcome.is_err());
            assert!(Arc::ptr_eq(
                &c,
                &s.join_resume_inspection(&r).await.unwrap()
            ));
            assert!(!s.state().recording.stop_requested);
        });
    }
}
#[tokio::test]
async fn inspection_panic_or_unusable_reader_never_fakes_repair_and_does_not_block_safety_join() {
    for panic in [false, true] {
        let (mut s, _d) = ready();
        let recording = s.host.state().run.clone().unwrap();
        let r = s
            .start_inspection_with(control(), move |_, _| {
                if panic {
                    panic!("inspection panic");
                }
                Err(scada_historian::store::StoreError::Control(
                    QueryError::ReaderUnusable,
                ))
            })
            .unwrap();
        let result = s.join_resume_inspection(&r).await;
        if panic {
            assert!(matches!(result, Err(SupervisorError::ReaderFailed)));
        } else {
            assert!(result.unwrap().outcome.is_err());
        }
        assert!(!s.state().recording.stop_requested);
        assert!(s.start_resume_inspection(control()).is_err());
        s.request_stop_recording(&recording).unwrap();
        s.join_recording(&recording).await.unwrap();
        assert!(s.take_store().is_ok());
    }
}
#[tokio::test]
async fn invalid_sdk_or_identifiers_never_replace_a_prepared_plan() {
    let (mut s, _d) = ready();
    let r = inspect(&mut s).await;
    for kind in 0..4 {
        let mut q = resolution();
        match kind {
            0 => q.session_id.clear(),
            1 => q.activation_id.clear(),
            2 => q.clock_epoch.clear(),
            _ => {
                let mut g = (*q.sdk_snapshot).clone();
                g.values = None;
                q.sdk_snapshot = Arc::new(g);
            }
        }
        assert!(s.prepare_resume(&r, q).is_err(), "case {kind}");
        assert!(s.resume.prepared.is_none());
    }
    assert!(s.prepare_resume(&r, resolution()).is_ok());
}

#[tokio::test]
async fn mapping_change_after_inspection_is_rejected_by_native_start_without_reattaching_old_state()
{
    let (mut s, _d) = ready();
    let r = inspect(&mut s).await;
    let ticket = s.prepare_resume(&r, resolution()).unwrap();
    let super::super::RecordingPlanTurnIntent::RegisterMapping(m) =
        super::super::tests::mapping("map:2", Some(1))
    else {
        panic!()
    };
    s.host
        .store
        .as_mut()
        .unwrap()
        .register_recording_mapping(&m, &control())
        .unwrap();
    let run = s.resume(&ticket, control(), client()).unwrap();
    assert!(matches!(
        s.resume(&ticket, control(), client()),
        Err(SupervisorError::ResumeConsumed)
    ));
    let c = s.join_recording(&run).await.unwrap();
    assert!(matches!(
        c.start_error,
        Some(scada_historian::recorder::RecorderStartError::ManagedBindingMismatch)
    ));
    assert!(c.activation_receipt.is_none());
    let r = inspect(&mut s).await;
    assert!(s.resume.completion.as_ref().unwrap().outcome.is_ok());
    assert!(s.prepare_resume(&r, resolution()).is_err());
}

#[tokio::test]
async fn dropped_inspection_cancels_but_keeps_the_shared_lease_until_its_worker_finishes() {
    let (mut s, d) = ready();
    let external = s.host.store.as_ref().unwrap().reader().unwrap();
    let (release, receive) = std::sync::mpsc::sync_channel(0);
    let (entered, done) = tokio::sync::oneshot::channel();
    let c = control();
    let cancel = c.cancellation.clone();
    s.start_inspection_with(c, move |reader, c| {
        entered.send(()).unwrap();
        receive.recv().unwrap();
        reader.recording_resume_state(c)
    })
    .unwrap();
    done.await.unwrap();
    drop(s);
    assert!(cancel.is_cancelled());
    assert!(matches!(
        scada_historian::store::SqliteStore::open_existing(
            &d.0,
            &crate::recording_host::retention::tests::identity()
        ),
        Err(scada_historian::store::StoreError::Busy)
    ));
    release.send(()).unwrap();
    drop(external);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match scada_historian::store::SqliteStore::open_existing(
            &d.0,
            &crate::recording_host::retention::tests::identity(),
        ) {
            Err(scada_historian::store::StoreError::Busy) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(5)).await
            }
            result => {
                drop(result.unwrap());
                break;
            }
        }
    }
}
