//! The operation write end to end (operation stage-3 design §4–§6, O2b):
//! a real `AuthHost` and `operations.db` in a temporary data dir, and a
//! loopback Hub answering the catalog and the write as each case needs.
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use banto_admin_services::settings::AuthSettings;
use banto_admin_services::Role;
use banto_tagclient::{Endpoint, ErrorKind, RestClient, SecretApiKey};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

use super::tests::{
    button, input, project, COMMAND_TAG, DIGEST, MODE_TAG, PROJECT_ID, PUMP, SPEED_TAG,
};
use super::*;
use crate::auth_phase::AuthHost;
use crate::operation_db::{OperationDb, RecordState};

const READ_KEY: &str = "operation-read-test-only-key";
const WRITE_KEY: &str = "operation-write-test-only-key";
const REVISION: u64 = 5;
/// Bounds far beyond any loopback answer, so no case depends on timing.
const LONG: Duration = Duration::from_secs(20);

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("scada-host-operation-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// How the loopback Hub answers a write.
#[derive(Clone)]
enum Reply {
    Status(u16, &'static str),
    /// Read the request and never answer.
    Hang,
    /// Read the request and close the connection.
    Close,
}

/// A step the test holds: the handler says it arrived, then waits.
#[derive(Default)]
struct Hold {
    on: AtomicBool,
    arrived: Notify,
    release: Notify,
}

impl Hold {
    async fn pass(&self) {
        if self.on.load(Ordering::SeqCst) {
            self.arrived.notify_one();
            self.release.notified().await;
        }
    }
}

struct HubState {
    revision: AtomicU64,
    catalog_status: AtomicU16,
    /// `(external name, data type, enabled, writable)`.
    rows: Mutex<Vec<(&'static str, &'static str, bool, bool)>>,
    reply: Mutex<Reply>,
    /// The bodies of the writes that reached the Hub, with their path.
    writes: Mutex<Vec<(String, Value)>>,
    catalog_hold: Hold,
    write_hold: Hold,
}

struct Hub {
    url: String,
    state: Arc<HubState>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Hub {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Hub {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(HubState {
            revision: AtomicU64::new(REVISION),
            catalog_status: AtomicU16::new(200),
            rows: Mutex::new(vec![
                (COMMAND_TAG, "bit", true, true),
                (SPEED_TAG, "f32", true, true),
                (MODE_TAG, "u16", true, true),
            ]),
            reply: Mutex::new(Reply::Status(200, r#"{"audit_id": 42}"#)),
            writes: Mutex::new(Vec::new()),
            catalog_hold: Hold::default(),
            write_hold: Hold::default(),
        });
        let shared = state.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(serve(stream, shared.clone()));
            }
        });
        Self { url, state, task }
    }

    fn client(&self, key: &str, timeout: Duration) -> RestClient {
        RestClient::with_request_timeout(
            Endpoint::new(&self.url).unwrap(),
            SecretApiKey::new(key.into()).unwrap(),
            timeout,
        )
        .unwrap()
    }

    fn reply(&self, reply: Reply) {
        *self.state.reply.lock().unwrap() = reply;
    }

    fn writes(&self) -> Vec<(String, Value)> {
        self.state.writes.lock().unwrap().clone()
    }
}

async fn read_request(stream: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buffer[..end]).to_string();
            let length = head
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())?
                })
                .unwrap_or(0);
            while buffer.len() < end + 4 + length {
                let n = stream.read(&mut chunk).await.ok()?;
                if n == 0 {
                    return None;
                }
                buffer.extend_from_slice(&chunk[..n]);
            }
            return Some((head, buffer[end + 4..end + 4 + length].to_vec()));
        }
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..n]);
    }
}

async fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let text = format!(
        "HTTP/1.1 {status} test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(text.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn serve(mut stream: TcpStream, state: Arc<HubState>) {
    let Some((head, body)) = read_request(&mut stream).await else {
        return;
    };
    if head.starts_with("GET /api/v1/tags ") {
        state.catalog_hold.pass().await;
        let rows: Vec<Value> = state
            .rows
            .lock()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, (name, data_type, enabled, writable))| {
                json!({
                "external_name": name, "tag_key": name, "ids": [1, 2, i + 1],
                "connection": "WWT", "group": "G", "name": name, "address": "D100",
                "data_type": data_type, "unit": null, "decimals": 1, "period_ms": 100,
                "enabled": enabled, "writable": writable, "tag_kind": "plc",
                "expression": null, "retain": false, "simulation": false,
                "configured_simulation": false, "effective_simulation": false,
                "value_source": "real"})
            })
            .collect();
        let catalog = json!({"revision": state.revision.load(Ordering::SeqCst), "run_id": 1,
            "collection_mode": "configured", "tags": rows});
        let status = state.catalog_status.load(Ordering::SeqCst);
        respond(&mut stream, status, &catalog.to_string()).await;
    } else if head.starts_with("POST /api/v1/values/") {
        let path = head.split(' ').nth(1).unwrap_or_default().to_owned();
        let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        state.writes.lock().unwrap().push((path, body));
        state.write_hold.pass().await;
        let reply = state.reply.lock().unwrap().clone();
        match reply {
            Reply::Status(status, body) => respond(&mut stream, status, body).await,
            Reply::Hang => tokio::time::sleep(Duration::from_secs(120)).await,
            Reply::Close => drop(stream),
        }
    } else {
        respond(&mut stream, 404, "{}").await;
    }
}

struct TestEnv {
    runtime: AtomicBool,
}

impl OperationEnv for TestEnv {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    fn is_runtime(&self) -> bool {
        self.runtime.load(Ordering::SeqCst)
    }
}

struct Fixture {
    hub: Hub,
    auth: Arc<AuthHost>,
    log: Arc<OperationLog>,
    env: Arc<TestEnv>,
    project: scada_model::Project,
    read: RestClient,
    write: Arc<RestClient>,
    contract: bool,
    _dir: TempDir,
}

impl Fixture {
    async fn new() -> Self {
        Self::with_write_timeout(LONG).await
    }

    async fn with_write_timeout(timeout: Duration) -> Self {
        let dir = TempDir::new();
        let auth = Arc::new(AuthHost::start(&dir.0).await.unwrap());
        let (db, _) = OperationDb::open(&dir.0.join("operations.db"), 0)
            .await
            .unwrap();
        let hub = Hub::new().await;
        let read = hub.client(READ_KEY, LONG);
        let write = Arc::new(hub.client(WRITE_KEY, timeout));
        Self {
            hub,
            auth,
            log: Arc::new(OperationLog::new(db)),
            env: Arc::new(TestEnv {
                runtime: AtomicBool::new(true),
            }),
            project: project(),
            read,
            write,
            contract: true,
            _dir: dir,
        }
    }

    fn context(&self) -> OperationWrite<'_> {
        OperationWrite {
            env: self.env.clone(),
            auth: Some(self.auth.clone()),
            log: self.log.clone(),
            project: Some(AppliedProject {
                id: PROJECT_ID,
                digest: DIGEST,
                project: &self.project,
            }),
            hub: HubAccess {
                endpoint: Some(self.hub.url.clone()),
                catalog: Some(&self.read),
                subscribed_revision: Some(REVISION),
                write_contract_confirmed: self.contract,
                write: Some(self.write.clone()),
                timeout: LONG,
            },
        }
    }

    async fn run(&self, request: &OperationWriteRequest) -> WriteResult {
        operation_write(&self.context(), request).await
    }

    async fn latest(&self, slot: &str) -> Option<(crate::operation_db::StoredRow, RecordState)> {
        self.log.latest(PROJECT_ID, PUMP, slot).await.unwrap()
    }

    async fn finished(&self, slot: &str) -> Finish {
        match self.latest(slot).await.unwrap().1 {
            RecordState::Finished(finish) => finish,
            other => panic!("not finished: {other:?}"),
        }
    }

    async fn transition(&self) {
        self.auth
            .transition_to_operational("admin", "correct-horse-1", "管理者", || true)
            .await
            .unwrap();
    }
}

fn kind(kind: ErrorKind) -> Option<String> {
    Some(kind.as_str().into())
}

