//! P2 owner tests use only an ephemeral loopback Hub and a test-only key.
use std::sync::Arc;
use std::time::Duration;

use banto_tagclient::{Endpoint, ErrorKind, RestClient, SecretApiKey};
use futures_util::{FutureExt, SinkExt, StreamExt};
use scada_model::Project;
use scada_runtime::{
    NumericReading, Quality, ReadHost, ReadHostError, ReadHostFrame, ReadSlotReading, ReadSlotValue,
};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
    time::timeout,
};
use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};

const TAG: &str = "PLC01.Fast.Tank01.Level";
const OTHER: &str = "PLC01.Fast.Other";
const KEY: &str = "read-host-test-only-key";

fn project(name: Option<&str>) -> Project {
    let mut project: Value =
        serde_json::from_str(include_str!("../../../examples/equipment.project.json")).unwrap();
    if let Some(name) = name {
        project["screens"][0]["objects"][2]["shape"]["binding"] = json!({"externalName": name});
        project["equipment"][0]["bindings"] = json!([
            {"slotName":"current", "externalName":name},
            {"slotName":"running", "externalName":null}
        ]);
        let mut second = project["equipment"][0].clone();
        second["id"] = json!("0199f700-0000-7000-8000-000000000003");
        second["code"] = json!("FAN-102");
        project["equipment"].as_array_mut().unwrap().push(second);
    }
    Project::from_json(&project.to_string()).unwrap()
}

fn client(url: &str) -> RestClient {
    RestClient::with_request_timeout(
        Endpoint::new(url).unwrap(),
        SecretApiKey::new(KEY.into()).unwrap(),
        Duration::from_secs(2),
    )
    .unwrap()
}

struct Hub {
    listener: TcpListener,
    url: String,
}

impl Hub {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        Self { listener, url }
    }

    /// Confirms one unique subscribe for Text and multiple adopted slots.
    /// An empty catalog must produce ping/pong + recheck, never subscribe [].
    async fn serve(&self, names: &[&str], value: f64) -> WebSocketStream<TcpStream> {
        timeout(Duration::from_secs(5), async {
            let tags: Vec<_> = names.iter().enumerate().map(|(index, name)| json!({
                "external_name":name,"tag_key":name,"ids":[1,2,index+1],
                "connection":"PLC01","group":"Fast","name":name,"address":"D100",
                "data_type":"f64","unit":"%","decimals":1,"period_ms":100,
                "enabled":true,"writable":false,"tag_kind":"plc","expression":null,
                "retain":false,"simulation":false,"configured_simulation":false,
                "effective_simulation":false,"value_source":"real"
            })).collect();
            let catalog = json!({"revision":3,"run_id":7,"collection_mode":"configured","tags":tags});
            let (mut stream, _) = self.listener.accept().await.unwrap();
            assert!(request(&mut stream).await.starts_with("GET /api/v1/tags "));
            reply(&mut stream, &catalog).await;
            let (stream, _) = self.listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            let first: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            if names.is_empty() {
                assert_eq!(first["op"], "ping");
                socket.send(Message::Text(json!({"op":"pong"}).to_string().into())).await.unwrap();
                let (mut stream, _) = self.listener.accept().await.unwrap();
                assert!(request(&mut stream).await.starts_with("GET /api/v1/tags "));
                reply(&mut stream, &catalog).await;
            } else {
                assert_eq!(first["op"], "subscribe");
                assert_eq!(first["tags"], json!(names));
                let rows: Vec<_> = names.iter().map(|name| json!({"tag":name,"v":value,"q":"good","t":100,"value_source":"real"})).collect();
                socket.send(Message::Text(json!({"op":"data","id":1,"t":100,"values":rows}).to_string().into())).await.unwrap();
                let (mut stream, _) = self.listener.accept().await.unwrap();
                assert!(request(&mut stream).await.starts_with("GET /api/v1/values?tags="));
                reply(&mut stream, &json!({"revision":3,"run_id":7,"collection_mode":"configured","t":100,"values":rows})).await;
            }
            socket
        }).await.expect("Host must establish a local SDK subscription")
    }

    async fn assert_no_request(&self) {
        assert!(timeout(Duration::from_millis(100), self.listener.accept())
            .await
            .is_err());
    }
}

