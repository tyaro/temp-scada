//! The production command owner, Tauri event bus and SDK run against a loopback Hub.
use super::*;
use banto_hub_bootstrap::state::memory::{MemoryKeyStore, MemoryState};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Listener, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};

const KEY: &str = "c2-test-only-read-key";
const NUMBER: &str = "Demo.Number";
const BOOL: &str = "Demo.Bool";

fn catalog() -> Value {
    let tags: Vec<_> = [(NUMBER, "f64", "D100"), (BOOL, "bit", "M1000")]
        .into_iter()
        .enumerate()
        .map(|(index, (name, data_type, address))| {
            json!({
                "external_name": name, "tag_key": name, "ids": [1, 2, index + 1],
                "connection": "PLC01", "group": "Fast", "name": name,
                "address": address, "data_type": data_type, "unit": "",
                "decimals": 0, "period_ms": 100, "enabled": true,
                "writable": false, "tag_kind": "plc", "expression": null,
                "retain": false, "simulation": false, "configured_simulation": false,
                "effective_simulation": false, "value_source": "real"
            })
        })
        .collect();
    json!({"revision": 3, "run_id": 7, "collection_mode": "configured", "tags": tags})
}

fn rows(quality: &str, time: i64) -> Value {
    json!([
        {"tag": NUMBER, "v": 0, "q": quality, "t": time, "value_source": "real"},
        {"tag": BOOL, "v": 0, "q": quality, "t": time, "value_source": "real"}
    ])
}

async fn request(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        bytes.push(stream.read_u8().await.unwrap());
        assert!(bytes.len() < 16_384);
    }
    let request = String::from_utf8(bytes).unwrap();
    assert!(request
        .to_lowercase()
        .contains(&format!("authorization: bearer {KEY}")));
    request
}

async fn reply(stream: &mut TcpStream, body: &Value) {
    let body = body.to_string();
    stream
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
}

struct MockHub {
    url: String,
    sockets: mpsc::UnboundedReceiver<WebSocketStream<TcpStream>>,
    task: JoinHandle<()>,
}

impl MockHub {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (sender, sockets) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let sender = sender.clone();
                tokio::spawn(async move {
                    let mut peek = [0_u8; 1024];
                    let first_line = loop {
                        let n = stream.peek(&mut peek).await.unwrap();
                        if let Some(end) = peek[..n].windows(2).position(|x| x == b"\r\n") {
                            break String::from_utf8_lossy(&peek[..end]).into_owned();
                        }
                    };
                    if first_line.starts_with("GET /api/v1/tags ") {
                        request(&mut stream).await;
                        reply(&mut stream, &catalog()).await;
                    } else if first_line.starts_with("GET /api/v1/values?") {
                        request(&mut stream).await;
                        reply(
                            &mut stream,
                            &json!({
                                "revision": 3, "run_id": 7, "collection_mode": "configured",
                                "t": 100, "values": rows("good", 100)
                            }),
                        )
                        .await;
                    } else {
                        let mut socket = accept_async(stream).await.unwrap();
                        let first: Value = serde_json::from_str(
                            socket.next().await.unwrap().unwrap().to_text().unwrap(),
                        )
                        .unwrap();
                        assert_eq!(first["op"], "subscribe");
                        assert_eq!(first["tags"], json!([BOOL, NUMBER]));
                        socket
                            .send(Message::Text(
                                json!({
                                    "op": "data", "id": 1, "t": 100, "values": rows("good", 100)
                                })
                                .to_string()
                                .into(),
                            ))
                            .await
                            .unwrap();
                        sender.send(socket).unwrap();
                    }
                });
            }
        });
        Self { url, sockets, task }
    }
}

