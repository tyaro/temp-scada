//! Dedicated fixed SDK subscriptions connect only to disposable loopback Hubs.
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use banto_tagclient::{CollectionMode, Endpoint, ErrorKind, RestClient, SecretApiKey, StableTagId};
use futures_util::{FutureExt, SinkExt, StreamExt};
use scada_historian::{
    recorder::{
        ClockError, ClockReading, Recorder, RecorderClock, RecorderConfig, RecorderReport,
        SnapshotSource, StopCause,
    },
    store::{
        evidence::PlanRef,
        query::{CancellationToken, QueryControl},
        IdentityDescriptor, ObservationValue, Reason, SessionSpec, SessionState, Source,
        SqliteStore, StoreError, StoreIdentity, Tick, TickObservation, ValueType,
    },
};
use scada_model::Project;
use scada_runtime::{
    recorder_source::{SdkBindingPin, SdkGenerationPin, SdkRecorderPlan, SdkRecorderSource},
    NumericReading, ReadHost,
};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::{sleep, timeout},
};
use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};

const NUMBER: &str = "PLC01.Fast.Tank01.Level";
const BOOL: &str = "PLC01.Fast.Running";
const MISSING: &str = "PLC01.Fast.Missing";
const KEY: &str = "recorder-source-test-only-key";