#[tokio::test]
async fn a_write_is_recorded_sent_once_and_finished_with_the_audit_id() {
    let fx = Fixture::new().await;
    let result = fx.run(&button("command", 0, json!(true))).await;
    assert_eq!(result.outcome, Outcome::Ok, "{result:?}");
    assert_eq!(result.reason, None);
    assert_eq!(result.audit_id, Some(42));
    assert_eq!(result.tag.as_deref(), Some(COMMAND_TAG));
    assert_eq!(result.value, Some(json!(true)));
    assert!(!result.unrecorded);
    let id = result.record_id.clone().unwrap();
    let writes = fx.hub.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].0, format!("/api/v1/values/{COMMAND_TAG}"));
    assert_eq!(
        writes[0].1,
        json!({"v": true, "correlation_id": id, "on_behalf_of": NOT_LOGGED_IN})
    );
    let (row, state) = fx.latest("command").await.unwrap();
    assert_eq!(row.id, id);
    assert_eq!(row.request.user, NOT_LOGGED_IN);
    assert_eq!(row.request.phase, "initializing");
    assert_eq!(row.request.tag.as_deref(), Some(COMMAND_TAG));
    assert_eq!(row.request.equipment_code.as_deref(), Some("P-101"));
    assert_eq!(
        row.request.hub_endpoint.as_deref(),
        Some(fx.hub.url.as_str())
    );
    assert_eq!(row.request.value, json!({"button": 0, "value": true}));
    let RecordState::Finished(finish) = state else {
        panic!("{state:?}");
    };
    assert_eq!(finish.outcome, Outcome::Ok);
    assert_eq!(finish.audit_id, Some(42));
}

#[tokio::test]
async fn an_input_is_sent_as_its_number_and_recorded_with_the_text() {
    let fx = Fixture::new().await;
    let result = fx.run(&input("12.50", json!(12.5))).await;
    assert_eq!(result.outcome, Outcome::Ok, "{result:?}");
    assert_eq!(fx.hub.writes()[0].1["v"], json!(12.5));
    let (row, _) = fx.latest("speedSp").await.unwrap();
    assert_eq!(row.request.value, json!({"input": "12.50", "value": 12.5}));
}

#[tokio::test]
async fn a_success_whose_body_cannot_be_read_has_no_audit_id() {
    let fx = Fixture::new().await;
    fx.hub.reply(Reply::Status(200, "not json"));
    let result = fx.run(&button("command", 0, json!(true))).await;
    assert_eq!(result.outcome, Outcome::Ok);
    assert_eq!(result.audit_id, None);
    assert_eq!(fx.finished("command").await.audit_id, None);
}

#[tokio::test]
async fn each_hub_answer_finishes_with_the_outcome_of_section_5() {
    use ErrorKind::*;
    let fx = Fixture::new().await;
    let cases: &[(u16, &str, Outcome, ErrorKind)] = &[
        (
            401,
            r#"{"error":"unauthorized"}"#,
            Outcome::NotSent,
            Unauthorized,
        ),
        (
            403,
            r#"{"error":"not_writable"}"#,
            Outcome::NotSent,
            WriteForbidden,
        ),
        (
            403,
            r#"{"error":"key_tripped"}"#,
            Outcome::Stopped,
            KeyTripped,
        ),
        (
            404,
            r#"{"error":"unknown_tag"}"#,
            Outcome::Failed,
            WriteRejected,
        ),
        (
            409,
            r#"{"error":"tag_disabled"}"#,
            Outcome::Failed,
            WriteRejected,
        ),
        (
            422,
            r#"{"error":"out_of_range"}"#,
            Outcome::Failed,
            WriteRejected,
        ),
        (
            429,
            r#"{"error":"rate_limited"}"#,
            Outcome::Failed,
            WriteRejected,
        ),
        (
            501,
            r#"{"error":"not_implemented"}"#,
            Outcome::Failed,
            WriteRejected,
        ),
        (
            502,
            r#"{"error":"write_failed"}"#,
            Outcome::Failed,
            WriteRejected,
        ),
        (
            502,
            r#"{"error":"write_uncertain"}"#,
            Outcome::Uncertain,
            WriteUncertain,
        ),
        (
            500,
            r#"{"error":"audit_write_failed"}"#,
            Outcome::NotSent,
            Transport,
        ),
        (
            500,
            r#"{"error":"internal"}"#,
            Outcome::Uncertain,
            WriteUncertain,
        ),
        (
            503,
            r#"{"error":"writes_disabled"}"#,
            Outcome::NotSent,
            WriteUnavailable,
        ),
        (503, "", Outcome::Uncertain, WriteUncertain),
        (504, "", Outcome::Uncertain, WriteUncertain),
    ];
    for (count, (status, body, outcome, error)) in cases.iter().enumerate() {
        fx.hub.reply(Reply::Status(*status, body));
        let result = fx.run(&button("command", 0, json!(true))).await;
        let case = format!("{status} {body}");
        assert_eq!(result.outcome, *outcome, "{case}");
        assert_eq!(result.reason, kind(*error), "{case}");
        assert_eq!(result.audit_id, None, "{case}");
        assert!(!result.unrecorded, "{case}");
        let finish = fx.finished("command").await;
        assert_eq!(finish.outcome, *outcome, "{case}");
        assert_eq!(finish.reason, kind(*error), "{case}");
        assert_eq!(fx.hub.writes().len(), count + 1, "{case}");
    }
}

