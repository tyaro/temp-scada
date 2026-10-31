//! 実 SDK を loopback のテスト用 Hub に接続する。PLC・実 Hub・利用者の認証情報は使わない。
use std::time::Duration;

use banto_tagclient::{
    CatalogSnapshot, Endpoint, RestClient, SecretApiKey, TagClientConnectionState, TagClientState,
};
use futures_util::{SinkExt, StreamExt};
use scada_model::Project;
use scada_runtime::{project_view, BindingPlan, NumericReading, Quality};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, watch},
    time::timeout,
};
use tokio_tungstenite::{accept_async, tungstenite::Message};

/// A held generation boundary makes old-value invalidation observable without
/// relying on watch retaining every transient state.
#[tokio::test]
async fn partial_binding_waits_recovers_renames_and_restarts_without_old_values() {
    use banto_tagclient::ValuesSnapshot;
    use scada_runtime::{
        read_slot_view, ReadSlotKey, ReadSlotPlan, ReadSlotReading, ReadSlotRequest, ReadSlotType,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    const MISSING: &str = "PLC01.Fast.Missing";
    let mut project: Value =
        serde_json::from_str(include_str!("../../../examples/tag-binding.project.json")).unwrap();
    let mut object = project["screens"][0]["objects"][2].clone();
    object["id"] = json!("0199f000-0000-7000-8000-000000000006");
    object["order"] = json!(6);
    object["shape"]["binding"]["externalName"] = json!(MISSING);
    project["screens"][0]["objects"]
        .as_array_mut()
        .unwrap()
        .push(object);
    let plan = BindingPlan::new(&Project::from_json(&project.to_string()).unwrap());
    let slot_plan = ReadSlotPlan::new(
        "slots".into(),
        1,
        [
            ReadSlotRequest {
                key: ReadSlotKey {
                    equipment_id: "e1".into(),
                    slot_name: "value".into(),
                },
                expected_type: ReadSlotType::Number,
                external_name: Some(TAG.into()),
            },
            ReadSlotRequest {
                key: ReadSlotKey {
                    equipment_id: "e2".into(),
                    slot_name: "optional".into(),
                },
                expected_type: ReadSlotType::Number,
                external_name: None,
            },
        ],
    )
    .unwrap();
    let (advance, mut receive_advance) = mpsc::channel::<()>(1);
    let (started, mut receive_started) = mpsc::channel::<()>(1);
    let server = tokio::spawn(async move {
        // Missing -> created -> renamed away -> original name restored after
        // a Hub run change. Catalog labels deliberately differ from values.
        for step in 0..5 {
            let (mut request, _) = listener.accept().await.unwrap();
            if step > 0 {
                started.send(()).await.unwrap();
                receive_advance.recv().await.unwrap();
            }
            let mut metadata = catalog();
            metadata.revision = 3 + step;
            metadata.run_id = Some(if step == 4 { 8 } else { 7 });
            if step == 1 {
                metadata.tags.clear();
            }
            if step == 3 {
                metadata.tags[0].external_name = format!("{TAG}.Renamed");
            }
            reply(&mut request, serde_json::to_value(&metadata).unwrap()).await;
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            let first: Value =
                serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            let waiting = step == 1 || step == 3;
            if waiting {
                // No empty subscribe is permitted in a tag-waiting generation.
                assert_eq!(first["op"], "ping");
                ws.send(Message::Text(json!({"op":"pong"}).to_string().into()))
                    .await
                    .unwrap();
                let (mut recheck, _) = listener.accept().await.unwrap();
                reply(&mut recheck, serde_json::to_value(&metadata).unwrap()).await;
            } else {
                assert_eq!(first["op"], "subscribe");
                assert_eq!(first["tags"], json!([TAG]));
                ws.send(Message::Text(
                    data(0.0, "good", 100 + step as i64).to_string().into(),
                ))
                .await
                .unwrap();
                let (mut values, _) = listener.accept().await.unwrap();
                let snapshot: ValuesSnapshot = serde_json::from_value(json!({
                    "revision":metadata.revision, "run_id":metadata.run_id, "collection_mode":"configured", "t":100 + step,
                    "values":[{"tag":TAG,"v":0.0,"q":"good","t":100 + step,"value_source":"simulation"}]
                })).unwrap();
                reply(&mut values, serde_json::to_value(snapshot).unwrap()).await;
            }
            receive_advance.recv().await.unwrap();
            if step == 4 {
                ws.send(Message::Close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                    code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Policy,
                    reason: "unauthorized".into(),
                }))).await.unwrap();
            } else {
                ws.send(Message::Text(
                    json!({"op":"config_changed", "revision":metadata.revision + 1})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
            }
        }
    });
    let handle = client(&url).start(plan.requests()).unwrap();
    let mut states = handle.state_watch();
    let mut previous_generation = 0;
    for step in 0..5 {
        let state = wait_state(&mut states, |state| {
            state.snapshot().is_some_and(|s| s.revision() == 3 + step)
        })
        .await;
        let generation = state.snapshot().unwrap();
        assert!(generation.generation > previous_generation);
        previous_generation = generation.generation;
        let view = project_view(&plan, &state);
        let slots = read_slot_view(&slot_plan, &state);
        assert!(view.metadata_ready && slots.metadata_ready);
        assert_eq!(view.readings[MISSING], NumericReading::Unresolved);
        assert_eq!(slots.slots[1].reading, ReadSlotReading::Unassigned);
        if step == 1 || step == 3 {
            assert_eq!(state.connection_state(), TagClientConnectionState::Unbound);
            assert!(state.current().is_none());
            assert_eq!(view.readings[TAG], NumericReading::Unresolved);
            assert_eq!(slots.slots[0].reading, ReadSlotReading::Unresolved);
            assert!(view.provenance.is_empty());
            assert!(slots.slots.iter().all(|slot| slot.provenance.is_none()));
        } else {
            assert_eq!(
                view.readings[TAG],
                NumericReading::Resolved {
                    quality: Quality::Good,
                    numeric_value: Some(0.0)
                }
            );
            assert_eq!(view.provenance[TAG].value_source, "simulation");
            assert_eq!(
                view.provenance[TAG].run_id,
                Some(if step == 4 { 8 } else { 7 })
            );
            assert_eq!(generation.revision(), state.current().unwrap().revision);
        }
        advance.send(()).await.unwrap();
        if step < 4 {
            timeout(Duration::from_secs(3), receive_started.recv())
                .await
                .unwrap()
                .unwrap();
            let state = states.borrow().clone();
            assert!(state.snapshot().is_none());
            let cleared = project_view(&plan, &state);
            assert_eq!(cleared.readings[TAG], NumericReading::Disconnected);
            assert!(cleared.provenance.is_empty());
            advance.send(()).await.unwrap();
        }
    }
    let denied = wait_state(&mut states, |state| {
        state.connection_state() == TagClientConnectionState::Unauthorized
    })
    .await;
    assert!(denied.snapshot().is_none());
    assert!(project_view(&plan, &denied).provenance.is_empty());
    assert_eq!(
        read_slot_view(&slot_plan, &denied).slots[0].reading,
        ReadSlotReading::Disconnected
    );
    // The SDK preserves a terminal credential rejection through shutdown.
    assert!(handle
        .shutdown()
        .await
        .unwrap_err()
        .kind()
        .is_credential_rejection());
    server.await.unwrap();
}

