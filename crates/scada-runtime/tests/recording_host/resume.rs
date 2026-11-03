use super::*;
use banto_tagclient::{BindingRequest, GenerationSnapshot, TagClientConnectionState};
use scada_historian::store::{
    evidence::ClockStamp, recording_plan::ActivateRecordingPlanRequest, SessionState,
};
use scada_runtime::recording_host::{RecordingSupervisor, ResumeResolution, SupervisorError};
async fn current_generation(hub: &Hub) -> Arc<GenerationSnapshot> {
    let handle = hub
        .client()
        .start(vec![BindingRequest {
            binding_key: "series-0".into(),
            external_name: NUMBER.into(),
        }])
        .unwrap();
    let mut watch = handle.state_watch();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    socket
        .send(Message::Text(
            json!({"op":"data","id":1,"t":200,"values":[{"tag":NUMBER,"v":42,"q":"good","t":200}]})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let generation = timeout(Duration::from_secs(5), async {
        loop {
            let s = watch.borrow_and_update().clone();
            if s.connection_state() == TagClientConnectionState::Live {
                if let Some(g) = s.snapshot() {
                    if g.values
                        .as_ref()
                        .is_some_and(|v| v.values.iter().any(|v| v.v == Some(42.0)))
                    {
                        break g.clone();
                    }
                }
            }
            watch.changed().await.unwrap();
        }
    })
    .await
    .unwrap();
    let (result, _) = tokio::join!(handle.shutdown(), closed(&mut socket));
    result.unwrap();
    generation
}
fn resolution(g: Arc<GenerationSnapshot>, id: &str) -> ResumeResolution {
    ResumeResolution {
        sdk_snapshot: g,
        session_id: format!("session:{id}"),
        clock_epoch: format!("clock:{id}"),
        activation_id: format!("activation:{id}"),
        slot_count: Some(2),
        max_clock_skew_ms: 1000,
    }
}
fn configured() -> (SqliteStore, Directory) {
    let (mut host, d) = host();
    let mut store = host.take_store().unwrap();
    prepare_managed(&mut store, &plan(Some(7), Source::Real, false), None);
    (store, d)
}
#[tokio::test]
async fn inspection_coherent_sdk_resolution_and_explicit_resume_record_only_the_new_source() {
    let hub = Hub::new().await;
    let (store, _dir) = configured();
    let mut s = RecordingSupervisor::try_new(store).unwrap();
    let r = s.start_resume_inspection(control()).unwrap();
    let view = s.join_resume_inspection(&r).await.unwrap();
    assert!(view.recording_run.is_none());
    assert!(view.outcome.as_ref().unwrap().latest_activation.is_none());
    let generation = current_generation(&hub).await;
    let ticket = s
        .prepare_resume(&r, resolution(generation, "first"))
        .unwrap();
    assert!(matches!(
        s.start_resume_inspection(control()),
        Err(SupervisorError::Busy)
    ));
    let run = s.resume(&ticket, control(), hub.client()).unwrap();
    assert!(matches!(
        s.resume(&ticket, control(), hub.client()),
        Err(SupervisorError::ResumeConsumed)
    ));
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    socket
        .send(Message::Text(
            json!({"op":"data","id":1,"t":300,"values":[{"tag":NUMBER,"v":43,"q":"good","t":300}]})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let c = timeout(Duration::from_secs(5), s.join_recording(&run))
        .await
        .unwrap()
        .unwrap();
    closed(&mut socket).await;
    let receipt = c.activation_receipt.as_ref().unwrap();
    assert_eq!(receipt.spec.session_id, "session:first");
    assert!(c.start_error.is_none());
    let r = s.start_resume_inspection(control()).unwrap();
    let c = s.join_resume_inspection(&r).await.unwrap();
    let state = c.outcome.as_ref().unwrap();
    assert_eq!(state.latest_activation.as_ref().unwrap().receipt, *receipt);
    assert_eq!(
        state.latest_activation.as_ref().unwrap().session.state,
        SessionState::Closed
    );
    let store = s.take_store().unwrap();
    let mut reader = store.reader().unwrap();
    let q = json!({"version":1,"kind":"query","requestId":"resume:read","seriesIds":["series-0"],"fromMs":receipt.start.at_ms,"toMs":receipt.start.at_ms+10000,"mode":"raw","maxPointsPerSeries":100});
    let raw = reader.query_raw(&q, &control()).unwrap();
    let rows = raw["series"][0]["raw"].as_array().unwrap();
    assert!(rows.iter().any(|r| r["value"] == 43.0));
    assert!(!rows.iter().any(|r| r["value"] == 42.0));
    let mut q = q;
    q["mode"] = json!("minmax");
    assert_eq!(
        reader.query_minmax(&q, &control()).unwrap()["status"],
        "ready"
    );
}
#[tokio::test]
async fn reopened_interrupted_activation_is_diagnosed_and_only_a_new_domain_can_resume() {
    let hub = Hub::new().await;
    let (mut store, dir) = configured();
    let old = store
        .activate_recording_plan(
            &ActivateRecordingPlanRequest {
                activation_id: "old".into(),
                expected_applied_revision: 1,
                expected_mapping_revision: 1,
                expected_retention_applied_revision: 1,
                session_id: "old:session".into(),
                start: ClockStamp {
                    clock_epoch: "old:clock".into(),
                    at_ms: 1000,
                },
            },
            &control(),
        )
        .unwrap();
    drop(store);
    let store = reopen_unowned(&dir);
    let mut s = RecordingSupervisor::try_new(store).unwrap();
    let r = s.start_resume_inspection(control()).unwrap();
    let c = s.join_resume_inspection(&r).await.unwrap();
    assert_eq!(
        c.outcome
            .as_ref()
            .unwrap()
            .latest_activation
            .as_ref()
            .unwrap()
            .session
            .state,
        SessionState::Interrupted
    );
    assert_eq!(
        c.outcome
            .as_ref()
            .unwrap()
            .latest_activation
            .as_ref()
            .unwrap()
            .receipt,
        old
    );
    let ticket = s
        .prepare_resume(
            &r,
            resolution(current_generation(&hub).await, "after:restart"),
        )
        .unwrap();
    let run = s.resume(&ticket, control(), hub.client()).unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    let c = timeout(Duration::from_secs(5), s.join_recording(&run))
        .await
        .unwrap()
        .unwrap();
    closed(&mut socket).await;
    let next = c.activation_receipt.as_ref().unwrap();
    assert_ne!(next.spec.session_id, old.spec.session_id);
    assert_ne!(next.start.clock_epoch, old.start.clock_epoch);
    let mut store = s.take_store().unwrap();
    let prior = store
        .recording_activation("old", &control())
        .unwrap()
        .unwrap();
    assert_eq!(prior.receipt, old);
    assert_eq!(prior.session.state, SessionState::Interrupted);
}
#[tokio::test]
async fn source_generation_change_after_prepare_stops_new_worker_and_inspection_does_not_rearm_it()
{
    let hub = Hub::new().await;
    let (store, _dir) = configured();
    let mut s = RecordingSupervisor::try_new(store).unwrap();
    let r = s.start_resume_inspection(control()).unwrap();
    s.join_resume_inspection(&r).await.unwrap();
    let ticket = s
        .prepare_resume(&r, resolution(current_generation(&hub).await, "changed"))
        .unwrap();
    let run = s.resume(&ticket, control(), hub.client()).unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 4).await;
    let c = timeout(Duration::from_secs(5), s.join_recording(&run))
        .await
        .unwrap()
        .unwrap();
    closed(&mut socket).await;
    assert!(c.activation_receipt.is_some());
    assert!(matches!(
        c.report.as_ref().unwrap().terminal.as_ref().unwrap().cause,
        StopCause::Source(_)
    ));
    let r = s.start_resume_inspection(control()).unwrap();
    assert!(s.join_resume_inspection(&r).await.unwrap().outcome.is_ok());
    assert!(s
        .prepare_resume(&r, resolution(current_generation(&hub).await, "retry"))
        .is_err());
}
