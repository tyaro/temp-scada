//! The first setup and the management inspection, against a loopback Hub and
//! a temporary data dir (C5-2).
use super::*;
use banto_tagclient::{Endpoint, SecretApiKey};
use futures_util::{SinkExt, StreamExt};
use scada_historian::store::recording_plan::{RecordingMappingMember, RegisterMappingRequest};
use scada_historian::store::retention::application::{
    PolicyApplyRequest, PolicyPreparationRequest,
};
use scada_historian::store::{IdentityDescriptor, Source, ValueType};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;

const LEVEL: &str = "PLC01.Fast.Tank01.Level";
const RUNNING: &str = "PLC01.Fast.Running";
const KEY: &str = "recording-setup-test-only-key";

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("scada-host-setup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A loopback Hub serving a fixed catalog of `tags` (name, data type) to
/// any number of SDK generations, each value `real` and good.
struct Hub {
    url: String,
    subscriptions: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Hub {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Hub {
    async fn new(tags: &[(&str, &str)]) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let tags: Vec<(String, String)> = tags
            .iter()
            .map(|(n, t)| ((*n).to_owned(), (*t).to_owned()))
            .collect();
        let subscriptions = Arc::new(AtomicUsize::new(0));
        let count = subscriptions.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(serve(stream, tags.clone(), count.clone()));
            }
        });
        Self {
            url,
            subscriptions,
            task,
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
}

fn rows(tags: &[(String, String)]) -> Vec<Value> {
    tags.iter()
        .map(|(name, kind)| {
            let v = if kind == "bit" { 1.0 } else { 42.5 };
            json!({"tag": name, "v": v, "q": "good", "t": 100, "value_source": "real"})
        })
        .collect()
}

async fn serve(mut stream: TcpStream, tags: Vec<(String, String)>, count: Arc<AtomicUsize>) {
    // Peek the request head: plain GETs are answered here, anything else is
    // the SDK's WebSocket.
    let mut head = vec![0u8; 8192];
    let mut seen = 0;
    while !head[..seen].windows(4).any(|w| w == b"\r\n\r\n") {
        let Ok(n) = stream.peek(&mut head).await else {
            return;
        };
        if n == seen || n == head.len() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        seen = n;
    }
    let text = String::from_utf8_lossy(&head[..seen]).to_string();
    let body = if text.starts_with("GET /api/v1/tags ") {
        let catalog: Vec<Value> = tags
            .iter()
            .enumerate()
            .map(|(i, (name, kind))| {
                json!({
                "external_name": name, "tag_key": name, "ids": [1, 2, i + 1],
                "connection": "PLC01", "group": "Fast", "name": name, "address": "D100",
                "data_type": kind, "unit": if kind == "bit" { None } else { Some("%") },
                "decimals": 1, "period_ms": 100, "enabled": true, "writable": false,
                "tag_kind": "plc", "expression": null, "retain": false, "simulation": false,
                "configured_simulation": false, "effective_simulation": false,
                "value_source": "real"})
            })
            .collect();
        json!({"revision": 3, "run_id": 7, "collection_mode": "configured", "tags": catalog})
    } else if text.starts_with("GET /api/v1/values") {
        // The values of the requested tags only.
        let line = text.lines().next().unwrap_or_default();
        let requested: Vec<_> = tags
            .iter()
            .filter(|(name, _)| line.contains(name.as_str()))
            .cloned()
            .collect();
        json!({"revision": 3, "run_id": 7, "collection_mode": "configured", "t": 100,
            "values": rows(if requested.is_empty() { &tags } else { &requested })})
    } else {
        let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
            return;
        };
        while let Some(Ok(message)) = socket.next().await {
            let Ok(text) = message.to_text() else {
                continue;
            };
            let Ok(frame) = serde_json::from_str::<Value>(text) else {
                continue;
            };
            let reply = match frame["op"].as_str() {
                Some("subscribe") => {
                    count.fetch_add(1, Ordering::SeqCst);
                    // A Hub sends the subscribed tags only.
                    let subscribed: Vec<_> = tags
                        .iter()
                        .filter(|(name, _)| {
                            frame["tags"]
                                .as_array()
                                .is_some_and(|t| t.iter().any(|t| t == name.as_str()))
                        })
                        .cloned()
                        .collect();
                    json!({"op": "data", "id": 1, "t": 100, "values": rows(&subscribed)})
                }
                Some("ping") => json!({"op": "pong"}),
                _ => continue,
            };
            if socket
                .send(Message::Text(reply.to_string().into()))
                .await
                .is_err()
            {
                return;
            }
        }
        return;
    };
    let mut discard = vec![0u8; seen];
    let _ = stream.read_exact(&mut discard).await;
    let body = body.to_string();
    let _ = stream
        .write_all(
            format!(
                "HTTP/1.1 200 test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await;
}

fn plan(enabled: bool) -> Value {
    json!({"version": 1, "kind": "recordingPlan", "planId": "plan-a", "revision": 1,
        "enabled": enabled, "group": {"groupId": "group", "hubRef": "hub", "periodMs": 100,
            "members": [
                {"memberId": "member-level", "externalName": LEVEL, "valueType": "number"},
                {"memberId": "member-running", "externalName": RUNNING, "valueType": "bool"}]}})
}

fn project(plan: Option<Value>) -> Project {
    let mut value: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../examples/minimal.project.json"
    )))
    .unwrap();
    if let Some(plan) = plan {
        value["recordingPlan"] = plan;
    }
    Project::from_json(&value.to_string()).unwrap()
}