const TAG: &str = "PLC01.Fast.Tank01.Level";
fn catalog() -> CatalogSnapshot {
    serde_json::from_value(json!({
        "revision": 3, "run_id": 7, "collection_mode": "configured",
        "tags": [{"external_name": TAG, "tag_key": "tank-level", "ids": [1,2,3],
            "connection": "PLC01", "group": "Fast", "name": "Tank01.Level", "address": "D100",
            "data_type": "f64", "unit": "%", "decimals": 1, "period_ms": 100,
            "enabled": true, "writable": false, "tag_kind": "tag", "expression": null,
            "retain": false, "simulation": false, "configured_simulation": false,
            "effective_simulation": false, "value_source": "real"}]
    }))
    .unwrap()
}
fn plan() -> BindingPlan {
    BindingPlan::new(
        &Project::from_json(include_str!("../../../examples/tag-binding.project.json")).unwrap(),
    )
}
fn client(url: &str) -> RestClient {
    RestClient::with_request_timeout(
        Endpoint::new(url).unwrap(),
        SecretApiKey::new("local-test-key".into()).unwrap(),
        Duration::from_secs(2),
    )
    .unwrap()
}
async fn reply(stream: &mut TcpStream, body: Value) {
    let mut headers = Vec::new();
    loop {
        let byte = stream.read_u8().await.unwrap();
        headers.push(byte);
        assert!(headers.len() < 16_384);
        if headers.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let request = String::from_utf8(headers).unwrap();
    assert!(request
        .to_lowercase()
        .contains("authorization: bearer local-test-key"));
    assert!(request.starts_with("GET /api/v1/"));
    let body = body.to_string();
    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}
fn data(value: f64, quality: &str, time: i64) -> Value {
    json!({"op":"data", "id":1, "t":time, "values":[{"tag":TAG,"v":value,"q":quality,"t":time}]})
}
async fn wait_state(
    receiver: &mut watch::Receiver<TagClientState>,
    predicate: impl Fn(&TagClientState) -> bool,
) -> TagClientState {
    timeout(Duration::from_secs(3), async {
        loop {
            let state = receiver.borrow_and_update().clone();
            if predicate(&state) {
                return state;
            }
            receiver.changed().await.unwrap();
        }
    })
    .await
    .expect("SDK did not reach the expected state")
}

#[tokio::test]
async fn public_sdk_snapshot_updates_quality_and_disconnects_clear_values() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (updates, mut receive_updates) = mpsc::channel::<Option<Value>>(4);
    let server = tokio::spawn(async move {
        let (mut request, _) = listener.accept().await.unwrap();
        reply(&mut request, serde_json::to_value(catalog()).unwrap()).await;
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = accept_async(stream).await.unwrap();
        let subscription: Value =
            serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(subscription["op"], "subscribe");
        assert_eq!(subscription["tags"], json!([TAG]));
        ws.send(Message::Text(data(12.5, "good", 100).to_string().into()))
            .await
            .unwrap();
        let (mut request, _) = listener.accept().await.unwrap();
        reply(
            &mut request,
            json!({"revision":3,"run_id":7,"collection_mode":"configured","t":100,
            "values":[{"tag":TAG,"v":12.5,"q":"good","t":100,"value_source":"real"}]}),
        )
        .await;
        while let Some(update) = receive_updates.recv().await {
            match update {
                Some(update) => ws
                    .send(Message::Text(update.to_string().into()))
                    .await
                    .unwrap(),
                None => break,
            }
        }
        ws.close(None).await.unwrap();
    });
    let plan = plan();
    let handle = client(&url).start(plan.requests()).unwrap();
    let initial = project_view(&plan, &handle.state());
    assert_eq!(initial.readings[TAG], NumericReading::Disconnected);
    let mut states = handle.state_watch();
    let live = wait_state(&mut states, |s| {
        s.connection_state() == TagClientConnectionState::Live
    })
    .await;
    assert_eq!(
        project_view(&plan, &live).readings[TAG],
        NumericReading::Resolved {
            quality: Quality::Good,
            numeric_value: Some(12.5)
        }
    );
    let generation = live.snapshot().unwrap();
    assert_eq!(
        generation.catalog.revision,
        live.current().unwrap().revision
    );
    assert_eq!(generation.catalog.run_id, live.current().unwrap().run_id);
    updates.send(Some(data(27.0, "good", 101))).await.unwrap();
    let updated = wait_state(&mut states, |s| {
        s.current().is_some_and(|v| v.values[0].v == Some(27.0))
    })
    .await;
    assert_eq!(
        project_view(&plan, &updated).readings[TAG],
        NumericReading::Resolved {
            quality: Quality::Good,
            numeric_value: Some(27.0)
        }
    );
    updates.send(Some(data(27.0, "bad", 102))).await.unwrap();
    let bad = wait_state(&mut states, |s| {
        s.current().is_some_and(|v| v.values[0].q.as_str() == "bad")
    })
    .await;
    assert_eq!(
        project_view(&plan, &bad).readings[TAG],
        NumericReading::Resolved {
            quality: Quality::Bad,
            numeric_value: None
        }
    );
    updates.send(None).await.unwrap();
    let disconnected = wait_state(&mut states, |s| {
        s.connection_state() != TagClientConnectionState::Live
    })
    .await;
    let view = project_view(&plan, &disconnected);
    assert_eq!(view.readings[TAG], NumericReading::Disconnected);
    assert!(view.provenance.is_empty());
    handle.shutdown().await.unwrap();
    server.await.unwrap();
}