impl Drop for MockHub {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn next_packet(
    receiver: &mut mpsc::UnboundedReceiver<Value>,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    timeout(Duration::from_secs(5), async {
        loop {
            let packet = receiver.recv().await.expect("read event stream ended");
            if predicate(&packet) {
                return packet;
            }
        }
    })
    .await
    .expect("native host did not emit expected state")
}

#[tokio::test]
async fn real_tauri_commands_and_events_reach_mock_hub_and_clear_denied_values() {
    let mut hub = MockHub::start().await;
    let keys = Arc::new(MemoryKeyStore::new());
    let state = Arc::new(MemoryState::new());
    let bootstrap = Bootstrapper::new(
        "temp-scada-test",
        "11111111-2222-4333-8444-555555555555",
        keys.clone(),
        state.clone(),
    );
    let adopted = bootstrap
        .adopt_manual_key(&hub.url, KEY.to_owned())
        .await
        .unwrap();
    assert!(adopted.status.is_connected(), "{:?}", adopted.status);
    let app = tauri::test::mock_builder()
        .manage(NativeHost {
            bootstrap,
            active: Mutex::new(Active::default()),
        })
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let (sender, mut receiver) = mpsc::unbounded_channel();
    app.listen("scada:read", move |event| {
        sender
            .send(serde_json::from_str(event.payload()).unwrap())
            .unwrap();
    });
    let status = hub_connect(app.state(), hub.url.clone()).await.unwrap();
    assert!(status.is_connected());
    let project = include_str!("../../../../examples/read-presentation.project.json").to_owned();
    let catalog = hub_catalog(app.state(), project.clone()).await.unwrap();
    assert_eq!(catalog.tags.len(), 2);
    hub_read_start(app.handle().clone(), app.state(), project, "first".into())
        .await
        .unwrap();
    let mut socket = timeout(Duration::from_secs(5), hub.sockets.recv())
        .await
        .unwrap()
        .unwrap();
    let live = next_packet(&mut receiver, |packet| {
        packet["update"]["text"]["connection"] == "live"
            && packet["update"]["text"]["readings"][NUMBER]["numericValue"] == 0.0
    })
    .await;
    assert_eq!(live["subscriptionId"], "first");
    assert_eq!(
        live["update"]["text"]["readings"][NUMBER]["numericValue"],
        0.0
    );
    assert_eq!(
        live["update"]["slots"]["slots"][1]["reading"]["value"]["value"],
        false
    );
    assert!(!live.to_string().contains(KEY));
    for (time, quality) in [(101, "bad"), (102, "stale")] {
        socket
            .send(Message::Text(
                json!({
                    "op": "data", "id": 1, "t": time, "values": rows(quality, time)
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();
        let update = next_packet(&mut receiver, |packet| {
            packet["update"]["text"]["readings"][NUMBER]["quality"] == quality
        })
        .await;
        assert_eq!(
            update["update"]["text"]["readings"][NUMBER]["quality"],
            quality
        );
        assert!(update["update"]["text"]["readings"][NUMBER]["numericValue"].is_null());
    }
    socket
        .send(Message::Close(Some(
            tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Policy,
                reason: "unauthorized".into(),
            },
        )))
        .await
        .unwrap();
    let denied = next_packet(&mut receiver, |packet| {
        packet["update"]["text"]["connection"] == "unauthorized"
    })
    .await;
    assert_eq!(
        denied["update"]["text"]["readings"][NUMBER]["state"],
        "disconnected"
    );
    hub_disconnect(app.state()).await.unwrap();
    assert!(app
        .state::<NativeHost>()
        .active
        .lock()
        .await
        .owner
        .is_none());
    drop(app);

    // A new native owner reuses the protected key and starts with no old stream.
    let restarted = tauri::test::mock_builder()
        .manage(NativeHost {
            bootstrap: Bootstrapper::new(
                "temp-scada-test",
                "11111111-2222-4333-8444-555555555555",
                keys,
                state,
            ),
            active: Mutex::new(Active::default()),
        })
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let (sender, mut receiver) = mpsc::unbounded_channel();
    restarted.listen("scada:read", move |event| {
        sender
            .send(serde_json::from_str(event.payload()).unwrap())
            .unwrap();
    });
    assert!(hub_connect(restarted.state(), hub.url.clone())
        .await
        .unwrap()
        .is_connected());
    hub_read_start(
        restarted.handle().clone(),
        restarted.state(),
        include_str!("../../../../examples/read-presentation.project.json").into(),
        "restarted".into(),
    )
    .await
    .unwrap();
    let _socket = timeout(Duration::from_secs(5), hub.sockets.recv())
        .await
        .unwrap()
        .unwrap();
    let live = next_packet(&mut receiver, |packet| {
        packet["subscriptionId"] == "restarted" && packet["update"]["text"]["connection"] == "live"
    })
    .await;
    assert_eq!(
        live["update"]["text"]["readings"][NUMBER]["numericValue"],
        0.0
    );
    hub_read_stop(restarted.state(), "restarted".into())
        .await
        .unwrap();
    assert!(restarted
        .state::<NativeHost>()
        .active
        .lock()
        .await
        .owner
        .is_none());
}