async fn request(stream: &mut TcpStream) -> String {
    let mut headers = Vec::new();
    while !headers.ends_with(b"\r\n\r\n") {
        headers.push(stream.read_u8().await.unwrap());
        assert!(headers.len() < 16_384);
    }
    let request = String::from_utf8(headers).unwrap();
    assert!(request
        .to_lowercase()
        .contains(&format!("authorization: bearer {KEY}")));
    request
}

async fn reply(stream: &mut TcpStream, body: &Value) {
    let body = body.to_string();
    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
}

async fn closed(socket: &mut WebSocketStream<TcpStream>) {
    timeout(Duration::from_secs(3), async {
        let message = socket.next().await;
        assert!(
            matches!(message, None | Some(Ok(Message::Close(_))) | Some(Err(_))),
            "old connection must close: {message:?}"
        );
        let _ = socket.flush().await;
    })
    .await
    .expect("old SDK owner must close its socket");
}

async fn wait_frame(
    frames: &mut watch::Receiver<Arc<ReadHostFrame>>,
    predicate: impl Fn(&ReadHostFrame) -> bool,
) -> Arc<ReadHostFrame> {
    timeout(Duration::from_secs(5), async {
        loop {
            let frame = frames.borrow_and_update().clone();
            if predicate(&frame) {
                return frame;
            }
            frames.changed().await.unwrap();
        }
    })
    .await
    .expect("Host must publish the expected frame")
}

fn assert_empty(frame: &ReadHostFrame) {
    assert!(frame.text.provenance.is_empty());
    assert!(frame
        .text
        .readings
        .values()
        .all(|reading| !matches!(reading, NumericReading::Resolved { .. })));
    assert!(frame
        .slots
        .slots
        .iter()
        .all(|slot| slot.provenance.is_none()
            && !matches!(slot.reading, ReadSlotReading::Resolved { .. })));
    assert_eq!(frame.sdk_generation, None);
}

#[tokio::test]
async fn one_subscription_fans_out_and_sdk_quality_disconnect_and_stop_clear_both_views() {
    let project = project(Some(TAG));
    let hub = Hub::new().await;
    let mut host = ReadHost::new(&project).unwrap();
    let mut frames = host.state_watch();
    assert_empty(&frames.borrow());
    let session = host
        .replace(&project, Some(client(&hub.url)))
        .await
        .unwrap()
        .session;
    let mut socket = hub.serve(&[TAG], 0.0).await;
    let live = wait_frame(&mut frames, |frame| frame.text.connection == "live").await;
    assert!(host.is_current(live.session()));
    assert_eq!(live.session(), &session);
    assert!(live.sdk_generation.is_some());
    assert_eq!(
        live.text.readings[TAG],
        NumericReading::Resolved {
            quality: Quality::Good,
            numeric_value: Some(0.0)
        }
    );
    for row in [0, 2] {
        assert_eq!(
            live.slots.slots[row].reading,
            ReadSlotReading::Resolved {
                quality: Quality::Good,
                value: Some(ReadSlotValue::Number(0.0))
            }
        );
        assert_eq!(
            live.slots.slots[row].provenance.as_ref().unwrap(),
            &live.text.provenance[TAG]
        );
    }
    assert_eq!(live.slots.slots[1].reading, ReadSlotReading::Unassigned);
    for (time, quality) in [(101, "bad"), (102, "stale")] {
        socket.send(Message::Text(json!({"op":"data","id":1,"t":time,"values":[{"tag":TAG,"v":999,"q":quality,"t":time}]}).to_string().into())).await.unwrap();
        let frame = wait_frame(&mut frames, |frame| {
            frame
                .text
                .provenance
                .get(TAG)
                .is_some_and(|p| p.source_timestamp_ms == time)
        })
        .await;
        assert!(matches!(
            frame.text.readings[TAG],
            NumericReading::Resolved {
                numeric_value: None,
                ..
            }
        ));
        assert!(matches!(
            frame.slots.slots[0].reading,
            ReadSlotReading::Resolved { value: None, .. }
        ));
    }
    // No additional connection is made for extra contexts or source updates.
    hub.assert_no_request().await;
    socket.close(None).await.unwrap();
    let disconnected = wait_frame(&mut frames, |frame| frame.text.connection != "live").await;
    assert_empty(&disconnected);
    assert_eq!(
        disconnected.slots.slots[1].reading,
        ReadSlotReading::Unassigned
    );
    host.stop().await.unwrap();
    assert!(!host.is_current(&session));
    assert_empty(&host.state());
}

