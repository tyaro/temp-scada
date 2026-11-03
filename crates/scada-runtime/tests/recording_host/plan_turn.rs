use super::*;
use scada_historian::{
    recorder::ManagedRecorderStart,
    store::recording_plan::{
        ApplyRecordingPlanRequest, PlanPreflightOutcome, RecordingMapping, RecordingMappingMember,
        RegisterMappingRequest,
    },
};
use scada_runtime::recording_host::{RecordingPlanTurnIntent, RecordingPlanTurnReceipt};

pub(super) fn map_request(key: &str, previous: u64) -> RegisterMappingRequest {
    let sdk = plan(Some(7), Source::Real, false);
    RegisterMappingRequest {
        request_id: key.into(),
        expected_mapping_revision: Some(previous),
        mapping: RecordingMapping {
            hub_ref: "hub".into(),
            hub_instance_id: "test-hub".into(),
            members: sdk
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
    }
}
pub(super) fn apply_request(key: &str, map_revision: u64) -> ApplyRecordingPlanRequest {
    ApplyRecordingPlanRequest {
        request_id: key.into(),
        expected_applied_revision: Some(1),
        expected_mapping_revision: Some(map_revision),
        expected_retention_applied_revision: Some(1),
        desired: json!({"version":1,"kind":"recordingPlan","planId":"desired","revision":1,"enabled":true,"group":{"groupId":"group","hubRef":"hub","periodMs":1000,"members":[{"memberId":"member:0","externalName":NUMBER,"valueType":"number"}]}}),
    }
}
async fn first_running(
    hub: &Hub,
    mut host: RecordingHost,
) -> (
    RecordingHost,
    scada_runtime::recording_host::RecordingRun,
    RecordingOptions,
    tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
) {
    let sdk = plan(Some(7), Source::Real, false);
    let mut store = host.take_store().unwrap();
    let (opts, binding) = prepare_managed(&mut store, &sdk, None);
    let mut host = RecordingHost::new(store);
    let recording = host
        .start_managed(sdk, opts.clone(), binding, control(), hub.client())
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
    let mut states = host.state_watch();
    wait_status(&mut states, |s| {
        s.progress
            .as_ref()
            .is_some_and(|p| p.counters.committed_ticks >= 2)
    })
    .await;
    (host, recording, opts, socket)
}
#[tokio::test]
async fn same_host_managed_stop_mapping_apply_and_new_domain_recording_preserve_history() {
    let hub = Hub::new().await;
    let (host, _dir) = host();
    let (mut host, recording, mut opts, mut socket) = first_running(&hub, host).await;
    assert!(matches!(
        host.start_recording_plan_turn(
            &recording,
            RecordingPlanTurnIntent::RegisterMapping(map_request("map:2", 1)),
            control()
        ),
        Err(RecordingHostError::Busy)
    ));
    host.request_stop();
    let first = host.join().await.unwrap();
    closed(&mut socket).await;
    let first_receipt = first.activation_receipt.as_ref().unwrap().clone();
    let mapping = host
        .start_recording_plan_turn(
            &recording,
            RecordingPlanTurnIntent::RegisterMapping(map_request("map:2", 1)),
            control(),
        )
        .unwrap();
    let map_done = host.join_recording_plan_turn(&mapping).await.unwrap();
    let Ok(RecordingPlanTurnReceipt::Mapping(ref map_receipt)) = map_done.outcome else {
        panic!("map")
    };
    let applied = host
        .start_recording_plan_turn(
            &recording,
            RecordingPlanTurnIntent::Apply(apply_request("apply:2", 2)),
            control(),
        )
        .unwrap();
    let applied_done = host.join_recording_plan_turn(&applied).await.unwrap();
    let Ok(RecordingPlanTurnReceipt::Applied(ref applied_receipt)) = applied_done.outcome else {
        panic!("apply")
    };
    assert_eq!(
        applied_receipt.commit_version,
        map_receipt.commit_version + 1
    );
    opts.plan = applied_receipt.plan.clone();
    opts.clock_epoch = "managed:second:clock".into();
    opts.slot_count = Some(2);
    let binding = ManagedRecorderStart {
        activation_id: "managed:second".into(),
        expected_applied_revision: 2,
        expected_mapping_revision: 2,
        expected_retention_applied_revision: 1,
    };
    host.start_managed(
        new_session("managed:second:session"),
        opts,
        binding,
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
    let second = timeout(Duration::from_secs(5), host.join())
        .await
        .unwrap()
        .unwrap();
    closed(&mut socket).await;
    let second_receipt = second.activation_receipt.as_ref().unwrap();
    assert_eq!(second_receipt.applied_revision, 2);
    assert_ne!(
        first_receipt.spec.session_id,
        second_receipt.spec.session_id
    );
    assert_ne!(
        first_receipt.start.clock_epoch,
        second_receipt.start.clock_epoch
    );
    assert!(matches!(
        host.join_recording_plan_turn(&applied).await,
        Err(RecordingHostError::PlanTurnMismatch)
    ));
    let state = host.recording_plan_guard_state();
    assert_eq!(state.last_mapping.as_ref().unwrap().run, mapping);
    assert_eq!(state.last_applied.as_ref().unwrap().run, applied);
    assert_eq!(
        state.last_applied.as_ref().unwrap().recording_run,
        recording
    );
    assert!(!state.recovery_required);
    assert!(matches!(
        host.start_recording_plan_turn(
            &recording,
            RecordingPlanTurnIntent::RegisterMapping(map_request("stale", 2)),
            control()
        ),
        Err(RecordingHostError::RecordingRunMismatch)
    ));
    let mut store = host.take_store().unwrap();
    assert_eq!(
        store
            .recording_activation("managed-first", &control())
            .unwrap()
            .unwrap()
            .receipt,
        first_receipt
    );
    let mut reader = store.reader().unwrap();
    let query = json!({"version":1,"kind":"query","requestId":"cycle","seriesIds":["series-0"],"fromMs":first_receipt.start.at_ms,"toMs":second_receipt.start.at_ms+10000,"mode":"raw","maxPointsPerSeries":100});
    let raw = reader.query_raw(&query, &control()).unwrap();
    let rows = raw["series"][0]["raw"].as_array().unwrap();
    assert!(rows.iter().any(|r| r["value"] == 42.0));
    assert!(rows.iter().any(|r| r["value"] == 43.0));
    for receipt in [&first_receipt, second_receipt] {
        assert!(rows
            .iter()
            .any(|r| r["recordId"]["sessionId"] == receipt.spec.session_id
                && r["clockEpoch"] == receipt.start.clock_epoch));
    }
    assert!(!raw["series"][0]["coverage"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["reason"] == "samplingMissed"
            && c["fromMs"].as_i64().unwrap() <= first_receipt.start.at_ms
            && c["toMs"].as_i64().unwrap() >= second_receipt.start.at_ms));
    let mut minmax = query;
    minmax["mode"] = json!("minmax");
    assert_eq!(
        reader.query_minmax(&minmax, &control()).unwrap()["status"],
        "ready"
    );
}
#[tokio::test]
async fn mapping_commit_then_apply_failure_stays_paused_with_both_old_applied_and_new_mapping() {
    let hub = Hub::new().await;
    let (host, _dir) = host();
    let (mut host, recording, opts, mut socket) = first_running(&hub, host).await;
    host.request_stop();
    let initial = host.join().await.unwrap();
    closed(&mut socket).await;
    let turn = host
        .start_recording_plan_turn(
            &recording,
            RecordingPlanTurnIntent::RegisterMapping(map_request("map:2", 1)),
            control(),
        )
        .unwrap();
    assert!(host
        .join_recording_plan_turn(&turn)
        .await
        .unwrap()
        .outcome
        .is_ok());
    let mut request = apply_request("bad:apply", 2);
    request.expected_applied_revision = None;
    let turn = host
        .start_recording_plan_turn(
            &recording,
            RecordingPlanTurnIntent::Apply(request),
            control(),
        )
        .unwrap();
    assert!(matches!(
        host.join_recording_plan_turn(&turn).await.unwrap().outcome,
        Err(StoreError::Conflict)
    ));
    assert!(host.recording_plan_guard_state().recovery_required);
    assert_eq!(
        host.recording_plan_guard_state()
            .last_mapping
            .unwrap()
            .receipt
            .mapping_revision,
        2
    );
    assert!(host.recording_plan_guard_state().last_applied.is_none());
    let mut second_opts = opts;
    second_opts.clock_epoch = "blocked:second".into();
    assert!(matches!(
        host.start_managed(
            new_session("blocked:second"),
            second_opts,
            ManagedRecorderStart {
                activation_id: "blocked:activation".into(),
                expected_applied_revision: 1,
                expected_mapping_revision: 1,
                expected_retention_applied_revision: 1
            },
            control(),
            hub.client()
        ),
        Err(RecordingHostError::PlanRecoveryRequired)
    ));
    let mut store = host.take_store().unwrap();
    let state = store.recording_plan_state(&control()).unwrap();
    assert_eq!(state.mapping.unwrap().receipt.mapping_revision, 2);
    assert_eq!(state.applied.unwrap().receipt.applied_revision, 1);
    assert_eq!(
        store
            .recording_activation_state(&control())
            .unwrap()
            .latest
            .unwrap()
            .receipt,
        initial.activation_receipt.as_ref().unwrap().clone()
    );
}
#[tokio::test]
async fn readonly_preflight_while_real_host_runs_never_stops_or_applies_the_candidate() {
    let hub = Hub::new().await;
    let (mut host, _dir) = host();
    let sdk = plan(Some(7), Source::Real, false);
    let mut store = host.take_store().unwrap();
    let (opts, binding) = prepare_managed(&mut store, &sdk, None);
    let mut reader = store.reader().unwrap();
    let mut host = RecordingHost::new(store);
    let recording = host
        .start_managed(sdk, opts, binding, control(), hub.client())
        .unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    let mut states = host.state_watch();
    wait_status(&mut states, |s| {
        s.progress
            .as_ref()
            .is_some_and(|p| p.counters.committed_ticks >= 1)
    })
    .await;
    let result = tokio::task::spawn_blocking(move || {
        let result = reader.preflight_recording_plan(&apply_request("candidate", 1), &control());
        (reader, result)
    })
    .await
    .unwrap();
    assert_eq!(
        result.1.unwrap().outcome,
        PlanPreflightOutcome::Candidate {
            active_session_id: Some("recording".into())
        }
    );
    let before = host
        .state()
        .progress
        .as_ref()
        .unwrap()
        .counters
        .committed_ticks;
    wait_status(&mut states, |s| {
        s.progress
            .as_ref()
            .is_some_and(|p| p.counters.committed_ticks > before)
    })
    .await;
    assert_eq!(host.state().run.as_ref(), Some(&recording));
    assert!(!host.state().stop_requested);
    host.request_stop();
    host.join().await.unwrap();
    closed(&mut socket).await;
    let mut store = host.take_store().unwrap();
    assert!(store
        .recording_plan_receipt("candidate", &control())
        .unwrap()
        .is_none());
    drop(result.0);
}