fn plan(run_id: Option<u64>, source: Source, full: bool) -> SdkRecorderPlan {
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

struct Hub {
    listener: TcpListener,
    url: String,
}
impl Hub {
    async fn serve_unbound(&self) -> WebSocketStream<TcpStream> {
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
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        Self {
            url: format!("http://{}", listener.local_addr().unwrap()),
            listener,
        }
    }
    fn client(&self) -> RestClient {
        RestClient::with_request_timeout(
            Endpoint::new(&self.url).unwrap(),
            SecretApiKey::new(KEY.into()).unwrap(),
            Duration::from_secs(2),
        )
        .unwrap()
    }
    async fn serve(
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
async fn request(stream: &mut TcpStream) -> String {
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
async fn reply(stream: &mut TcpStream, status: u16, body: &Value) {
    let body = body.to_string();
    stream.write_all(format!("HTTP/1.1 {status} test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
}
async fn closed(socket: &mut WebSocketStream<TcpStream>) {
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
async fn wait_observations(
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
async fn wait_failure(source: &mut SdkRecorderSource) {
    timeout(Duration::from_secs(5), async {
        while source.capture().is_ok() {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("terminal source error");
    assert!(source.terminal_error().is_some());
}

struct Directory(PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Clock(u64);
impl RecorderClock for Clock {
    fn read(&mut self) -> Result<ClockReading, ClockError> {
        Ok(ClockReading {
            monotonic_ms: self.0,
            wall_time_ms: 10000 + self.0 as i64,
            clock_epoch: "test-epoch".into(),
        })
    }
    fn wait_until(&mut self, deadline: u64, _: &CancellationToken) -> Result<(), ClockError> {
        self.0 = self.0.max(deadline);
        Ok(())
    }
}
struct Recording {
    source: SdkRecorderSource,
    store: SqliteStore,
    recorder: Recorder,
    clock: Clock,
    _directory: Directory,
}
impl Recording {
    fn new(source: SdkRecorderSource, session: SessionSpec) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = Directory(std::env::temp_dir().join(format!(
            "scada-sdk-recorder-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )));
        let mut store = SqliteStore::create(
            &directory.0,
            StoreIdentity {
                store_id: "test-store".into(),
                deployment_id: "test-deployment".into(),
            },
        )
        .unwrap();
        let mut clock = Clock(0);
        let recorder = Recorder::start(
            &mut store,
            RecorderConfig {
                session,
                plan: PlanRef {
                    plan_id: "plan".into(),
                    revision: 1,
                },
                period_ms: 1000,
                slot_count: Some(4),
                max_clock_skew_ms: 0,
            },
            &mut clock,
        )
        .unwrap();
        Self {
            source,
            store,
            recorder,
            clock,
            _directory: directory,
        }
    }
    // SQLite and synchronous recorder waits never occupy the SDK executor.
    async fn step(mut self) -> (Self, RecorderReport) {
        tokio::task::spawn_blocking(move || {
            let report = self.recorder.step(
                &mut self.store,
                &mut self.source,
                &mut self.clock,
                &CancellationToken::default(),
            );
            (self, report)
        })
        .await
        .unwrap()
    }
    fn raw(&self, series: &str) -> Value {
        self.store.reader().unwrap().query_raw(&json!({"version":1,"kind":"query","requestId":"recorded","seriesIds":[series],"fromMs":10000,"toMs":14000,"mode":"raw","maxPointsPerSeries":4}),&QueryControl::with_timeout(Duration::from_secs(5)).unwrap()).unwrap()
    }
}

#[tokio::test]
async fn dedicated_source_records_atomic_sdk_values_nulls_and_survives_ui_stop() {
    let hub = Hub::new().await;
    let plan = plan(Some(7), Source::Real, true);
    let session = plan.session().clone();
    let mut source = SdkRecorderSource::start(plan, hub.client()).unwrap();
    // The worker has not yet been polled. Initial SDK Stopped is not terminal.
    assert!(source
        .capture()
        .unwrap()
        .iter()
        .all(|v| v.reason == Some(Reason::SourceUnavailable)));
    let mut socket = hub.serve(true, Some(7), "real", 3).await;
    let observations = wait_observations(&mut source, |v| v[0].value.is_some()).await;
    assert_eq!(observations[0].value, Some(ObservationValue::Number(0.0)));
    assert_eq!(observations[1].value, Some(ObservationValue::Bool(false)));
    assert_eq!(observations[2].reason, Some(Reason::Unresolved));
    assert_eq!(observations[0].source_epoch, observations[1].source_epoch);

    let ui_hub = Hub::new().await;
    let project =
        Project::from_json(include_str!("../../../examples/tag-binding.project.json")).unwrap();
    let mut ui = ReadHost::new(&project).unwrap();
    ui.replace(&project, Some(ui_hub.client())).await.unwrap();
    let mut ui_socket = ui_hub.serve(false, Some(7), "real", 3).await;
    timeout(Duration::from_secs(3), async {
        while !matches!(
            ui.state().text.readings[NUMBER],
            NumericReading::Resolved { .. }
        ) {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    ui.stop().await.unwrap();
    closed(&mut ui_socket).await;

    let (mut recording, report) = Recording::new(source, session).step().await;
    assert_eq!(report.counters.committed_ticks, 1);
    // Stable replay verifies the exact source epochs reached SQLite, not only
    // the public raw DTO (which does not expose those internal counters).
    let mut replay = Tick {
        session_id: "recording".into(),
        sequence: 1,
        clock_epoch: "test-epoch".into(),
        sample_time_ms: 10000,
        ingested_at_ms: 10000,
        observations,
    };
    assert_eq!(
        recording.store.append_tick(replay.clone()).unwrap(),
        report.tick_receipt.unwrap()
    );
    for observation in &mut replay.observations {
        if let Some(epoch) = &mut observation.source_epoch {
            epoch.sdk_generation += 1;
        }
    }
    assert!(matches!(
        recording.store.append_tick(replay),
        Err(StoreError::Conflict)
    ));
    socket
        .send(Message::Text(
            json!({"op":"data","id":1,"t":100,"values":[
                {"tag":NUMBER,"v":999,"q":"bad","t":100,"value_source":"real"},
                {"tag":BOOL,"v":1,"q":"stale","t":100,"value_source":"real"}
            ]})
            .to_string()
            .into(),
        ))
        .await
        .unwrap();
    wait_observations(&mut recording.source, |v| v[0].reason == Some(Reason::Bad)).await;
    let (mut recording, report) = recording.step().await;
    assert_eq!(report.counters.committed_ticks, 2);
    socket.close(None).await.unwrap();
    drop(socket);
    wait_observations(&mut recording.source, |v| {
        v[0].reason == Some(Reason::SourceUnavailable)
    })
    .await;
    let (mut recording, report) = recording.step().await;
    assert_eq!(report.counters.committed_ticks, 3);
    let raw = recording.raw("series-0");
    let samples = raw["series"][0]["raw"].as_array().unwrap();
    assert_eq!(samples.len(), 3);
    assert_eq!(samples[0]["value"], 0.0);
    assert_eq!(samples[1]["reason"], "bad");
    assert_eq!(samples[1]["sourceTimeMs"], 100);
    assert_eq!(samples[2]["reason"], "sourceUnavailable");
    assert_eq!(samples[2]["sourceTimeMs"], Value::Null);
    assert_eq!(
        recording.raw("series-1")["series"][0]["raw"][0]["value"],
        false
    );
    assert_eq!(
        recording.raw("series-1")["series"][0]["raw"][1]["reason"],
        "stale"
    );
    assert_eq!(
        recording.raw("series-2")["series"][0]["raw"][0]["reason"],
        "unresolved"
    );
    let q = json!({"version":1,"kind":"query","requestId":"aggregate","seriesIds":["series-0"],"fromMs":10000,"toMs":14000,"mode":"minmax","maxPointsPerSeries":2});
    assert!(recording
        .store
        .reader()
        .unwrap()
        .query_minmax(
            &q,
            &QueryControl::with_timeout(Duration::from_secs(5)).unwrap()
        )
        .is_ok());
    recording.source.shutdown().await.unwrap();
    recording.source.shutdown().await.unwrap();
    let (recording, report) = recording.step().await;
    assert!(matches!(
        report.terminal.unwrap().cause,
        StopCause::Source(_)
    ));
    assert_eq!(report.counters.committed_ticks, 3);
    assert_ne!(
        recording
            .store
            .session_status("recording")
            .unwrap()
            .unwrap()
            .state,
        SessionState::Active
    );
}

#[tokio::test]
async fn reconnect_is_allowed_only_with_same_pinned_run_and_revision() {
    for run in [Some(7), None] {
        let hub = Hub::new().await;
        let mut source =
            SdkRecorderSource::start(plan(run, Source::Real, false), hub.client()).unwrap();
        let mut socket = hub.serve(false, run, "real", 3).await;
        let first = wait_observations(&mut source, |v| v[0].value.is_some()).await;
        socket.close(None).await.unwrap();
        drop(socket);
        wait_observations(&mut source, |v| {
            v[0].reason == Some(Reason::SourceUnavailable)
        })
        .await;
        let mut socket = hub.serve(false, run, "real", 3).await;
        if run.is_some() {
            let second = wait_observations(&mut source, |v| v[0].value.is_some()).await;
            assert!(
                second[0].source_epoch.as_ref().unwrap().sdk_generation
                    > first[0].source_epoch.as_ref().unwrap().sdk_generation
            );
        } else {
            wait_failure(&mut source).await;
        }
        source.shutdown().await.unwrap();
        closed(&mut socket).await;
    }
}

#[tokio::test]
async fn changed_source_stops_recorder_and_cannot_recover_in_place() {
    let hub = Hub::new().await;
    let plan = plan(Some(7), Source::Real, false);
    let session = plan.session().clone();
    let mut source = SdkRecorderSource::start(plan, hub.client()).unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    wait_observations(&mut source, |v| v[0].value.is_some()).await;
    let (mut recording, _) = Recording::new(source, session).step().await;
    socket.close(None).await.unwrap();
    drop(socket);
    wait_observations(&mut recording.source, |v| {
        v[0].reason == Some(Reason::SourceUnavailable)
    })
    .await;
    // The fixed SDK takes source from its REST baseline and preserves it over
    // WS updates. A new generation, rather than an invented WS source change,
    // exercises the actual public SDK contract.
    let mut socket = hub.serve(false, Some(7), "simulation", 3).await;
    wait_failure(&mut recording.source).await;
    socket.close(None).await.unwrap();
    drop(socket);
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    assert!(recording.source.capture().is_err());
    let (mut recording, report) = recording.step().await;
    assert!(matches!(
        report.terminal.unwrap().cause,
        StopCause::Source(_)
    ));
    assert_eq!(
        recording.raw("series-0")["series"][0]["raw"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    recording.source.shutdown().await.unwrap();
    closed(&mut socket).await;
}

#[tokio::test]
async fn unauthorized_and_cancelled_shutdown_remain_terminal() {
    let hub = Hub::new().await;
    let mut source =
        SdkRecorderSource::start(plan(Some(7), Source::Real, false), hub.client()).unwrap();
    let (mut stream, _) = timeout(Duration::from_secs(3), hub.listener.accept())
        .await
        .unwrap()
        .unwrap();
    request(&mut stream).await;
    reply(&mut stream, 401, &json!({"error":"test"})).await;
    wait_failure(&mut source).await;
    assert_eq!(source.shutdown().await, Err(ErrorKind::Unauthorized));
    assert_eq!(source.shutdown().await, Err(ErrorKind::Unauthorized));

    let hub = Hub::new().await;
    let mut source =
        SdkRecorderSource::start(plan(Some(7), Source::Real, false), hub.client()).unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    wait_observations(&mut source, |v| v[0].value.is_some()).await;
    assert!(source.shutdown().now_or_never().is_none());
    assert!(source.capture().is_err());
    assert_eq!(source.shutdown().await, Err(ErrorKind::Transport));
    closed(&mut socket).await;
}

#[tokio::test]
async fn drop_aborts_dedicated_connection() {
    let hub = Hub::new().await;
    let mut source =
        SdkRecorderSource::start(plan(Some(7), Source::Real, false), hub.client()).unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    wait_observations(&mut source, |v| v[0].value.is_some()).await;
    drop(source);
    closed(&mut socket).await;
}

#[tokio::test]
async fn unbound_records_nulls_without_a_subscription_to_an_empty_set() {
    let hub = Hub::new().await;
    let plan = plan(Some(7), Source::Real, false);
    let session = plan.session().clone();
    let mut source = SdkRecorderSource::start(plan, hub.client()).unwrap();
    let mut socket = hub.serve_unbound().await;
    let observations =
        wait_observations(&mut source, |v| v[0].reason == Some(Reason::Unresolved)).await;
    assert_eq!(observations[0].source_epoch, None);
    let (mut recording, report) = Recording::new(source, session).step().await;
    assert_eq!(report.counters.committed_ticks, 1);
    assert_eq!(
        recording.raw("series-0")["series"][0]["raw"][0]["reason"],
        "unresolved"
    );
    recording.source.shutdown().await.unwrap();
    closed(&mut socket).await;
}

#[tokio::test]
async fn fixed_excluded_sources_persist_only_nulls_with_their_actual_source() {
    for (expected_source, label, reason) in [
        (Source::Simulation, "simulation", "simulationExcluded"),
        (
            Source::DerivedSimulation,
            "derived_simulation",
            "simulationExcluded",
        ),
        (Source::Unknown, "future", "unknownSource"),
    ] {
        let hub = Hub::new().await;
        let plan = plan(Some(7), expected_source, false);
        let session = plan.session().clone();
        let mut source = SdkRecorderSource::start(plan, hub.client()).unwrap();
        let mut socket = hub.serve(false, Some(7), label, 3).await;
        let observations = wait_observations(&mut source, |v| v[0].source.is_some()).await;
        assert_eq!(observations[0].source, Some(expected_source));
        assert!(observations[0].value.is_none());
        let (mut recording, report) = Recording::new(source, session).step().await;
        assert_eq!(report.counters.committed_ticks, 1);
        let raw = recording.raw("series-0");
        assert_eq!(raw["series"][0]["raw"][0]["reason"], reason);
        assert_eq!(raw["series"][0]["raw"][0]["value"], Value::Null);
        recording.source.shutdown().await.unwrap();
        closed(&mut socket).await;
    }
}

#[tokio::test]
async fn catalog_revision_change_latches_and_requires_explicit_new_plan() {
    let hub = Hub::new().await;
    let mut source =
        SdkRecorderSource::start(plan(Some(7), Source::Real, false), hub.client()).unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    wait_observations(&mut source, |v| v[0].value.is_some()).await;
    socket.close(None).await.unwrap();
    drop(socket);
    wait_observations(&mut source, |v| {
        v[0].reason == Some(Reason::SourceUnavailable)
    })
    .await;
    let mut socket = hub.serve(false, Some(7), "real", 4).await;
    wait_failure(&mut source).await;
    source.shutdown().await.unwrap();
    closed(&mut socket).await;
}

#[tokio::test]
async fn recorder_shutdown_leaves_separate_ui_owner_live() {
    let hub = Hub::new().await;
    let mut source =
        SdkRecorderSource::start(plan(Some(7), Source::Real, false), hub.client()).unwrap();
    let mut socket = hub.serve(false, Some(7), "real", 3).await;
    wait_observations(&mut source, |v| v[0].value.is_some()).await;
    let ui_hub = Hub::new().await;
    let project =
        Project::from_json(include_str!("../../../examples/tag-binding.project.json")).unwrap();
    let mut ui = ReadHost::new(&project).unwrap();
    ui.replace(&project, Some(ui_hub.client())).await.unwrap();
    let mut ui_socket = ui_hub.serve(false, Some(7), "real", 3).await;
    source.shutdown().await.unwrap();
    closed(&mut socket).await;
    ui_socket
        .send(Message::Text(
            json!({"op":"data","id":1,"t":200,"values":[{"tag":NUMBER,"v":42,"q":"good","t":200}]})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    timeout(Duration::from_secs(3), async {
        while !matches!(
            ui.state().text.readings[NUMBER],
            NumericReading::Resolved {
                numeric_value: Some(42.0),
                ..
            }
        ) {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("UI continues after recorder shutdown");
    ui.stop().await.unwrap();
    closed(&mut ui_socket).await;
}
