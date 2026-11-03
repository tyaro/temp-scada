use super::*;
use crate::recording_host::retention::tests::{clean_host, control, plan};
use scada_historian::store::{recording_plan::*, StoreError};
use serde_json::json;

pub(super) fn setup() -> (
    RecordingSupervisor,
    crate::recording_host::retention::tests::Directory,
) {
    let (host, dir) = clean_host();
    let reader = host.store.as_ref().unwrap().reader().unwrap();
    (
        RecordingSupervisor {
            host,
            preflight: PreflightOwner::new(reader),
            resume: resume::ResumeOwner::default(),
        },
        dir,
    )
}
pub(super) fn mapping(key: &str, previous: Option<u64>) -> RecordingPlanTurnIntent {
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
                .map(|(n, m)| RecordingMappingMember {
                    member_id: format!("member:{n}"),
                    identity: m.clone(),
                })
                .collect(),
        },
    })
}
pub(super) fn apply(key: &str) -> RecordingPlanTurnIntent {
    RecordingPlanTurnIntent::Apply(ApplyRecordingPlanRequest {
        request_id: key.into(),
        expected_applied_revision: None,
        expected_mapping_revision: None,
        expected_retention_applied_revision: None,
        desired: json!({"version":1,"kind":"recordingPlan","planId":"desired","revision":1,"enabled":false,"group":{"groupId":"group","hubRef":"hub","periodMs":1000,"members":[{"memberId":"member:0","externalName":plan().session().members[0].external_name,"valueType":"number"}]}}),
    })
}
async fn checked(s: &mut RecordingSupervisor, intent: RecordingPlanTurnIntent) -> PreflightRun {
    let run = s.start_preflight(intent, control()).unwrap();
    s.join_preflight(&run).await.unwrap();
    run
}
#[test]
fn factory_returns_the_original_writer_on_full_leases_and_retires_only_its_own_reader() {
    let (mut host, _dir) = clean_host();
    let mut store = host.take_store().unwrap();
    let a = store.reader().unwrap();
    let b = store.reader().unwrap();
    let error = match RecordingSupervisor::try_new(store) {
        Err(e) => e,
        Ok(_) => panic!("must be Busy"),
    };
    assert!(matches!(error.error, StoreError::Busy));
    assert!(!format!("{error:?}").contains("/tmp/"));
    store = error.store;
    assert_eq!(
        store
            .storage_diagnostics(&control())
            .unwrap()
            .live_reader_leases,
        2
    );
    drop(a);
    let mut s = RecordingSupervisor::try_new(store).unwrap();
    assert!(matches!(
        s.host.store.as_ref().unwrap().reader(),
        Err(StoreError::Busy)
    ));
    let mut store = s.take_store().unwrap();
    assert_eq!(s.state().recording.phase, RecordingPhase::NoStore);
    assert_eq!(
        store
            .storage_diagnostics(&control())
            .unwrap()
            .live_reader_leases,
        1
    );
    drop(b);
    assert_eq!(
        store
            .storage_diagnostics(&control())
            .unwrap()
            .live_reader_leases,
        0
    );
}
#[test]
fn missing_runtime_and_invalid_request_never_move_reader_or_create_a_ticket() {
    let (mut s, _dir) = setup();
    assert!(matches!(
        s.start_preflight(mapping("map", None), control()),
        Err(SupervisorError::NoRuntime)
    ));
    let mut bad = apply("bad");
    if let RecordingPlanTurnIntent::Apply(r) = &mut bad {
        r.desired["secret"] = json!("forbidden");
    }
    assert!(matches!(
        s.start_preflight(bad, control()),
        Err(SupervisorError::Request(_))
    ));
    assert_eq!(s.state().preflight_phase, PreflightPhase::Idle);
    assert!(s.preflight.reader.is_some());
    assert!(s.preflight.bound.is_none());
}
#[tokio::test]
async fn only_the_owned_candidate_executes_once_after_its_explicit_pause_join() {
    let (mut s, _dir) = setup();
    let mut external = mapping("owned", None);
    let run = checked(&mut s, external.clone()).await;
    if let RecordingPlanTurnIntent::RegisterMapping(r) = &mut external {
        r.request_id = "changed:outside".into();
        r.mapping.hub_ref = "different".into();
    }
    assert!(matches!(
        s.execute_candidate(&run, control()),
        Err(SupervisorError::PauseRequired)
    ));
    assert!(matches!(
        s.join_pause(&run).await,
        Err(SupervisorError::PauseRequired)
    ));
    assert!(matches!(
        s.start_preflight(external, control()),
        Err(SupervisorError::Busy)
    ));
    s.request_pause(&run).unwrap();
    let paused = s.join_pause(&run).await.unwrap();
    assert!(Arc::ptr_eq(&paused, &s.join_pause(&run).await.unwrap()));
    let turn = s.execute_candidate(&run, control()).unwrap();
    assert!(matches!(
        s.execute_candidate(&run, control()),
        Err(SupervisorError::CandidateConsumed)
    ));
    let receipt = s.join_recording_plan_turn(&turn).await.unwrap();
    assert!(
        matches!(&receipt.outcome,Ok(super::super::RecordingPlanTurnReceipt::Mapping(r)) if r.request_id=="owned")
    );
    // Rejoining the old preflight cannot reset a consumed ticket.
    s.join_preflight(&run).await.unwrap();
    assert!(matches!(
        s.execute_candidate(&run, control()),
        Err(SupervisorError::CandidateConsumed)
    ));
    assert!(matches!(
        s.discard_candidate(&run),
        Err(SupervisorError::CandidateConsumed)
    ));
    let next = checked(&mut s, apply("apply")).await;
    assert!(matches!(
        s.request_pause(&run),
        Err(SupervisorError::WrongPreflight)
    ));
    s.request_pause(&next).unwrap();
    s.join_pause(&next).await.unwrap();
    let next_turn = s.execute_candidate(&next, control()).unwrap();
    s.join_recording_plan_turn(&next_turn).await.unwrap();
    assert_eq!(
        s.recording_plan_guard_state().last_mapping.unwrap().run,
        turn
    );
    let mut store = s.take_store().unwrap();
    assert!(store
        .recording_mapping_receipt("changed:outside", &control())
        .unwrap()
        .is_none());
    assert_eq!(
        store
            .recording_plan_state(&control())
            .unwrap()
            .mapping
            .unwrap()
            .receipt
            .mapping_revision,
        1
    );
    assert_eq!(
        store
            .storage_diagnostics(&control())
            .unwrap()
            .live_reader_leases,
        0
    );
}
#[tokio::test]
async fn replay_or_error_never_becomes_a_pause_ticket_and_a_new_request_can_follow() {
    let (mut s, _dir) = setup();
    let RecordingPlanTurnIntent::RegisterMapping(r) = mapping("known", None) else {
        panic!()
    };
    let receipt = s
        .host
        .store
        .as_mut()
        .unwrap()
        .register_recording_mapping(&r, &control())
        .unwrap();
    let run = checked(&mut s, RecordingPlanTurnIntent::RegisterMapping(r)).await;
    let c = s.join_preflight(&run).await.unwrap();
    assert!(
        matches!(&c.outcome,Ok(PreflightReport::Mapping(r)) if r.outcome==MappingPreflightOutcome::Replay(receipt.clone()))
    );
    assert!(matches!(
        s.request_pause(&run),
        Err(SupervisorError::NoCandidate)
    ));
    assert!(matches!(
        s.execute_candidate(&run, control()),
        Err(SupervisorError::NoCandidate)
    ));
    assert!(!s.state().recording.stop_requested);
    let bad = checked(&mut s, mapping("bad", None)).await;
    assert!(matches!(
        s.join_preflight(&bad).await.unwrap().outcome,
        Err(StoreError::Conflict)
    ));
    assert!(matches!(
        s.request_pause(&bad),
        Err(SupervisorError::NoCandidate)
    ));
    assert!(!s.state().recording.stop_requested);
    let good = checked(&mut s, mapping("good", Some(1))).await;
    s.discard_candidate(&good).unwrap();
    assert!(matches!(
        s.request_pause(&good),
        Err(SupervisorError::WrongPreflight)
    ));
    assert_eq!(s.state().candidate_phase, None);
}
#[tokio::test]
async fn reader_snapshot_does_not_reserve_cas_or_authorize_a_later_write() {
    let (mut s, _dir) = setup();
    let run = checked(&mut s, mapping("candidate", None)).await;
    // Model a competing management commit after the read-only snapshot.
    let RecordingPlanTurnIntent::RegisterMapping(r) = mapping("competing", None) else {
        panic!()
    };
    s.host
        .store
        .as_mut()
        .unwrap()
        .register_recording_mapping(&r, &control())
        .unwrap();
    s.request_pause(&run).unwrap();
    s.join_pause(&run).await.unwrap();
    let turn = s.execute_candidate(&run, control()).unwrap();
    assert!(matches!(
        s.join_recording_plan_turn(&turn).await.unwrap().outcome,
        Err(StoreError::Conflict)
    ));
    assert!(s.recording_plan_guard_state().recovery_required);
    assert!(matches!(
        s.start_preflight(apply("blocked"), control()),
        Err(SupervisorError::Host(
            RecordingHostError::PlanRecoveryRequired
        ))
    ));
    assert!(s
        .take_store()
        .unwrap()
        .recording_plan_state(&control())
        .unwrap()
        .applied
        .is_none());
}
#[tokio::test]
async fn both_recording_identity_and_candidate_session_are_checked_before_stop() {
    let (mut s, _dir) = setup();
    let run = checked(&mut s, mapping("candidate", None)).await;
    let original = s.preflight.completion.take().unwrap();
    let mut result = original.outcome.as_ref().unwrap().clone();
    let PreflightReport::Mapping(r) = &mut result else {
        panic!()
    };
    r.outcome = MappingPreflightOutcome::Candidate {
        active_session_id: Some("other:session".into()),
    };
    s.preflight.completion = Some(Arc::new(PreflightCompletion {
        run: run.clone(),
        recording_run: original.recording_run.clone(),
        outcome: Ok(result),
    }));
    assert!(matches!(
        s.request_pause(&run),
        Err(SupervisorError::ContextMismatch)
    ));
    assert!(!s.state().recording.stop_requested);
    s.preflight.completion = Some(original);
    let other = RecordingRun(Arc::new(()));
    s.host
        .status
        .send_modify(|state| Arc::make_mut(state).run = Some(other));
    assert!(matches!(
        s.request_pause(&run),
        Err(SupervisorError::ContextMismatch)
    ));
}
#[tokio::test]
async fn host_initial_starting_finished_and_unclean_or_latched_states_are_rejected() {
    for kind in 0..9 {
        let (mut s, _dir) = setup();
        match kind {
            0 => {
                s.host.completion = None;
                s.host
                    .status
                    .send_modify(|x| Arc::make_mut(x).phase = RecordingPhase::Idle);
            }
            1 => {
                s.host
                    .status
                    .send_modify(|x| Arc::make_mut(x).phase = RecordingPhase::Starting);
            }
            2 => {
                s.host
                    .status
                    .send_modify(|x| Arc::make_mut(x).phase = RecordingPhase::FinishedUnjoined);
            }
            3 => s.host.retention.job_pending = true,
            4 => s.host.retention.rearm_required = true,
            5 => s.host.plan_turn.recovery_required = true,
            6 => {
                Arc::get_mut(s.host.completion.as_mut().unwrap())
                    .unwrap()
                    .source_shutdown = Err(banto_tagclient::ErrorKind::Transport)
            }
            7 => {
                s.host.store.take();
            }
            _ => s
                .host
                .status
                .send_modify(|x| Arc::make_mut(x).phase = RecordingPhase::Faulted),
        };
        assert!(
            s.start_preflight(mapping("map", None), control()).is_err(),
            "case {kind}"
        );
        assert!(s.preflight.running.is_none());
        assert!(s.preflight.reader.is_some());
    }
}
#[tokio::test]
async fn a_post_preflight_recording_failure_cannot_be_promoted_to_clean_pause() {
    let (mut s, _dir) = setup();
    let run = checked(&mut s, mapping("candidate", None)).await;
    Arc::get_mut(s.host.completion.as_mut().unwrap())
        .unwrap()
        .source_shutdown = Err(banto_tagclient::ErrorKind::Transport);
    s.request_pause(&run).unwrap();
    assert!(matches!(
        s.join_pause(&run).await,
        Err(SupervisorError::Host(RecordingHostError::UncleanPause))
    ));
    assert!(matches!(
        s.execute_candidate(&run, control()),
        Err(SupervisorError::PauseRequired)
    ));
    s.discard_candidate(&run).unwrap();
    assert!(s
        .host
        .store
        .as_mut()
        .unwrap()
        .recording_plan_state(&control())
        .unwrap()
        .mapping
        .is_none());
}
#[tokio::test]
async fn direct_safety_join_does_not_satisfy_the_ticket_pause_protocol() {
    let (mut s, _dir) = setup();
    let run = checked(&mut s, mapping("candidate", None)).await;
    let recording = s.host.state().run.clone().unwrap();
    s.request_stop_recording(&recording).unwrap();
    s.join_recording(&recording).await.unwrap();
    assert!(matches!(
        s.execute_candidate(&run, control()),
        Err(SupervisorError::PauseRequired)
    ));
    s.request_pause(&run).unwrap();
    s.join_pause(&run).await.unwrap();
    let turn = s.execute_candidate(&run, control()).unwrap();
    s.join_recording_plan_turn(&turn).await.unwrap();
}