#[tokio::test]
async fn a_write_that_runs_out_of_time_is_uncertain() {
    // Short against a Hub that never answers: no timing boundary is crossed.
    let fx = Fixture::with_write_timeout(Duration::from_millis(300)).await;
    fx.hub.reply(Reply::Hang);
    let result = fx.run(&button("command", 0, json!(true))).await;
    assert_eq!(result.outcome, Outcome::Uncertain);
    assert_eq!(result.reason, kind(ErrorKind::WriteUncertain));
    assert_eq!(fx.finished("command").await.outcome, Outcome::Uncertain);
}

#[tokio::test]
async fn a_connection_cut_after_the_request_is_uncertain() {
    let fx = Fixture::new().await;
    fx.hub.reply(Reply::Close);
    let result = fx.run(&button("command", 0, json!(true))).await;
    assert_eq!(result.outcome, Outcome::Uncertain);
    assert_eq!(result.reason, kind(ErrorKind::WriteUncertain));
    assert_eq!(fx.hub.writes().len(), 1);
}

#[tokio::test]
async fn a_hub_that_cannot_be_reached_for_the_write_is_not_sent() {
    let mut fx = Fixture::new().await;
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    fx.write = Arc::new(
        RestClient::with_request_timeout(
            Endpoint::new(&url).unwrap(),
            SecretApiKey::new(WRITE_KEY.into()).unwrap(),
            LONG,
        )
        .unwrap(),
    );
    let result = fx.run(&button("command", 0, json!(true))).await;
    assert_eq!(result.outcome, Outcome::NotSent);
    assert_eq!(result.reason, kind(ErrorKind::Transport));
}

#[tokio::test]
async fn a_malformed_request_is_refused_without_a_record() {
    let fx = Fixture::new().await;
    let request = OperationWriteRequest {
        slot_name: "x".repeat(MAX_ID_CHARS + 1),
        ..button("command", 0, json!(true))
    };
    let result = fx.run(&request).await;
    assert_eq!(result.outcome, Outcome::Refused);
    assert_eq!(result.reason.as_deref(), Some(reason::INVALID_REQUEST));
    assert_eq!(result.record_id, None);
    assert!(!result.unrecorded);
    let request = OperationWriteRequest {
        input: Some("1".into()),
        ..button("command", 0, json!(true))
    };
    assert_eq!(
        fx.run(&request).await.reason.as_deref(),
        Some(reason::INVALID_REQUEST)
    );
    assert!(fx.latest("command").await.is_none());
    assert!(fx.hub.writes().is_empty());
}