#[tokio::test]
async fn zero_requests_and_explicit_disconnection_do_not_start_sdk_network_work() {
    let hub = Hub::new().await;
    let project = project(None);
    let mut host = ReadHost::new(&project).unwrap();
    let first = host.state().session().clone();
    let transition = host
        .replace(&project, Some(client(&hub.url)))
        .await
        .unwrap();
    assert_ne!(first, transition.session);
    assert_eq!(
        host.state().slots.slots[0].reading,
        ReadSlotReading::Unassigned
    );
    assert_empty(&host.state());
    hub.assert_no_request().await;
    host.replace(&self::project(Some(TAG)), None).await.unwrap();
    assert_eq!(
        host.state().text.readings[TAG],
        NumericReading::Disconnected
    );
    hub.assert_no_request().await;
}

#[tokio::test]
async fn text_and_slot_only_names_share_one_subscription_without_dropping_either_plan() {
    let mut value: Value = serde_json::from_str(&project(Some(TAG)).to_json()).unwrap();
    for equipment in value["equipment"].as_array_mut().unwrap() {
        equipment["bindings"][0]["externalName"] = json!(OTHER);
    }
    let project = Project::from_json(&value.to_string()).unwrap();
    let hub = Hub::new().await;
    let mut host = ReadHost::new(&project).unwrap();
    let mut frames = host.state_watch();
    host.replace(&project, Some(client(&hub.url)))
        .await
        .unwrap();
    let mut socket = hub.serve(&[OTHER, TAG], 7.0).await;
    let frame = wait_frame(&mut frames, |frame| frame.text.connection == "live").await;
    assert_eq!(frame.text.readings.len(), 1);
    assert!(matches!(
        frame.text.readings[TAG],
        NumericReading::Resolved {
            numeric_value: Some(7.0),
            ..
        }
    ));
    assert_eq!(frame.slots.slots[0].external_name.as_deref(), Some(OTHER));
    assert!(matches!(
        frame.slots.slots[0].reading,
        ReadSlotReading::Resolved {
            value: Some(ReadSlotValue::Number(7.0)),
            ..
        }
    ));
    let (stop, ()) = tokio::join!(host.stop(), closed(&mut socket));
    stop.unwrap();
}

#[tokio::test]
async fn identical_project_identity_gets_new_session_and_replacement_uses_new_requests() {
    let old_project = project(Some(TAG));
    let new_project = project(Some(OTHER));
    assert_eq!(old_project.id(), new_project.id());
    assert_eq!(old_project.revision(), new_project.revision());
    let hub = Hub::new().await;
    let mut host = ReadHost::new(&old_project).unwrap();
    let mut frames = host.state_watch();
    host.replace(&old_project, Some(client(&hub.url)))
        .await
        .unwrap();
    let mut old_socket = hub.serve(&[TAG], 12.0).await;
    let old_frame = wait_frame(&mut frames, |frame| frame.text.connection == "live").await;
    let (transition, ()) = tokio::join!(
        host.replace(&new_project, Some(client(&hub.url))),
        closed(&mut old_socket)
    );
    let transition = transition.unwrap();
    assert!(!host.is_current(old_frame.session()));
    assert_ne!(old_frame.session(), &transition.session);
    assert_empty(&host.state());
    assert!(!host.state().text.readings.contains_key(TAG));
    let mut new_socket = hub.serve(&[OTHER], 42.0).await;
    let new_frame = wait_frame(&mut frames, |frame| frame.text.connection == "live").await;
    assert_eq!(new_frame.session(), &transition.session);
    assert_eq!(
        new_frame.text.readings[OTHER],
        NumericReading::Resolved {
            quality: Quality::Good,
            numeric_value: Some(42.0)
        }
    );
    let (stop, ()) = tokio::join!(host.stop(), closed(&mut new_socket));
    stop.unwrap();
}