#[tokio::test]
async fn new_recording_requires_discard_and_only_successful_start_invalidates_old_results() {
    let (mut s, _dir) = setup();
    let run = checked(&mut s, mapping("candidate", None)).await;
    let options = RecordingOptions {
        plan: scada_historian::store::evidence::PlanRef {
            plan_id: "plan".into(),
            revision: 1,
        },
        slot_count: Some(1),
        max_clock_skew_ms: 1000,
        clock_epoch: "new:epoch".into(),
    };
    let client = || {
        banto_tagclient::RestClient::new(
            banto_tagclient::Endpoint::new("http://127.0.0.1:9").unwrap(),
            banto_tagclient::SecretApiKey::new("supervisor-test-only-key".into()).unwrap(),
        )
        .unwrap()
    };
    assert!(matches!(
        s.start(plan(), options.clone(), client()),
        Err(SupervisorError::Busy)
    ));
    assert_eq!(s.state().candidate_phase, Some(CandidatePhase::Candidate));
    s.discard_candidate(&run).unwrap();
    let RecordingPlanTurnIntent::RegisterMapping(r) = mapping("known", None) else {
        panic!()
    };
    s.host
        .store
        .as_mut()
        .unwrap()
        .register_recording_mapping(&r, &control())
        .unwrap();
    let replay = checked(&mut s, RecordingPlanTurnIntent::RegisterMapping(r)).await;
    let old = s.preflight.completion.clone().unwrap();
    assert!(matches!(
        s.start(plan(), options.clone(), client()),
        Err(SupervisorError::Host(RecordingHostError::SessionReuse))
    ));
    assert!(Arc::ptr_eq(&old, s.preflight.completion.as_ref().unwrap()));
    let catalog = crate::tests::catalog();
    let tag = &catalog.tags[0];
    let mut spec = plan().session().clone();
    spec.session_id = "second:recording".into();
    let sdk = SdkRecorderPlan::new(
        spec,
        crate::recorder_source::SdkGenerationPin {
            catalog_revision: catalog.revision,
            run_id: catalog.run_id,
            collection_mode: catalog.collection_mode,
        },
        vec![crate::recorder_source::SdkBindingPin {
            series_id: "number".into(),
            stable_id: tag.ids,
            tag_key: tag.tag_key.clone(),
            data_type: tag.data_type.clone(),
        }],
    )
    .unwrap();
    let recording = s.start(sdk, options, client()).unwrap();
    assert_eq!(s.state().preflight_phase, PreflightPhase::Idle);
    assert!(matches!(
        s.request_pause(&replay),
        Err(SupervisorError::WrongPreflight)
    ));
    s.request_stop_recording(&recording).unwrap();
    s.join_recording(&recording).await.unwrap();
}