/// boolはSDKの実際のf64搬送を通し、同じ要求を複数contextへ配る。
#[tokio::test]
async fn typed_read_context_uses_one_sdk_subscription_and_clears_values_after_disconnect() {
    use scada_runtime::{
        read_slot_view, ReadSlotInvalidReason, ReadSlotKey, ReadSlotPlan, ReadSlotReading,
        ReadSlotRequest, ReadSlotType, ReadSlotValue,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let mut metadata = catalog();
    metadata.tags[0].data_type = "bit".into();
    let server_catalog = metadata.clone();
    let (updates, mut receive_updates) = mpsc::channel::<Option<Value>>(4);
    let server = tokio::spawn(async move {
        let (mut request, _) = listener.accept().await.unwrap();
        reply(&mut request, serde_json::to_value(server_catalog).unwrap()).await;
        let (stream, _) = listener.accept().await.unwrap();
        let mut ws = accept_async(stream).await.unwrap();
        let subscription: Value =
            serde_json::from_str(ws.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(subscription["op"], "subscribe");
        assert_eq!(subscription["tags"], json!([TAG]));
        ws.send(Message::Text(data(1.0, "good", 100).to_string().into()))
            .await
            .unwrap();
        let (mut request, _) = listener.accept().await.unwrap();
        reply(
            &mut request,
            json!({"revision":3,"run_id":7,"collection_mode":"configured","t":100,
            "values":[{"tag":TAG,"v":1.0,"q":"good","t":100,"value_source":"real"}]}),
        )
        .await;
        while let Some(update) = receive_updates.recv().await {
            match update {
                Some(update) => ws
                    .send(Message::Text(update.to_string().into()))
                    .await
                    .unwrap(),
                None => break,
            }
        }
        ws.close(None).await.unwrap();
    });
    let slot = |equipment: &str, name: Option<&str>, expected_type| ReadSlotRequest {
        key: ReadSlotKey {
            equipment_id: equipment.into(),
            slot_name: "running".into(),
        },
        expected_type,
        external_name: name.map(String::from),
    };
    let plan = ReadSlotPlan::new(
        "project".into(),
        7,
        [
            slot("e1", Some(TAG), ReadSlotType::Bool),
            slot("e2", Some(TAG), ReadSlotType::Bool),
            slot("e3", Some(TAG), ReadSlotType::Number),
            slot("e4", None, ReadSlotType::Bool),
        ],
    )
    .unwrap();
    assert_eq!(plan.requests().len(), 1);
    let handle = client(&url).start(plan.requests()).unwrap();
    let initial = read_slot_view(&plan, &handle.state());
    assert_eq!(initial.slots[0].reading, ReadSlotReading::Disconnected);
    assert_eq!(initial.slots[3].reading, ReadSlotReading::Unassigned);
    let mut states = handle.state_watch();
    let live = wait_state(&mut states, |s| {
        s.connection_state() == TagClientConnectionState::Live
    })
    .await;
    let result = read_slot_view(&plan, &live);
    assert!(result.metadata_ready);
    assert_eq!(
        result.slots[0].reading,
        ReadSlotReading::Resolved {
            quality: Quality::Good,
            value: Some(ReadSlotValue::Bool(true))
        }
    );
    assert_eq!(result.slots[0].reading, result.slots[1].reading);
    assert_eq!(
        result.slots[2].reading,
        ReadSlotReading::Invalid {
            reason: ReadSlotInvalidReason::TypeMismatch
        }
    );
    for (time, quality, expected) in [
        (
            101,
            "good",
            ReadSlotReading::Resolved {
                quality: Quality::Good,
                value: Some(ReadSlotValue::Bool(false)),
            },
        ),
        (
            102,
            "stale",
            ReadSlotReading::Resolved {
                quality: Quality::Stale,
                value: None,
            },
        ),
        (
            103,
            "bad",
            ReadSlotReading::Resolved {
                quality: Quality::Bad,
                value: None,
            },
        ),
    ] {
        updates.send(Some(data(0.0, quality, time))).await.unwrap();
        let state = wait_state(&mut states, |s| {
            s.current().is_some_and(|v| v.values[0].t == time)
        })
        .await;
        let result = read_slot_view(&plan, &state);
        assert_eq!(result.slots[0].reading, expected);
        assert_eq!(result.slots[1].reading, expected);
        assert_eq!(
            result.slots[0]
                .provenance
                .as_ref()
                .unwrap()
                .source_timestamp_ms,
            time
        );
    }
    updates.send(None).await.unwrap();
    let disconnected = wait_state(&mut states, |s| {
        s.connection_state() != TagClientConnectionState::Live
    })
    .await;
    let result = read_slot_view(&plan, &disconnected);
    assert_eq!(result.slots[0].reading, ReadSlotReading::Disconnected);
    assert_eq!(result.slots[3].reading, ReadSlotReading::Unassigned);
    assert!(result.slots.iter().all(|slot| slot.provenance.is_none()));
    handle.shutdown().await.unwrap();
    let stopped = read_slot_view(&plan, &states.borrow().clone());
    assert!(stopped
        .slots
        .iter()
        .filter(|slot| slot.external_name.is_some())
        .all(|slot| slot.reading == ReadSlotReading::Disconnected && slot.provenance.is_none()));
    server.await.unwrap();
}
