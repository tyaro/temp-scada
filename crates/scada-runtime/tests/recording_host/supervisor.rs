use super::plan_turn::{apply_request, map_request};
use super::*;
use scada_historian::{
    recorder::ManagedRecorderStart,
    store::{query::HistoryReader, recording_plan::MappingPreflightOutcome},
};
use scada_runtime::recording_host::{
    CandidatePhase, PreflightReport, RecordingPlanTurnIntent, RecordingPlanTurnReceipt,
    RecordingSupervisor, SupervisorError,
};

async fn setup(
    hub: &Hub,
    slots: Option<u64>,
) -> (
    RecordingSupervisor,
    scada_runtime::recording_host::RecordingRun,
    RecordingOptions,
    HistoryReader,
    Directory,
    tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
) {
    let (mut host, dir) = host();
    let sdk = plan(Some(7), Source::Real, false);
    let mut store = host.take_store().unwrap();
    let (options, binding) = prepare_managed(&mut store, &sdk, slots);
    let history = store.reader().unwrap();
    let mut s = RecordingSupervisor::try_new(store).unwrap();
    let run = s
        .start_managed(sdk, options.clone(), binding, control(), hub.client())
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
    let mut states = s.recording_watch();
    wait_status(&mut states, |r| {
        r.progress
            .as_ref()
            .is_some_and(|p| p.counters.committed_ticks >= 1)
    })
    .await;
    (s, run, options, history, dir, socket)
}
#[tokio::test]
async fn bound_preflight_pause_apply_and_caller_managed_resume_use_one_supervisor_and_preserve_both_domains(
) {
    let hub = Hub::new().await;
    let (mut s, recording, mut options, mut history, _dir, mut socket) = setup(&hub, None).await;
    let mut request = map_request("owned:map", 1);
    let pf = s
        .start_preflight(
            RecordingPlanTurnIntent::RegisterMapping(request.clone()),
            control(),
        )
        .unwrap();
    request.request_id = "external:replacement".into();
    let result = s.join_preflight(&pf).await.unwrap();
    let Ok(PreflightReport::Mapping(report)) = &result.outcome else {
        panic!("mapping")
    };
    let snapshot = report.snapshot_commit;
    assert_eq!(
        report.outcome,
        MappingPreflightOutcome::Candidate {
            active_session_id: Some("recording".into())
        }
    );
    assert!(!s.state().recording.stop_requested);
    let ticks = s
        .state()
        .recording
        .progress
        .as_ref()
        .unwrap()
        .counters
        .committed_ticks;
    let mut states = s.recording_watch();
    wait_status(&mut states, |r| {
        r.progress
            .as_ref()
            .is_some_and(|p| p.counters.committed_ticks > ticks)
    })
    .await;
    assert!(matches!(
        s.execute_candidate(&pf, control()),
        Err(SupervisorError::PauseRequired)
    ));
    s.request_pause(&pf).unwrap();
    let first = s.join_pause(&pf).await.unwrap();
    closed(&mut socket).await;
    let first_receipt = first.activation_receipt.as_ref().unwrap().clone();
    let turn = s.execute_candidate(&pf, control()).unwrap();
    assert!(matches!(
        s.execute_candidate(&pf, control()),
        Err(SupervisorError::CandidateConsumed)
    ));
    let map = s.join_recording_plan_turn(&turn).await.unwrap();
    assert!(
        matches!(&map.outcome,Ok(RecordingPlanTurnReceipt::Mapping(r))if r.request_id=="owned:map"&&r.commit_version>snapshot+1)
    );
    let pf = s
        .start_preflight(
            RecordingPlanTurnIntent::Apply(apply_request("owned:apply", 2)),
            control(),
        )
        .unwrap();
    assert!(s.join_preflight(&pf).await.unwrap().outcome.is_ok());
    s.request_pause(&pf).unwrap();
    s.join_pause(&pf).await.unwrap();
    let applied = s.execute_candidate(&pf, control()).unwrap();
    let completed = s.join_recording_plan_turn(&applied).await.unwrap();
    let Ok(RecordingPlanTurnReceipt::Applied(receipt)) = &completed.outcome else {
        panic!("apply")
    };
    options.plan = receipt.plan.clone();
    options.clock_epoch = "supervisor:second:clock".into();
    options.slot_count = Some(2);
    let next = s
        .start_managed(
            new_session("supervisor:second:session"),
            options,
            ManagedRecorderStart {
                activation_id: "supervisor:second".into(),
                expected_applied_revision: 2,
                expected_mapping_revision: 2,
                expected_retention_applied_revision: 1,
            },
            control(),
            hub.client(),
        )
        .unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    socket
        .send(Message::Text(
            json!({"op":"data","id":1,"t":300,"values":[{"tag":NUMBER,"v":43,"q":"good","t":300}]})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let second = timeout(Duration::from_secs(5), s.join_recording(&next))
        .await
        .unwrap()
        .unwrap();
    closed(&mut socket).await;
    let second_receipt = second.activation_receipt.as_ref().unwrap();
    assert_eq!(second_receipt.applied_revision, 2);
    assert_ne!(
        first_receipt.start.clock_epoch,
        second_receipt.start.clock_epoch
    );
    assert!(matches!(
        s.request_pause(&pf),
        Err(SupervisorError::WrongPreflight)
    ));
    assert_eq!(
        s.recording_plan_guard_state()
            .last_applied
            .as_ref()
            .unwrap()
            .recording_run,
        recording
    );
    let mut store = s.take_store().unwrap();
    assert_eq!(
        store
            .storage_diagnostics(&control())
            .unwrap()
            .live_reader_leases,
        1
    );
    assert!(store
        .recording_mapping_receipt("external:replacement", &control())
        .unwrap()
        .is_none());
    assert_eq!(
        store
            .recording_plan_state(&control())
            .unwrap()
            .applied
            .unwrap()
            .receipt
            .applied_revision,
        2
    );
    let q = json!({"version":1,"kind":"query","requestId":"supervisor:raw","seriesIds":["series-0"],"fromMs":first_receipt.start.at_ms,"toMs":second_receipt.start.at_ms+10000,"mode":"raw","maxPointsPerSeries":100});
    let raw = history.query_raw(&q, &control()).unwrap();
    let rows = raw["series"][0]["raw"].as_array().unwrap();
    assert!(rows.iter().any(|r| r["value"] == 42.0));
    assert!(rows.iter().any(|r| r["value"] == 43.0));
    for receipt in [&first_receipt, second_receipt] {
        assert!(rows
            .iter()
            .any(|r| r["recordId"]["sessionId"] == receipt.spec.session_id
                && r["clockEpoch"] == receipt.start.clock_epoch));
    }
    let mut q = q;
    q["mode"] = json!("minmax");
    assert_eq!(
        history.query_minmax(&q, &control()).unwrap()["status"],
        "ready"
    );
}
#[tokio::test]
async fn replay_conflict_and_discard_leave_real_recording_running_without_an_implicit_stop() {
    let hub = Hub::new().await;
    let (mut s, recording, options, _history, _dir, mut socket) = setup(&hub, None).await;
    let mut known = map_request("map", 1);
    known.expected_mapping_revision = None;
    let replay = s
        .start_preflight(RecordingPlanTurnIntent::RegisterMapping(known), control())
        .unwrap();
    assert!(s.join_preflight(&replay).await.unwrap().outcome.is_ok());
    assert!(matches!(
        s.request_pause(&replay),
        Err(SupervisorError::NoCandidate)
    ));
    let mut bad = map_request("bad", 1);
    bad.expected_mapping_revision = None;
    let bad = s
        .start_preflight(RecordingPlanTurnIntent::RegisterMapping(bad), control())
        .unwrap();
    assert!(matches!(
        s.join_preflight(&bad).await.unwrap().outcome,
        Err(StoreError::Conflict)
    ));
    assert!(matches!(
        s.request_pause(&bad),
        Err(SupervisorError::NoCandidate)
    ));
    let pf = s
        .start_preflight(
            RecordingPlanTurnIntent::RegisterMapping(map_request("discarded", 1)),
            control(),
        )
        .unwrap();
    s.join_preflight(&pf).await.unwrap();
    assert!(matches!(
        s.start(new_session("blocked"), options, hub.client()),
        Err(SupervisorError::Busy)
    ));
    s.discard_candidate(&pf).unwrap();
    assert_eq!(s.state().candidate_phase, None);
    assert_eq!(s.state().recording.run.as_ref(), Some(&recording));
    assert!(!s.state().recording.stop_requested);
    let ticks = s
        .state()
        .recording
        .progress
        .as_ref()
        .unwrap()
        .counters
        .committed_ticks;
    let mut states = s.recording_watch();
    wait_status(&mut states, |r| {
        r.progress
            .as_ref()
            .is_some_and(|p| p.counters.committed_ticks > ticks)
    })
    .await;
    s.request_stop_recording(&recording).unwrap();
    s.join_recording(&recording).await.unwrap();
    closed(&mut socket).await;
    let mut store = s.take_store().unwrap();
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
}
#[tokio::test]
async fn natural_completion_after_preflight_still_needs_explicit_pause_join_before_execute() {
    let hub = Hub::new().await;
    let (mut s, _recording, _opts, _history, _dir, mut socket) = setup(&hub, Some(2)).await;
    let pf = s
        .start_preflight(
            RecordingPlanTurnIntent::RegisterMapping(map_request("after:finite", 1)),
            control(),
        )
        .unwrap();
    s.join_preflight(&pf).await.unwrap();
    let mut states = s.recording_watch();
    wait_status(&mut states, |r| r.phase == RecordingPhase::FinishedUnjoined).await;
    assert!(matches!(
        s.execute_candidate(&pf, control()),
        Err(SupervisorError::PauseRequired)
    ));
    assert_eq!(s.state().candidate_phase, Some(CandidatePhase::Candidate));
    s.request_pause(&pf).unwrap();
    s.join_pause(&pf).await.unwrap();
    closed(&mut socket).await;
    let turn = s.execute_candidate(&pf, control()).unwrap();
    assert!(s
        .join_recording_plan_turn(&turn)
        .await
        .unwrap()
        .outcome
        .is_ok());
    assert_eq!(s.state().recording.phase, RecordingPhase::Joined);
}
