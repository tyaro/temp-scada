//! Shared disposable SDK Hub fixture for source and host integration tests.
use banto_tagclient::{CollectionMode, Endpoint, RestClient, SecretApiKey, StableTagId};
use futures_util::{SinkExt, StreamExt};
use scada_historian::{
    recorder::SnapshotSource,
    store::{IdentityDescriptor, SessionSpec, Source, TickObservation, ValueType},
};
use scada_runtime::recorder_source::{
    SdkBindingPin, SdkGenerationPin, SdkRecorderPlan, SdkRecorderSource,
};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::{sleep, timeout},
};
use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};

pub(super) const NUMBER: &str = "PLC01.Fast.Tank01.Level";
pub(super) const BOOL: &str = "PLC01.Fast.Running";
pub(super) const MISSING: &str = "PLC01.Fast.Missing";
pub(super) const KEY: &str = "recorder-source-test-only-key";

pub(super) fn plan(run_id: Option<u64>, source: Source, full: bool) -> SdkRecorderPlan {
    let names = if full {
        vec![NUMBER, BOOL, MISSING]
    } else {
        vec![NUMBER]
    };
    let members = names
        .iter()
        .enumerate()
        .map(|(i, name)| IdentityDescriptor {
            series_id: format!("series-{i}"),
            hub_instance_id: "test-hub".into(),
            incarnation_id: format!("life-{i}"),
            external_name: (*name).into(),
            segment_id: "segment-a".into(),
            value_type: if *name == BOOL {
                ValueType::Bool
            } else {
                ValueType::Number
            },
            unit: (*name == NUMBER).then(|| "%".into()),
            period_ms: 1000,
            source,
        })
        .collect();
    let bindings = names
        .iter()
        .enumerate()
        .map(|(i, name)| SdkBindingPin {
            series_id: format!("series-{i}"),
            stable_id: StableTagId::new(1, 2, i as i64 + 1),
            tag_key: (*name).into(),
            data_type: if *name == BOOL { "bit" } else { "f64" }.into(),
        })
        .collect();
    SdkRecorderPlan::new(
        SessionSpec {
            session_id: "recording".into(),
            members,
        },
        SdkGenerationPin {
            catalog_revision: 3,
            run_id,
            collection_mode: CollectionMode::Configured,
        },
        bindings,
    )
    .unwrap()
}

pub(super) struct Hub {
    pub(super) listener: TcpListener,
    url: String,
}
impl Hub {
    pub(super) async fn serve_unbound(&self) -> WebSocketStream<TcpStream> {
        timeout(Duration::from_secs(5), async {
            let catalog = json!({"revision":3,"run_id":7,"collection_mode":"configured","tags":[]});
            let (mut stream, _) = self.listener.accept().await.unwrap();
            assert!(request(&mut stream).await.starts_with("GET /api/v1/tags "));
            reply(&mut stream, 200, &catalog).await;
            let (stream, _) = self.listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            let first: Value =
                serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap())
                    .unwrap();
            assert_eq!(first["op"], "ping");
            socket
                .send(Message::Text(json!({"op":"pong"}).to_string().into()))
                .await
                .unwrap();
            let (mut stream, _) = self.listener.accept().await.unwrap();
            assert!(request(&mut stream).await.starts_with("GET /api/v1/tags "));
            reply(&mut stream, 200, &catalog).await;
            socket
        })
        .await
        .expect("unbound local SDK")
    }
    pub(super) async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        Self {
            url: format!("http://{}", listener.local_addr().unwrap()),
            listener,
        }
    }
    pub(super) fn client(&self) -> RestClient {
        RestClient::with_request_timeout(
            Endpoint::new(&self.url).unwrap(),
            SecretApiKey::new(KEY.into()).unwrap(),
            Duration::from_secs(2),
        )
        .unwrap()
    }
    pub(super) async fn serve(
        &self,
        full: bool,
        run: Option<u64>,
        source: &str,
        revision: u64,
    ) -> WebSocketStream<TcpStream> {
        timeout(Duration::from_secs(5), async {
            let names = if full {vec![NUMBER,BOOL]} else {vec![NUMBER]};
            let tags:Vec<_> = names.iter().enumerate().map(|(i,name)| json!({
                "external_name":name,"tag_key":name,"ids":[1,2,i+1],
                "connection":"PLC01","group":"Fast","name":name,"address":"D100",
                "data_type":if *name == BOOL {"bit"} else {"f64"},
                "unit":if *name == NUMBER {Some("%")} else {None},
                "decimals":1,"period_ms":100,"enabled":true,"writable":false,"tag_kind":"plc","expression":null,
                "retain":false,"simulation":false,"configured_simulation":false,"effective_simulation":false,"value_source":"real"
            })).collect();
            let (mut stream,_) = self.listener.accept().await.unwrap();
            assert!(request(&mut stream).await.starts_with("GET /api/v1/tags "));
            reply(&mut stream,200,&json!({"revision":revision,"run_id":run,"collection_mode":"configured","tags":tags})).await;
            let (stream,_) = self.listener.accept().await.unwrap();
            let mut socket = accept_async(stream).await.unwrap();
            let first:Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            assert_eq!(first["op"],"subscribe");
            let mut requested:Vec<_> = first["tags"].as_array().unwrap().iter().map(|v|v.as_str().unwrap()).collect();
            requested.sort_unstable(); let mut expected = names.clone(); expected.sort_unstable();
            assert_eq!(requested, expected);
            let rows:Vec<_> = names.iter().map(|name|json!({"tag":name,"v":0,"q":"good","t":100,"value_source":source})).collect();
            socket.send(Message::Text(json!({"op":"data","id":1,"t":100,"values":rows}).to_string().into())).await.unwrap();
            let (mut stream,_) = self.listener.accept().await.unwrap();
            assert!(request(&mut stream).await.starts_with("GET /api/v1/values?tags="));
            reply(&mut stream,200,&json!({"revision":revision,"run_id":run,"collection_mode":"configured","t":100,"values":rows})).await;
            socket
        }).await.expect("local SDK subscription")
    }
}
pub(super) async fn request(stream: &mut TcpStream) -> String {
    let mut headers = vec![];
    while !headers.ends_with(b"\r\n\r\n") {
        headers.push(stream.read_u8().await.unwrap());
        assert!(headers.len() < 16384);
    }
    let text = String::from_utf8(headers).unwrap();
    assert!(text
        .to_lowercase()
        .contains(&format!("authorization: bearer {KEY}")));
    text
}
pub(super) async fn reply(stream: &mut TcpStream, status: u16, body: &Value) {
    let body = body.to_string();
    stream.write_all(format!("HTTP/1.1 {status} test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
pub(super) async fn closed(socket: &mut WebSocketStream<TcpStream>) {
    timeout(Duration::from_secs(3), async {
        let message = socket.next().await;
        assert!(
            matches!(message, None | Some(Ok(Message::Close(_))) | Some(Err(_))),
            "{message:?}"
        );
        let _ = socket.flush().await;
    })
    .await
    .expect("SDK socket close");
}
pub(super) async fn wait_observations(
    source: &mut SdkRecorderSource,
    predicate: impl Fn(&[TickObservation]) -> bool,
) -> Vec<TickObservation> {
    timeout(Duration::from_secs(5), async {
        loop {
            let observations = source.capture().unwrap();
            if predicate(&observations) {
                return observations;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("expected SDK observations")
}
pub(super) async fn wait_failure(source: &mut SdkRecorderSource) {
    timeout(Duration::from_secs(5), async {
        while source.capture().is_ok() {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("terminal source error");
    assert!(source.terminal_error().is_some());
}