#[tokio::test]
async fn endpoint_replacement_closes_old_owner_before_starting_new_hub() {
    let project = project(Some(TAG));
    let first = Hub::new().await;
    let second = Hub::new().await;
    let mut host = ReadHost::new(&project).unwrap();
    let mut frames = host.state_watch();
    host.replace(&project, Some(client(&first.url)))
        .await
        .unwrap();
    let mut old_socket = first.serve(&[TAG], 12.0).await;
    let old = wait_frame(&mut frames, |frame| frame.text.connection == "live").await;
    let (transition, ()) = tokio::join!(
        host.replace(&project, Some(client(&second.url))),
        closed(&mut old_socket)
    );
    assert!(transition.unwrap().previous_error.is_none());
    assert_empty(&host.state());
    assert!(!host.is_current(old.session()));
    let mut new_socket = second.serve(&[TAG], 55.0).await;
    let frame = wait_frame(&mut frames, |frame| frame.text.connection == "live").await;
    assert_eq!(
        frame.text.readings[TAG],
        NumericReading::Resolved {
            quality: Quality::Good,
            numeric_value: Some(55.0)
        }
    );
    let wire =
        serde_json::to_string(&frame.text).unwrap() + &serde_json::to_string(&frame.slots).unwrap();
    assert!(!wire.contains(KEY) && !wire.contains(&first.url) && !wire.contains(&second.url));
    let (stop, ()) = tokio::join!(host.stop(), closed(&mut new_socket));
    stop.unwrap();
    first.assert_no_request().await;
}

#[tokio::test]
async fn cancelled_replace_invalidates_before_await_and_never_starts_the_new_connection() {
    let project = project(Some(TAG));
    let first = Hub::new().await;
    let second = Hub::new().await;
    let mut host = ReadHost::new(&project).unwrap();
    let mut frames = host.state_watch();
    host.replace(&project, Some(client(&first.url)))
        .await
        .unwrap();
    let mut socket = first.serve(&[TAG], 12.0).await;
    let live = wait_frame(&mut frames, |frame| frame.text.connection == "live").await;
    let mut replace = Box::pin(host.replace(&project, Some(client(&second.url))));
    assert!(futures_util::poll!(&mut replace).is_pending());
    assert_empty(&frames.borrow());
    assert_ne!(frames.borrow().session(), live.session());
    drop(replace);
    assert_empty(&host.state());
    assert!(!host.is_current(live.session()));
    closed(&mut socket).await;
    second.assert_no_request().await;
    // An explicit later replace remains usable after cancellation.
    host.replace(&project, Some(client(&second.url)))
        .await
        .unwrap();
    let mut resumed = second.serve(&[TAG], 20.0).await;
    wait_frame(&mut frames, |frame| frame.text.connection == "live").await;
    let (stop, ()) = tokio::join!(host.stop(), closed(&mut resumed));
    stop.unwrap();
}

#[tokio::test]
async fn cancelled_stop_and_owner_drop_leave_stopped_frames_and_close_the_socket() {
    let project = project(Some(TAG));
    let hub = Hub::new().await;
    let mut host = ReadHost::new(&project).unwrap();
    let mut frames = host.state_watch();
    host.replace(&project, Some(client(&hub.url)))
        .await
        .unwrap();
    let mut socket = hub.serve(&[TAG], 12.0).await;
    let live = wait_frame(&mut frames, |frame| frame.text.connection == "live").await;
    let mut stop = Box::pin(host.stop());
    assert!(futures_util::poll!(&mut stop).is_pending());
    assert_empty(&frames.borrow());
    drop(stop);
    closed(&mut socket).await;
    assert!(!host.is_current(live.session()));
    host.replace(&project, Some(client(&hub.url)))
        .await
        .unwrap();
    let mut socket = hub.serve(&[TAG], 33.0).await;
    let live = wait_frame(&mut frames, |frame| frame.text.connection == "live").await;
    drop(host);
    assert_empty(&frames.borrow());
    assert_ne!(frames.borrow().session(), live.session());
    closed(&mut socket).await;
}

#[tokio::test]
async fn tag_waiting_and_terminal_denial_are_preserved_and_do_not_block_explicit_replacement() {
    let project = project(Some(TAG));
    let first = Hub::new().await;
    let second = Hub::new().await;
    let mut host = ReadHost::new(&project).unwrap();
    let mut frames = host.state_watch();
    host.replace(&project, Some(client(&first.url)))
        .await
        .unwrap();
    let mut socket = first.serve(&[], 0.0).await;
    let waiting = wait_frame(&mut frames, |frame| frame.text.connection == "unbound").await;
    assert_eq!(waiting.text.readings[TAG], NumericReading::Unresolved);
    assert_eq!(waiting.slots.slots[0].reading, ReadSlotReading::Unresolved);
    assert!(waiting.text.metadata_ready && waiting.slots.metadata_ready);
    assert!(waiting.text.provenance.is_empty());
    socket
        .send(Message::Close(Some(
            tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Policy,
                reason: "unauthorized".into(),
            },
        )))
        .await
        .unwrap();
    let denied = wait_frame(&mut frames, |frame| frame.text.connection == "unauthorized").await;
    assert_empty(&denied);
    assert!(denied.text.last_error.is_some());
    let transition = host
        .replace(&project, Some(client(&second.url)))
        .await
        .unwrap();
    assert!(transition.previous_error.unwrap().is_credential_rejection());
    assert!(host.state().text.last_error.is_none());
    let mut socket = second.serve(&[TAG], 1.0).await;
    wait_frame(&mut frames, |frame| frame.text.connection == "live").await;
    let (stop, ()) = tokio::join!(host.stop(), closed(&mut socket));
    stop.unwrap();
}