/// Run a request that is refused before anything is sent and check its row.
async fn assert_refused(fx: &Fixture, request: &OperationWriteRequest, code: &str) -> WriteResult {
    let result = fx.run(request).await;
    assert_eq!(result.outcome, Outcome::Refused, "{code}: {result:?}");
    assert_eq!(result.reason.as_deref(), Some(code));
    assert!(!result.unrecorded, "{code}");
    let (row, state) = fx.latest(&request.slot_name).await.unwrap();
    assert_eq!(Some(row.id.clone()), result.record_id, "{code}");
    let RecordState::Finished(finish) = state else {
        panic!("{code}: {state:?}");
    };
    assert_eq!(finish.outcome, Outcome::Refused, "{code}");
    assert_eq!(finish.reason.as_deref(), Some(code));
    assert!(fx.hub.writes().is_empty(), "{code}: sent");
    result
}

#[tokio::test]
async fn refusals_before_sending_are_recorded_and_never_sent() {
    let fx = Fixture::new().await;
    let command = button("command", 0, json!(true));
    // §4-3, recorded with what was resolved.
    let result = assert_refused(
        &fx,
        &button("command", 0, json!(false)),
        reason::PROJECT_CHANGED,
    )
    .await;
    assert_eq!(result.tag.as_deref(), Some(COMMAND_TAG));
    let mismatch = OperationWriteRequest {
        object_id: "another".into(),
        ..command.clone()
    };
    assert_refused(&fx, &mismatch, reason::INVALID_REQUEST).await;
    assert_refused(&fx, &input("61", json!(61)), reason::OUT_OF_RANGE).await;
    assert_refused(&fx, &input("１", json!(1)), reason::INVALID_VALUE).await;
    assert_refused(&fx, &button("spare", 0, json!(true)), reason::UNBOUND).await;
    // §4-4.
    fx.hub.state.revision.store(REVISION + 1, Ordering::SeqCst);
    assert_refused(&fx, &command, reason::CATALOG_PENDING).await;
    fx.hub.state.revision.store(REVISION, Ordering::SeqCst);
    fx.hub.state.catalog_status.store(503, Ordering::SeqCst);
    assert_refused(&fx, &command, reason::CATALOG_UNAVAILABLE).await;
    fx.hub.state.catalog_status.store(200, Ordering::SeqCst);
    for (row, code) in [
        ((COMMAND_TAG, "bit", false, true), reason::TAG_DISABLED),
        ((COMMAND_TAG, "bit", true, false), reason::NOT_WRITABLE),
        ((COMMAND_TAG, "i16", true, true), reason::TYPE_MISMATCH),
        (("Other", "bit", true, true), reason::UNRESOLVED),
    ] {
        fx.hub.state.rows.lock().unwrap()[0] = row;
        assert_refused(&fx, &command, code).await;
    }
    fx.hub.state.rows.lock().unwrap()[0] = (COMMAND_TAG, "bit", true, true);
    fx.hub.state.rows.lock().unwrap()[2] = (MODE_TAG, "f32", true, true);
    assert_refused(&fx, &button("mode", 0, json!(1)), reason::TYPE_MISMATCH).await;
}

#[tokio::test]
async fn the_hub_contract_and_the_write_key_are_required() {
    let mut fx = Fixture::new().await;
    let command = button("command", 0, json!(true));
    fx.contract = false;
    assert_refused(&fx, &command, reason::HUB_UNSUPPORTED).await;
    fx.contract = true;
    let mut context = fx.context();
    context.hub.write = None;
    let result = operation_write(&context, &command).await;
    assert_eq!(result.reason.as_deref(), Some(reason::NO_WRITE_KEY));
    context.hub.catalog = None;
    let result = operation_write(&context, &command).await;
    assert_eq!(result.reason.as_deref(), Some(reason::CATALOG_UNAVAILABLE));
    assert!(fx.hub.writes().is_empty());
}

