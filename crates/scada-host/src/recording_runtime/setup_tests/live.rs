//! The live delivery of a running recorder against the loopback Hub
//! (historian-live-trend §3.2, L2).
use super::*;
use crate::live_trend::{LiveBreakReason, LiveEvent};
use tokio::sync::mpsc::UnboundedReceiver;

/// The context once the recorder records the applied plan.
async fn live_context(runtime: &RecordingRuntime, project: &Project) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let context = runtime.history_context(project).unwrap().unwrap();
            if context["series"][0].get("live").is_some() {
                return context;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("a live mapping")
}

async fn next(events: &mut UnboundedReceiver<LiveEvent>) -> LiveEvent {
    tokio::time::timeout(Duration::from_secs(15), events.recv())
        .await
        .expect("a live event")
        .expect("the pump runs")
}

#[tokio::test]
async fn the_recorded_ticks_are_delivered_and_a_recreated_tag_ends_the_line() {
    let dir = TempDir::new();
    let hub = Hub::new(&both()).await;
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    let no_plan = project(None);
    let project = project(Some(plan(true)));
    runtime
        .initial_setup(&project, hub.client(), hub.client())
        .await
        .unwrap();
    let context = live_context(&runtime, &project).await;
    let series: Vec<Value> = context["series"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["seriesId"].clone())
        .collect();

    // Another context or namespace is refused: read the context again.
    let request = |context_id: &Value, namespace: &Value| json!({"contextId": context_id, "historianNamespace": namespace, "seriesIds": series});
    let stale = runtime.live_start(
        &project,
        &request(&json!("applied:9"), &context["historianNamespace"]),
    );
    assert_eq!(stale.err(), Some("staleContext"));
    let other = runtime.live_start(&project, &request(&context["contextId"], &json!("other")));
    assert_eq!(other.err(), Some("staleContext"));
    let unknown = runtime.live_start(
        &project,
        &json!({"contextId": context["contextId"], "historianNamespace": context["historianNamespace"],
            "seriesIds": ["no-such-series"]}),
    );
    assert_eq!(unknown.err(), Some("invalidRequest"));
    assert_eq!(
        runtime
            .live_start(
                &no_plan,
                &request(&context["contextId"], &context["historianNamespace"])
            )
            .err(),
        Some("noContext")
    );

    let pump = runtime
        .live_start(
            &project,
            &request(&context["contextId"], &context["historianNamespace"]),
        )
        .unwrap();
    let id = pump.subscription_id().to_owned();
    let (sent, mut events) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(pump.run(move |event| sent.send(event).is_ok()));

    // Three ticks with a good value, each as the recorder stored it.
    let mut batches = Vec::new();
    while batches.len() < 3 {
        match next(&mut events).await {
            event @ LiveEvent::Batch { .. } => {
                let LiveEvent::Batch { items, .. } = &event else {
                    unreachable!()
                };
                if items.iter().all(|i| i.value.is_some()) {
                    batches.push(event);
                }
            }
            LiveEvent::Break { .. } => panic!("no break while recording"),
        }
    }
    let LiveEvent::Batch {
        session_id,
        sequence: last,
        ..
    } = batches[2].clone()
    else {
        unreachable!()
    };
    // Read after the delivery: committed through the delivered sequence.
    let now = setup::now_ms();
    let result = runtime
        .history_query(
            "live",
            json!({"version": 1, "kind": "query", "requestId": "live",
                "seriesIds": series, "fromMs": now - 60_000, "toMs": now + 1000,
                "mode": "raw", "maxPointsPerSeries": 1000}),
        )
        .await
        .unwrap();
    for (n, history) in result["series"].as_array().unwrap().iter().enumerate() {
        let watermark = &history["watermark"];
        assert_eq!(watermark["sessionId"], json!(session_id));
        assert!(watermark["committedThrough"].as_u64().unwrap() >= last);
        let mapping = &context["series"][n];
        for batch in &batches {
            let LiveEvent::Batch {
                session_id,
                sequence,
                items,
                ..
            } = batch
            else {
                unreachable!()
            };
            let item = items
                .iter()
                .find(|i| json!(i.series_id) == history["seriesId"])
                .unwrap();
            assert_eq!(json!(item.segment_id), mapping["live"]["segmentId"]);
            let record = history["raw"]
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["recordId"] == json!({"sessionId": session_id, "sequence": sequence}))
                .expect("the delivered tick is recorded");
            assert_eq!(record["segmentId"], json!(item.segment_id));
            assert_eq!(record["sampleTimeMs"], json!(item.t_ms));
            let value = match &record["value"] {
                Value::Bool(b) => json!(if *b { 1.0 } else { 0.0 }),
                other => other.clone(),
            };
            assert_eq!(value, json!(item.value.unwrap()), "{record}");
            // The Hub's source time stays at 100: the line follows the
            // recorder's observation time.
            assert_eq!(record["sourceTimeMs"], 100);
        }
    }

    // The tags are recreated under the same names: the recorder stops on
    // the pin mismatch, and the line breaks instead of going on.
    hub.recreated.store(true, Ordering::SeqCst);
    let broken = loop {
        match next(&mut events).await {
            LiveEvent::Break {
                series_ids, reason, ..
            } => break (series_ids, reason),
            LiveEvent::Batch { session_id: s, .. } => assert_eq!(s, session_id),
        }
    };
    assert_eq!(broken.1, LiveBreakReason::Session);
    assert_eq!(broken.0.len(), 2);
    // Nothing of the old session after the break.
    let after = tokio::time::timeout(Duration::from_millis(500), events.recv()).await;
    assert!(after.is_err(), "{after:?}");
    let status = recorder_status(runtime.state.as_ref().unwrap()).unwrap();
    assert_eq!(
        status.progress.as_ref().and_then(|p| p.stop_reason.clone()),
        Some(scada_runtime::recording_host::RecordingStopReason::Source(
            "SDK recording identity changed"
        )),
        "{status:?}"
    );
    let context = runtime.history_context(&project).unwrap().unwrap();
    for series in context["series"].as_array().unwrap() {
        assert_eq!(series["liveUnavailable"], "recorderStopped", "{series}");
    }

    runtime.live_stop("live:0");
    assert!(!task.is_finished());
    runtime.live_stop(&id);
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap();
}