#[test]
fn start_failure_outside_runtime_returns_a_stable_error_and_keeps_new_session_empty() {
    let project = project(Some(TAG));
    let mut host = ReadHost::new(&project).unwrap();
    let initial = host.state().session().clone();
    let result = host
        .replace(&project, Some(client("http://127.0.0.1:1")))
        .now_or_never()
        .unwrap();
    assert!(matches!(
        result,
        Err(ReadHostError::Start(ErrorKind::Transport))
    ));
    assert!(!host.is_current(&initial));
    assert_empty(&host.state());
    assert_eq!(
        host.state().text.last_error.as_deref(),
        Some(ErrorKind::Transport.as_str())
    );
}

#[tokio::test]
async fn cancelling_stop_while_sdk_waits_for_close_ack_drops_the_sdk_owner() {
    let project = project(Some(TAG));
    let hub = Hub::new().await;
    let mut host = ReadHost::new(&project).unwrap();
    let mut frames = host.state_watch();
    host.replace(&project, Some(client(&hub.url)))
        .await
        .unwrap();
    let mut socket = hub.serve(&[TAG], 12.0).await;
    wait_frame(&mut frames, |frame| frame.text.connection == "live").await;
    let mut stop = Box::pin(host.stop());
    let close = tokio::select! {
        biased;
        message = socket.next() => message,
        result = &mut stop => panic!("SDK must wait for the peer close ack: {result:?}"),
    };
    assert!(matches!(close, Some(Ok(Message::Close(_)))));
    assert_empty(&frames.borrow());
    // No flush/ack: cancellation now drops the SDK shutdown future itself,
    // rather than the earlier pump-join future tested above.
    drop(stop);
    assert_empty(&host.state());
    hub.assert_no_request().await;
}

#[tokio::test]
async fn drop_during_catalog_request_aborts_sdk_without_leaving_an_orphan_connection() {
    let project = project(Some(TAG));
    let hub = Hub::new().await;
    let mut host = ReadHost::new(&project).unwrap();
    let frames = host.state_watch();
    host.replace(&project, Some(client(&hub.url)))
        .await
        .unwrap();
    let (mut stream, _) = timeout(Duration::from_secs(3), hub.listener.accept())
        .await
        .unwrap()
        .unwrap();
    request(&mut stream).await;
    drop(host);
    assert_empty(&frames.borrow());
    let read = timeout(Duration::from_secs(1), stream.read_u8())
        .await
        .expect("SDK must abort immediately, before its request timeout");
    assert_eq!(read.unwrap_err().kind(), std::io::ErrorKind::UnexpectedEof);
    hub.assert_no_request().await;
}

#[tokio::test]
async fn explicit_stop_preserves_a_terminal_sdk_error_but_never_retains_its_values() {
    let project = project(Some(TAG));
    let hub = Hub::new().await;
    let mut host = ReadHost::new(&project).unwrap();
    let mut frames = host.state_watch();
    host.replace(&project, Some(client(&hub.url)))
        .await
        .unwrap();
    let mut socket = hub.serve(&[TAG], 7.0).await;
    let live = wait_frame(&mut frames, |frame| frame.text.connection == "live").await;
    socket
        .send(Message::Close(Some(
            tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Policy,
                reason: "unauthorized".into(),
            },
        )))
        .await
        .unwrap();
    wait_frame(&mut frames, |frame| frame.text.connection == "unauthorized").await;
    let error = host.stop().await.unwrap_err();
    assert!(error.is_credential_rejection());
    assert!(!host.is_current(live.session()));
    assert_empty(&host.state());
    assert_eq!(
        host.state().text.last_error.as_deref(),
        Some(error.as_str())
    );
}