#[tokio::test]
async fn mode_auth_and_phase_are_checked_first() {
    let fx = Fixture::new().await;
    let command = button("command", 0, json!(true));
    fx.env.runtime.store(false, Ordering::SeqCst);
    assert_refused(&fx, &command, reason::NOT_RUNTIME).await;
    fx.env.runtime.store(true, Ordering::SeqCst);
    let mut context = fx.context();
    context.auth = None;
    let result = operation_write(&context, &command).await;
    assert_eq!(result.reason.as_deref(), Some(reason::AUTH_UNAVAILABLE));
    // Operation: nobody may write until `equipment.operate` exists, not even
    // the administrator (no fallback to Admin).
    fx.transition().await;
    assert_refused(&fx, &command, reason::NOT_AUTHORIZED).await;
    let (row, _) = fx.latest("command").await.unwrap();
    assert_eq!(row.request.user, "admin");
    assert_eq!(row.request.phase, "operational");
    fx.auth.auth().logout().await;
    assert_refused(&fx, &command, reason::NOT_AUTHORIZED).await;
    assert_eq!(
        fx.latest("command").await.unwrap().0.request.user,
        NOT_LOGGED_IN
    );
}

/// Run `request` while the catalog fetch is held; `change` runs between
/// step 2 and step 8.
async fn run_with_change_before_sending<F: std::future::Future<Output = ()>>(
    fx: &Fixture,
    request: &OperationWriteRequest,
    change: F,
) -> WriteResult {
    let hold = &fx.hub.state.catalog_hold;
    hold.on.store(true, Ordering::SeqCst);
    let (result, ()) = tokio::join!(fx.run(request), async {
        hold.arrived.notified().await;
        change.await;
        hold.release.notify_one();
    });
    hold.on.store(false, Ordering::SeqCst);
    result
}

async fn assert_stopped_before_sending(fx: &Fixture, result: &WriteResult, code: &str) {
    assert_eq!(result.outcome, Outcome::Refused, "{result:?}");
    assert_eq!(result.reason.as_deref(), Some(code));
    assert!(fx.hub.writes().is_empty(), "sent");
    // The `pending` row of step 6 is finished as the refusal.
    let finish = fx.finished("command").await;
    assert_eq!(finish.outcome, Outcome::Refused);
    assert_eq!(finish.reason.as_deref(), Some(code));
    assert_eq!(
        fx.latest("command").await.unwrap().0.id,
        result.record_id.clone().unwrap()
    );
}

#[tokio::test]
async fn a_phase_change_before_the_send_starts_stops_it() {
    let fx = Fixture::new().await;
    let result =
        run_with_change_before_sending(&fx, &button("command", 0, json!(true)), fx.transition())
            .await;
    assert_stopped_before_sending(&fx, &result, reason::PHASE_CHANGED).await;
}

#[tokio::test]
async fn an_auth_change_before_the_send_starts_stops_it() {
    let fx = Fixture::new().await;
    let request = button("command", 0, json!(true));
    // The local session's role changes.
    let result = run_with_change_before_sending(&fx, &request, async {
        let config = fx.auth.auth().settings().auth_config().await.unwrap();
        fx.auth
            .auth()
            .set_auth_config(&AuthSettings {
                disabled_role: Role::Viewer,
                ..config
            })
            .await
            .unwrap();
    })
    .await;
    assert_stopped_before_sending(&fx, &result, reason::AUTH_CHANGED).await;
    // The local session ends (auth-disabled mode off).
    let result = run_with_change_before_sending(&fx, &request, async {
        let config = fx.auth.auth().settings().auth_config().await.unwrap();
        fx.auth
            .auth()
            .set_auth_config(&AuthSettings {
                disabled: false,
                ..config
            })
            .await
            .unwrap();
    })
    .await;
    assert_stopped_before_sending(&fx, &result, reason::AUTH_CHANGED).await;
}

#[tokio::test]
async fn leaving_runtime_mode_before_the_send_starts_stops_it() {
    let fx = Fixture::new().await;
    let result = run_with_change_before_sending(&fx, &button("command", 0, json!(true)), async {
        fx.env.runtime.store(false, Ordering::SeqCst);
    })
    .await;
    assert_stopped_before_sending(&fx, &result, reason::NOT_RUNTIME).await;
}

