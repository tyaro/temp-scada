//! Public native owner API, real SDK loopback, isolated SQLite; no UI/transport bridge.
use super::*;
use scada_historian::store::query::HistoryReader;
use scada_model::recording_operations::{RecordingChangeRequest, RecordingOperationsContext};
use scada_runtime::recording_operations::{
    OperationErrorCode, OperationsPhase, RecordingOperationsOwner,
};
fn context() -> RecordingOperationsContext {
    RecordingOperationsContext::from_value(json!({"version":1,"kind":"recordingOperationsContext","target":{"version":1,"kind":"recordingManagementContext","contextId":"context","projectId":"project","projectRevision":1,"deploymentId":"test-deployment","storeId":"host-store","historianNamespace":null},"capabilityId":"capability","recordingRunRef":"run","sessionId":"sdk-recording"})).unwrap()
}
fn request(id: &str, context: &RecordingOperationsContext) -> RecordingChangeRequest {
    let mut value = json!({"version":1,"kind":"recordingChangeRequest","changeId":id,"context":context.as_value(),"apply":super::plan_turn::apply_request(&format!("apply:{id}"),1)});
    for name in [
        "expectedAppliedRevision",
        "expectedMappingRevision",
        "expectedRetentionAppliedRevision",
    ] {
        value["apply"][name] = json!(1.0);
    }
    value["context"]["target"]["projectRevision"] = json!(1.0);
    RecordingChangeRequest::from_value(value).unwrap()
}
fn raw(reader: &mut HistoryReader) -> serde_json::Value {
    let activation = reader
        .recording_resume_state(&control())
        .unwrap()
        .latest_activation
        .unwrap();
    let start = activation.receipt.start.at_ms;
    let series = &activation.session.spec.members[0].series_id;
    reader.query_raw(&json!({"version":1,"kind":"query","requestId":"after-owner","seriesIds":[series],"fromMs":start,"toMs":start+10000,"mode":"raw","maxPointsPerSeries":100}),&control()).unwrap()
}
#[tokio::test]
async fn public_owner_preflight_keeps_capture_live_then_explicit_pause_apply_keeps_history() {
    let hub = Hub::new().await;
    let (s, run, _options, mut history, _dir, mut socket) =
        super::supervisor::setup(&hub, None).await;
    let mut native_states = s.recording_watch();
    let mut ctx = context().as_value().clone();
    ctx["sessionId"] = json!(s.state().recording.session_id.as_ref().unwrap());
    let ctx = RecordingOperationsContext::from_value(ctx).unwrap();
    let mut owner = RecordingOperationsOwner::try_new(s, ctx.clone(), run).unwrap();
    let client = owner.client();
    let peer = client.clone();
    let change = client.preflight(request("next", &ctx), control()).unwrap();
    assert_eq!(
        peer.preflight(request("overlap", &ctx), control())
            .unwrap_err()
            .code,
        OperationErrorCode::Busy
    );
    let r = change.operation.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["kind"], "candidate");
    assert_eq!(native_states.borrow().phase, RecordingPhase::Running);
    let before = native_states
        .borrow()
        .progress
        .as_ref()
        .unwrap()
        .counters
        .committed_ticks;
    wait_status(&mut native_states, |s| {
        s.progress
            .as_ref()
            .is_some_and(|p| p.counters.committed_ticks > before)
    })
    .await;
    assert_eq!(client.state().phase, OperationsPhase::Candidate);
    let stopped = peer.pause_join(&change.change, "pause", control()).unwrap();
    stopped.wait().await.unwrap();
    closed(&mut socket).await;
    assert_eq!(native_states.borrow().phase, RecordingPhase::Joined);
    let before = raw(&mut history);
    assert!(before["series"][0]["raw"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["value"].as_f64() == Some(42.0)));
    let applied = client.apply(&change.change, "apply", control()).unwrap();
    let result = applied.wait().await.unwrap();
    assert_eq!(result.as_value()["outcome"]["kind"], "applied");
    assert_eq!(client.state().phase, OperationsPhase::Completed);
    assert_eq!(native_states.borrow().phase, RecordingPhase::Joined);
    assert_eq!(raw(&mut history)["series"], before["series"]);
    let handoff = owner.try_handoff().unwrap();
    assert_eq!(
        handoff.supervisor.state().recording.phase,
        RecordingPhase::Joined
    );
    assert!(peer.state().closed);
}
#[tokio::test]
async fn replay_and_conflict_do_not_stop_a_live_run_and_client_drop_does_not_stop_it() {
    let hub = Hub::new().await;
    let (s, run, _options, _history, _dir, mut socket) = super::supervisor::setup(&hub, None).await;
    let mut native_states = s.recording_watch();
    let mut ctx = context().as_value().clone();
    ctx["sessionId"] = json!(s.state().recording.session_id.as_ref().unwrap());
    let ctx = RecordingOperationsContext::from_value(ctx).unwrap();
    let mut owner = RecordingOperationsOwner::try_new(s, ctx.clone(), run.clone()).unwrap();
    let client = owner.client();
    let mut replay = request("replay", &ctx).as_value().clone();
    replay["apply"]["requestId"] = json!("apply");
    replay["apply"]["expectedAppliedRevision"] = serde_json::Value::Null;
    // The original managed apply is replayed without creating a new activation.
    let r = client
        .preflight(
            RecordingChangeRequest::from_value(replay).unwrap(),
            control(),
        )
        .unwrap()
        .operation
        .wait()
        .await
        .unwrap();
    assert_eq!(r.as_value()["outcome"]["kind"], "replay");
    assert!(client.state().last_applied.is_none());
    let mut conflict = request("conflict", &ctx).as_value().clone();
    conflict["apply"]["expectedAppliedRevision"] = serde_json::Value::Null;
    let op = client
        .preflight(
            RecordingChangeRequest::from_value(conflict).unwrap(),
            control(),
        )
        .unwrap()
        .operation;
    drop(client);
    let r = op.wait().await.unwrap();
    assert_eq!(r.as_value()["outcome"]["error"], "conflict");
    let before = native_states
        .borrow()
        .progress
        .as_ref()
        .unwrap()
        .counters
        .committed_ticks;
    wait_status(&mut native_states, |s| {
        s.progress
            .as_ref()
            .is_some_and(|p| p.counters.committed_ticks > before)
    })
    .await;
    assert_eq!(native_states.borrow().phase, RecordingPhase::Running);
    let mut handoff = owner.try_handoff().unwrap();
    handoff.supervisor.request_stop_recording(&run).unwrap();
    handoff.supervisor.join_recording(&run).await.unwrap();
    closed(&mut socket).await;
}