fn both() -> [(&'static str, &'static str); 2] {
    [(LEVEL, "f64"), (RUNNING, "bit")]
}

async fn inspect(runtime: &RecordingRuntime, project: &Project) -> Value {
    let context = runtime.management_context(project).unwrap();
    runtime
        .inspect(json!({"version": 1, "kind": "recordingInspectionRequest",
            "requestId": "inspect-1", "context": context}))
        .await
        .unwrap()
}

/// Waits until History returns at least `n` raw points of the first series.
async fn wait_points(runtime: &RecordingRuntime, project: &Project, n: usize) -> Value {
    let context = runtime.history_context(project).unwrap().unwrap();
    let series = context["series"][0]["seriesId"].clone();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let now = setup::now_ms();
            let result = runtime
                .history_query(
                    "wait",
                    json!({"version": 1, "kind": "query", "requestId": "points",
                        "seriesIds": [series], "fromMs": now - 60_000, "toMs": now + 1000,
                        "mode": "raw", "maxPointsPerSeries": 1000}),
                )
                .await
                .unwrap();
            if result["series"][0]["raw"].as_array().unwrap().len() >= n {
                return result;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("recorded points")
}

#[tokio::test]
async fn the_first_setup_maps_applies_and_records_ticks() {
    let dir = TempDir::new();
    let hub = Hub::new(&both()).await;
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    let project = project(Some(plan(true)));

    let before = inspect(&runtime, &project).await;
    assert_eq!(before["database"]["state"], "available");
    assert_eq!(before["database"]["applied"], Value::Null);
    assert_eq!(before["host"]["phase"], "idle");
    assert_eq!(runtime.history_context(&project), Ok(None));

    let phase = runtime
        .initial_setup(&project, hub.client(), hub.client())
        .await
        .unwrap();
    assert!(matches!(phase, "running" | "starting"), "{phase}");

    // History follows the applied plan at once.
    let context = runtime.history_context(&project).unwrap().unwrap();
    let labels: Vec<_> = context["series"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["label"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(labels.len(), 2);
    assert!(labels.contains(&LEVEL.to_owned()) && labels.contains(&RUNNING.to_owned()));
    let points = wait_points(&runtime, &project, 2).await;
    assert_eq!(points["series"][0]["raw"][0]["quality"], "good");

    let after = inspect(&runtime, &project).await;
    let db = &after["database"];
    assert_eq!(db["applied"]["appliedRevision"], 1);
    assert_eq!(db["applied"]["mappingRevision"], 1);
    assert_eq!(db["applied"]["retentionAppliedRevision"], 1);
    assert_eq!(db["latestActivation"]["state"], "active");
    assert_eq!(db["activeSessionId"], db["latestActivation"]["sessionId"]);
    assert_eq!(after["host"]["phase"], "running");
    assert_eq!(after["host"]["runRef"], "run:1");
    assert_eq!(after["host"]["sessionId"], db["activeSessionId"]);
    assert_eq!(after["sdk"]["state"], "unknown");
    // One generation to resolve, one to record.
    assert_eq!(hub.subscriptions.load(Ordering::SeqCst), 2);

    // The applied plan has recorded: no second first setup.
    assert_eq!(
        runtime
            .initial_setup(&project, hub.client(), hub.client())
            .await,
        Err(SetupFailure::NotAllowed)
    );
    assert_eq!(inspect(&runtime, &project).await["host"]["runRef"], "run:1");
}

#[tokio::test]
async fn refusals_before_the_hub_change_nothing() {
    let dir = TempDir::new();
    let hub = Hub::new(&both()).await;
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    for (project, failure) in [
        (project(None), SetupFailure::NoRecordingPlan),
        (project(Some(plan(false))), SetupFailure::PlanDisabled),
    ] {
        assert_eq!(
            runtime
                .initial_setup(&project, hub.client(), hub.client())
                .await,
            Err(failure)
        );
    }
    assert_eq!(hub.subscriptions.load(Ordering::SeqCst), 0);
    let state = inspect(&runtime, &project(None)).await;
    assert_eq!(state["database"]["currentMappingRevision"], Value::Null);
    assert_eq!(
        RecordingRuntime::unavailable(STORE_LOCKED)
            .initial_setup(&project(Some(plan(true))), hub.client(), hub.client())
            .await,
        Err(SetupFailure::Unavailable)
    );
}

#[tokio::test]
async fn a_missing_or_mismatched_tag_saves_nothing_and_a_later_call_succeeds() {
    let dir = TempDir::new();
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    let project = project(Some(plan(true)));
    let partial = Hub::new(&[(LEVEL, "f64")]).await;
    assert_eq!(
        runtime
            .initial_setup(&project, partial.client(), partial.client())
            .await,
        Err(SetupFailure::TagsUnresolved)
    );
    let mistyped = Hub::new(&[(LEVEL, "f64"), (RUNNING, "f64")]).await;
    assert_eq!(
        runtime
            .initial_setup(&project, mistyped.client(), mistyped.client())
            .await,
        Err(SetupFailure::ResolutionMismatch)
    );
    let db = &inspect(&runtime, &project).await["database"];
    assert_eq!(db["currentMappingRevision"], Value::Null);
    assert_eq!(db["currentRetentionAppliedRevision"], Value::Null);
    assert_eq!(db["applied"], Value::Null);

    let hub = Hub::new(&both()).await;
    runtime
        .initial_setup(&project, hub.client(), hub.client())
        .await
        .unwrap();
    wait_points(&runtime, &project, 1).await;
}

/// A store that already holds what an earlier setup saved before its reply
/// was lost: a fitting mapping and a retention policy, then also the plan.
fn seed(dir: &TempDir, with_plan: bool) -> Vec<IdentityDescriptor> {
    let identity = StoreIdentityFile::generate("deployment-a");
    std::fs::write(
        dir.0.join(STORE_IDENTITY_FILE),
        serde_json::to_vec(&identity).unwrap(),
    )
    .unwrap();
    let mut store = SqliteStore::create(dir.0.join(STORE_DIR), identity.store_identity()).unwrap();
    let members: Vec<_> = [
        ("member-level", LEVEL, ValueType::Number, Some("%")),
        ("member-running", RUNNING, ValueType::Bool, None),
    ]
    .into_iter()
    .enumerate()
    .map(
        |(n, (member, name, value_type, unit))| RecordingMappingMember {
            member_id: member.into(),
            identity: IdentityDescriptor {
                series_id: format!("series:earlier-{n}"),
                hub_instance_id: "hub:earlier".into(),
                incarnation_id: format!("incarnation:earlier-{n}"),
                external_name: name.into(),
                segment_id: format!("segment:earlier-{n}"),
                value_type,
                unit: unit.map(Into::into),
                period_ms: 100,
                source: Source::Real,
            },
        },
    )
    .collect();
    store
        .register_recording_mapping(
            &RegisterMappingRequest {
                request_id: "mapping:earlier".into(),
                expected_mapping_revision: None,
                mapping: RecordingMapping {
                    hub_ref: "hub".into(),
                    hub_instance_id: "hub:earlier".into(),
                    members: members.clone(),
                },
            },
            &setup::control(),
        )
        .unwrap();
    let policy = default_retention_policy();
    let reference_wall_ms = setup::now_ms();
    let preview = store
        .preview_retention_policy_application(
            &PolicyPreparationRequest {
                proposed_policy: policy.clone(),
                reference_wall_ms,
            },
            &setup::control(),
        )
        .unwrap();
    store
        .apply_retention_policy(
            &PolicyApplyRequest {
                request_id: "retention:earlier".into(),
                expected_applied_revision: None,
                expected_preview_snapshot_commit: preview.snapshot_commit,
                proposed_policy: policy,
                reference_wall_ms,
            },
            &setup::control(),
        )
        .unwrap();
    if with_plan {
        store
            .apply_recording_plan(
                &scada_historian::store::recording_plan::ApplyRecordingPlanRequest {
                    request_id: "apply:earlier".into(),
                    expected_applied_revision: None,
                    desired: plan(true),
                    expected_mapping_revision: Some(1),
                    expected_retention_applied_revision: Some(1),
                },
                &setup::control(),
            )
            .unwrap();
    }
    members.into_iter().map(|m| m.identity).collect()
}

#[tokio::test]
async fn a_repeated_setup_keeps_what_an_earlier_call_saved() {
    for with_plan in [false, true] {
        let dir = TempDir::new();
        let earlier = seed(&dir, with_plan);
        let hub = Hub::new(&both()).await;
        let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
        let project = project(Some(plan(true)));
        runtime
            .initial_setup(&project, hub.client(), hub.client())
            .await
            .unwrap();
        let db = &inspect(&runtime, &project).await["database"];
        // Nothing was registered, applied or set again.
        assert_eq!(db["currentMappingRevision"], 1, "{with_plan}");
        assert_eq!(db["currentRetentionAppliedRevision"], 1);
        assert_eq!(db["applied"]["appliedRevision"], 1);
        let context = runtime.history_context(&project).unwrap().unwrap();
        let mut series: Vec<_> = context["series"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["seriesId"].as_str().unwrap().to_owned())
            .collect();
        series.sort();
        assert_eq!(
            series,
            earlier
                .iter()
                .map(|d| d.series_id.clone())
                .collect::<Vec<_>>()
        );
        wait_points(&runtime, &project, 1).await;
    }
}

#[tokio::test]
async fn another_applied_plan_is_not_a_first_setup() {
    let dir = TempDir::new();
    seed(&dir, true);
    let hub = Hub::new(&both()).await;
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    let mut other = plan(true);
    other["revision"] = json!(2);
    assert_eq!(
        runtime
            .initial_setup(&project(Some(other)), hub.client(), hub.client())
            .await,
        Err(SetupFailure::NotAllowed)
    );
    assert_eq!(hub.subscriptions.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn an_inspection_answers_only_its_own_context() {
    let dir = TempDir::new();
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    let project = project(None);
    let context = runtime.management_context(&project).unwrap();
    assert_eq!(context["deploymentId"], "deployment-a");
    assert_eq!(context["projectId"], project.id());
    assert!(context["contextId"].as_str().unwrap().starts_with("host:"));
    let mut foreign = context.clone();
    foreign["storeId"] = json!("store:other");
    let request = |context: Value| {
        json!({"version": 1, "kind": "recordingInspectionRequest", "requestId": "r",
            "context": context})
    };
    assert_eq!(
        runtime.inspect(request(foreign)).await,
        Err(InspectFailure::ContextMismatch)
    );
    assert_eq!(
        runtime.inspect(json!({"kind": "other"})).await,
        Err(InspectFailure::InvalidRequest)
    );
    // A new process is a new context.
    drop(runtime);
    let next = RecordingRuntime::start(&dir.0, "deployment-a");
    assert_eq!(
        next.inspect(request(context)).await,
        Err(InspectFailure::ContextMismatch)
    );
    assert_eq!(
        RecordingRuntime::unavailable(STORE_LOCKED).management_context(&project),
        Err(STORE_LOCKED)
    );
}

mod owner;
mod resume;