#[tokio::test]
async fn a_change_after_the_send_started_does_not_stop_it() {
    let fx = Fixture::new().await;
    let hold = &fx.hub.state.write_hold;
    hold.on.store(true, Ordering::SeqCst);
    let request = button("command", 0, json!(true));
    let (result, ()) = tokio::join!(fx.run(&request), async {
        hold.arrived.notified().await;
        // The transition lock is free while the Hub has not answered.
        tokio::time::timeout(LONG, fx.transition())
            .await
            .expect("the send held the transition lock");
        assert_eq!(fx.auth.phase().await, AuthPhase::Operational);
        hold.release.notify_one();
    });
    assert_eq!(result.outcome, Outcome::Ok, "{result:?}");
    assert_eq!(fx.finished("command").await.outcome, Outcome::Ok);
    assert_eq!(fx.hub.writes().len(), 1);
}

#[tokio::test]
async fn a_second_write_while_one_is_sending_is_busy() {
    let fx = Fixture::new().await;
    let hold = &fx.hub.state.write_hold;
    hold.on.store(true, Ordering::SeqCst);
    let request = button("command", 0, json!(true));
    let (first, second) = tokio::join!(fx.run(&request), async {
        hold.arrived.notified().await;
        hold.on.store(false, Ordering::SeqCst);
        let second = fx.run(&button("mode", 0, json!(1))).await;
        hold.release.notify_one();
        second
    });
    assert_eq!(first.outcome, Outcome::Ok);
    assert_eq!(second.outcome, Outcome::Refused);
    assert_eq!(second.reason.as_deref(), Some(reason::BUSY));
    assert_eq!(
        fx.finished("mode").await.reason.as_deref(),
        Some(reason::BUSY)
    );
    assert_eq!(fx.hub.writes().len(), 1);
    // The slot is free again.
    assert_eq!(
        fx.run(&button("mode", 0, json!(1))).await.outcome,
        Outcome::Ok
    );
}

#[tokio::test]
async fn nothing_is_sent_when_the_pending_row_cannot_be_written() {
    let fx = Fixture::new().await;
    fx.log
        .db()
        .execute_for_test("CREATE TRIGGER fail_insert BEFORE INSERT ON operation BEGIN SELECT RAISE(ABORT, 'disk full'); END")
        .await;
    let result = fx.run(&button("command", 0, json!(true))).await;
    assert_eq!(result.outcome, Outcome::Refused);
    assert_eq!(result.reason.as_deref(), Some(reason::RECORD_FAILED));
    assert_eq!(result.record_id, None);
    assert!(result.unrecorded);
    assert!(fx.hub.writes().is_empty());
    fx.log
        .db()
        .execute_for_test("DROP TRIGGER fail_insert")
        .await;
    assert!(fx.latest("command").await.is_none());
    // The send slot was not kept.
    assert_eq!(
        fx.run(&button("command", 0, json!(true))).await.outcome,
        Outcome::Ok
    );
}

#[tokio::test]
async fn an_outcome_that_cannot_be_written_is_returned_and_shown_as_unrecorded() {
    let fx = Fixture::new().await;
    fx.log
        .db()
        .execute_for_test("CREATE TRIGGER fail_update BEFORE UPDATE ON operation BEGIN SELECT RAISE(ABORT, 'disk full'); END")
        .await;
    let result = fx.run(&button("command", 0, json!(true))).await;
    assert_eq!(result.outcome, Outcome::Ok);
    assert_eq!(result.audit_id, Some(42));
    assert!(result.unrecorded);
    let (row, state) = fx.latest("command").await.unwrap();
    assert_eq!(Some(row.id), result.record_id);
    let RecordState::Unrecorded {
        finish: Some(finish),
    } = state
    else {
        panic!("{state:?}");
    };
    assert_eq!(finish.outcome, Outcome::Ok);
    assert_eq!(finish.audit_id, Some(42));
    // The next write that reaches the record rewrites it; it is not re-sent.
    fx.log
        .db()
        .execute_for_test("DROP TRIGGER fail_update")
        .await;
    fx.run(&button("mode", 0, json!(1))).await;
    let finish = match fx.latest("command").await.unwrap().1 {
        RecordState::Finished(finish) => finish,
        other => panic!("{other:?}"),
    };
    assert_eq!(finish.outcome, Outcome::Ok);
    assert_eq!(fx.hub.writes().len(), 2);
}
