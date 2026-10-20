//! 実 SDK を loopback のテスト用 Hub に接続する。PLC・実 Hub・利用者の認証情報は使わない。
use std::time::Duration;

use banto_tagclient::{
    CatalogSnapshot, Endpoint, ErrorKind, RestClient, SecretApiKey, TagClientConnectionState,
    TagClientState,
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
    let initial = project_view(&plan, &handle.state(), None);
    assert_eq!(initial.readings[TAG], NumericReading::Disconnected);
    let mut states = handle.state_watch();
    let live = wait_state(&mut states, |s| {
        s.connection_state() == TagClientConnectionState::Live
    })
    .await;
    assert_eq!(
        project_view(&plan, &live, Some(&catalog())).readings[TAG],
        NumericReading::Resolved {
            quality: Quality::Good,
            numeric_value: Some(12.5)
        }
    );
    // catalog 未取得・世代不一致なら SDK が Live でも値を表示しない。
    assert_eq!(
        project_view(&plan, &live, None).readings[TAG],
        NumericReading::Invalid
    );
    let mut old_catalog = catalog();
    old_catalog.run_id = Some(6);
    assert_eq!(
        project_view(&plan, &live, Some(&old_catalog)).readings[TAG],
        NumericReading::Invalid
    );
    updates.send(Some(data(27.0, "good", 101))).await.unwrap();
    let updated = wait_state(&mut states, |s| {
        s.current().is_some_and(|v| v.values[0].v == Some(27.0))
    })
    .await;
    assert_eq!(
        project_view(&plan, &updated, Some(&catalog())).readings[TAG],
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
        project_view(&plan, &bad, Some(&catalog())).readings[TAG],
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
    let view = project_view(&plan, &disconnected, Some(&catalog()));
    assert_eq!(view.readings[TAG], NumericReading::Disconnected);
    assert!(view.provenance.is_empty());
    handle.shutdown().await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn pinned_sdk_unresolved_request_blocks_the_entire_subscription() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut request, _) = listener.accept().await.unwrap();
        reply(&mut request, serde_json::to_value(catalog()).unwrap()).await;
    });
    let mut requests = plan().requests();
    requests.push(banto_tagclient::BindingRequest {
        binding_key: "missing".into(),
        external_name: "PLC01.Fast.Missing".into(),
    });
    let handle = client(&url).start(requests).unwrap();
    let mut states = handle.state_watch();
    let state = wait_state(&mut states, |s| {
        s.last_error() == Some(ErrorKind::BindingUnresolved)
    })
    .await;
    assert_eq!(
        state.connection_state(),
        TagClientConnectionState::Rebinding
    );
    assert!(
        state.current().is_none(),
        "Even the valid tag has no current snapshot; host integration needs an SDK decision"
    );
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
    let initial = read_slot_view(&plan, &handle.state(), None);
    assert_eq!(initial.slots[0].reading, ReadSlotReading::Disconnected);
    assert_eq!(initial.slots[3].reading, ReadSlotReading::Unassigned);
    let mut states = handle.state_watch();
    let live = wait_state(&mut states, |s| {
        s.connection_state() == TagClientConnectionState::Live
    })
    .await;
    let result = read_slot_view(&plan, &live, Some(&metadata));
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
    assert_eq!(
        read_slot_view(&plan, &live, None).slots[0].reading,
        ReadSlotReading::Invalid {
            reason: ReadSlotInvalidReason::MetadataUnavailable
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
        let result = read_slot_view(&plan, &state, Some(&metadata));
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
    let result = read_slot_view(&plan, &disconnected, Some(&metadata));
    assert_eq!(result.slots[0].reading, ReadSlotReading::Disconnected);
    assert_eq!(result.slots[3].reading, ReadSlotReading::Unassigned);
    assert!(result.slots.iter().all(|slot| slot.provenance.is_none()));
    handle.shutdown().await.unwrap();
    let stopped = read_slot_view(&plan, &states.borrow().clone(), Some(&metadata));
    assert!(stopped
        .slots
        .iter()
        .filter(|slot| slot.external_name.is_some())
        .all(|slot| slot.reading == ReadSlotReading::Disconnected && slot.provenance.is_none()));
    server.await.unwrap();
}
