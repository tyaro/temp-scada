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
use crate::auth_phase::{AuthHost, Checkpoint};
use crate::operation_db::{OperationDb, RecordState, WriteState};
use crate::operation_key::WriteKey;

const READ_KEY: &str = "operation-read-test-only-key";
const WRITE_KEY: &str = "operation-write-test-only-key";
const REVISION: u64 = 5;
/// Bounds far beyond any loopback answer, so no case depends on timing.
const LONG: Duration = Duration::from_secs(20);
/// `GET /api/v1/status` of a Hub with the #1201 write contract (#1223) and
/// of one before it, which omits `capabilities` (§11-8). Both carry the
/// same `version` (upstream did not change it across #1201 and #1224), so
/// only `capabilities` can tell them apart.
const WITH_CONTRACT: &str =
    r#"{"version": "0.3.0-alpha.2", "capabilities": ["write_contract_v1"]}"#;
const BEFORE_CONTRACT: &str = r#"{"version": "0.3.0-alpha.2"}"#;

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
    /// The answer to `GET /api/v1/status` (§11-8).
    status: Mutex<(u16, &'static str)>,
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
            status: Mutex::new((200, WITH_CONTRACT)),
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
    } else if head.starts_with("GET /api/v1/status ") {
        let (status, body) = *state.status.lock().unwrap();
        respond(&mut stream, status, body).await;
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
    /// Calls of `now_ms` so far, and the call (1-based) that panics; 0 never.
    clock_calls: AtomicU64,
    panic_at_call: AtomicU64,
}

impl OperationEnv for TestEnv {
    fn now_ms(&self) -> i64 {
        let call = self.clock_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if call == self.panic_at_call.load(Ordering::SeqCst) {
            panic!("test: the clock panics at call {call}");
        }
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    fn is_runtime(&self) -> bool {
        self.runtime.load(Ordering::SeqCst)
    }
}

/// The keyring entry id of the fixture's write key.
const TEST_KEY_ID: &str = "test";

/// The record's side of the fixture's write key (`WriteKey::id` is
/// [`TEST_KEY_ID`]).
fn test_key(endpoint: &str) -> crate::operation_db::KeyRef {
    crate::operation_db::KeyRef {
        endpoint: endpoint.into(),
        id: TEST_KEY_ID.into(),
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
    /// `Some(Duration::ZERO)` unless a test checks the interval; `None` is
    /// the product's (the log's terminal setting).
    min_interval: Option<Duration>,
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
        let log = Arc::new(OperationLog::new(db));
        log.key_registered(0, &test_key(&hub.url)).await.unwrap();
        Self {
            hub,
            auth,
            log,
            env: Arc::new(TestEnv {
                runtime: AtomicBool::new(true),
                clock_calls: AtomicU64::new(0),
                panic_at_call: AtomicU64::new(0),
            }),
            project: project(),
            read,
            write,
            min_interval: Some(Duration::ZERO),
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
                read: Some(&self.read),
                subscribed_revision: Some(REVISION),
                write: Some(WriteKey {
                    endpoint: self.hub.url.clone(),
                    id: TEST_KEY_ID.into(),
                    client: self.write.clone(),
                }),
                timeout: LONG,
                min_interval: self.min_interval,
            },
        }
    }

    /// Set the Hub's answer to `GET /api/v1/status`.
    fn hub_status(&self, status: u16, body: &'static str) {
        *self.hub.state.status.lock().unwrap() = (status, body);
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

    async fn create_admin(&self) {
        self.auth
            .auth()
            .users()
            .create_user("chief", "correct-horse-1", "管理者", Role::Admin)
            .await
            .unwrap();
    }

    async fn transition(&self) {
        if !self.auth.auth().users().has_admin().await.unwrap() {
            self.create_admin().await;
        }
        self.auth
            .transition_to_operational("chief", "correct-horse-1", || true)
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
        // A tripped or refused key stops the terminal (§7); the next case
        // starts from a registered key.
        fx.log
            .key_registered(0, &test_key(&fx.hub.url))
            .await
            .unwrap();
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
    let fx = Fixture::new().await;
    let command = button("command", 0, json!(true));
    // §11-8: a Hub before #1223 omits `capabilities`; one that lists
    // others, fails or answers garbage is not confirmed either.
    for (status, body) in [
        (200, BEFORE_CONTRACT),
        (
            200,
            r#"{"version": "9.0.0", "capabilities": ["write_contract_v2"]}"#,
        ),
        (500, WITH_CONTRACT),
        (401, WITH_CONTRACT),
        (200, "not json"),
    ] {
        fx.hub_status(status, body);
        assert_refused(&fx, &command, reason::HUB_UNSUPPORTED).await;
    }
    fx.hub_status(200, WITH_CONTRACT);
    let mut context = fx.context();
    context.hub.write = None;
    let result = operation_write(&context, &command).await;
    assert_eq!(result.reason.as_deref(), Some(reason::NO_WRITE_KEY));
    context.hub.read = None;
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
    assert_eq!(row.request.user, "chief");
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
    // The local session ends (auth-disabled mode off, which Banto v8.0.0
    // allows only once an administrator exists).
    fx.auth
        .auth()
        .users()
        .create_user("chief", "correct-horse-1", "管理者", Role::Admin)
        .await
        .unwrap();
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

impl Fixture {
    /// Make the send task panic once the write has returned: in a sent
    /// write, `now_ms` is called for the request (1), then for the outcome in
    /// the send task (2).
    fn panic_after_the_send(&self) {
        self.env.clock_calls.store(0, Ordering::SeqCst);
        self.env.panic_at_call.store(2, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn a_send_task_that_panics_is_finished_uncertain_and_frees_the_slot() {
    let fx = Fixture::new().await;
    fx.panic_after_the_send();
    let result = fx.run(&button("command", 0, json!(true))).await;
    assert_eq!(result.outcome, Outcome::Uncertain, "{result:?}");
    assert_eq!(result.reason.as_deref(), Some(INTERRUPTED));
    assert!(!result.unrecorded);
    // Recorded, not left `Sending`.
    let finish = fx.finished("command").await;
    assert_eq!(finish.outcome, Outcome::Uncertain);
    assert_eq!(finish.reason.as_deref(), Some(INTERRUPTED));
    assert_eq!(fx.hub.writes().len(), 1);
    // The send slot is free: the next write is sent, the first is not re-sent.
    assert_eq!(
        fx.run(&button("mode", 0, json!(1))).await.outcome,
        Outcome::Ok
    );
    assert_eq!(fx.hub.writes().len(), 2);
}

#[tokio::test]
async fn a_send_task_that_panics_is_finished_even_when_the_caller_stops_waiting() {
    let fx = Fixture::new().await;
    let hold = &fx.hub.state.write_hold;
    hold.on.store(true, Ordering::SeqCst);
    fx.panic_after_the_send();
    let request = button("command", 0, json!(true));
    // The caller goes away while the Hub holds the write.
    tokio::select! {
        _ = fx.run(&request) => panic!("the write returned while the Hub held it"),
        () = hold.arrived.notified() => {}
    }
    hold.on.store(false, Ordering::SeqCst);
    hold.release.notify_one();
    let mut finish = None;
    for _ in 0..200 {
        if let Some((_, RecordState::Finished(done))) = fx.latest("command").await {
            finish = Some(done);
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let finish = finish.expect("the row was finished");
    assert_eq!(finish.outcome, Outcome::Uncertain);
    assert_eq!(finish.reason.as_deref(), Some(INTERRUPTED));
    assert_eq!(
        fx.run(&button("mode", 0, json!(1))).await.outcome,
        Outcome::Ok
    );
    assert_eq!(fx.hub.writes().len(), 2);
}

#[tokio::test]
async fn a_panicked_send_whose_outcome_cannot_be_written_reads_as_unrecorded() {
    let fx = Fixture::new().await;
    fx.log
        .db()
        .execute_for_test("CREATE TRIGGER fail_update BEFORE UPDATE ON operation BEGIN SELECT RAISE(ABORT, 'disk full'); END")
        .await;
    fx.panic_after_the_send();
    let result = fx.run(&button("command", 0, json!(true))).await;
    assert_eq!(result.outcome, Outcome::Uncertain);
    assert!(result.unrecorded);
    let RecordState::Unrecorded {
        finish: Some(finish),
    } = fx.latest("command").await.unwrap().1
    else {
        panic!("not unrecorded");
    };
    assert_eq!(finish.reason.as_deref(), Some(INTERRUPTED));
    // The slot is free; the next write is refused by the record, not `busy`.
    let next = fx.run(&button("mode", 0, json!(1))).await;
    assert_ne!(next.reason.as_deref(), Some(reason::BUSY), "{next:?}");
}

// The operation rows of the faceplate (`operation_view`, §8, O3a).

impl Fixture {
    fn view_context(&self) -> ViewContext<'_> {
        let write = self.context();
        ViewContext {
            env: write.env,
            auth: write.auth,
            log: Some(write.log),
            project: write.project,
            hub: write.hub,
        }
    }

    async fn view(&self) -> OperationView {
        view_with(&self.view_context()).await
    }
}

async fn view_with(context: &ViewContext<'_>) -> OperationView {
    let request = OperationViewRequest {
        equipment_id: PUMP.into(),
    };
    operation_view(context, &request).await.unwrap()
}

fn slot<'a>(view: &'a OperationView, name: &str) -> Option<&'a LatestRow> {
    view.slots
        .iter()
        .find(|slot| slot.slot == name)
        .expect("a write slot")
        .latest
        .as_ref()
}

#[tokio::test]
async fn the_view_lists_the_write_slots_with_their_last_requests() {
    let fx = Fixture::new().await;
    let view = fx.view().await;
    assert_eq!(view.project_id.as_deref(), Some(PROJECT_ID));
    assert_eq!(view.project_digest.as_deref(), Some(DIGEST));
    assert_eq!(view.blocked, None);
    assert_eq!(view.phase, "initializing");
    let names: Vec<&str> = view.slots.iter().map(|slot| slot.slot.as_str()).collect();
    assert_eq!(names, ["command", "speedSp", "mode", "spare"]);
    assert!(view.slots.iter().all(|slot| slot.latest.is_none()));
    // Reading records nothing.
    assert!(fx.latest("command").await.is_none());

    let sent = fx.run(&button("command", 0, json!(true))).await;
    fx.run(&button("command", 1, json!(false))).await;
    fx.run(&button("spare", 0, json!(true))).await;
    let view = fx.view().await;
    let command = slot(&view, "command").unwrap();
    assert_ne!(Some(command.id.clone()), sent.record_id, "the last one");
    assert_eq!(command.state, LatestState::Finished);
    assert_eq!(command.outcome, Some(Outcome::Ok));
    assert_eq!(command.reason, None);
    assert_eq!(command.audit_id, Some(42));
    assert_eq!(command.tag.as_deref(), Some(COMMAND_TAG));
    assert_eq!(command.value, Some(json!(false)));
    assert!(command.finished_at_ms.unwrap() >= command.requested_at_ms);
    let spare = slot(&view, "spare").unwrap();
    assert_eq!(spare.outcome, Some(Outcome::Refused));
    assert_eq!(spare.reason.as_deref(), Some(reason::UNBOUND));
    assert_eq!(spare.tag, None);
    assert!(slot(&view, "mode").is_none());
    // The webview's shape.
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(json["blocked"], Value::Null);
    assert_eq!(json["slots"][0]["latest"]["state"], "finished");
    assert_eq!(json["slots"][0]["latest"]["outcome"], "ok");
    assert_eq!(json["slots"][0]["latest"]["auditId"], 42);
    assert!(json["slots"][0]["latest"]["finishedAtMs"].is_i64());
    assert_eq!(json["slots"][1]["latest"], Value::Null);
}

#[tokio::test]
async fn the_view_hides_every_row_when_one_cannot_be_read() {
    let fx = Fixture::new().await;
    fx.run(&button("command", 0, json!(true))).await;
    fx.run(&button("spare", 0, json!(true))).await;
    // `spare` (the last slot) holds a user that is not text: unreadable.
    fx.log
        .db()
        .execute_for_test("UPDATE operation SET user = X'FF' WHERE slot = 'spare'")
        .await;
    let view = fx.view().await;
    assert_eq!(view.blocked, Some(reason::RECORD_FAILED));
    assert_eq!(view.slots.len(), 4);
    // `command` was read before `spare` failed, and is not shown either.
    assert!(view.slots.iter().all(|slot| slot.latest.is_none()));
}

#[tokio::test]
async fn the_view_shows_the_row_being_sent_and_busy() {
    let fx = Fixture::new().await;
    let hold = &fx.hub.state.write_hold;
    hold.on.store(true, Ordering::SeqCst);
    let request = button("command", 0, json!(true));
    let (result, view) = tokio::join!(fx.run(&request), async {
        hold.arrived.notified().await;
        hold.on.store(false, Ordering::SeqCst);
        let view = fx.view().await;
        hold.release.notify_one();
        view
    });
    assert_eq!(view.blocked, Some(reason::BUSY));
    let command = slot(&view, "command").unwrap();
    assert_eq!(Some(command.id.clone()), result.record_id);
    assert_eq!(command.state, LatestState::Sending);
    assert_eq!(command.outcome, None);
    assert_eq!(command.finished_at_ms, None);
    assert_eq!(command.value, Some(json!(true)));
    let view = fx.view().await;
    assert_eq!(view.blocked, None);
    assert_eq!(slot(&view, "command").unwrap().state, LatestState::Finished);
}

#[tokio::test]
async fn the_view_shows_unrecorded_rows_with_and_without_their_outcome() {
    let fx = Fixture::new().await;
    fx.log
        .db()
        .execute_for_test("CREATE TRIGGER fail_update BEFORE UPDATE ON operation BEGIN SELECT RAISE(ABORT, 'disk full'); END")
        .await;
    let result = fx.run(&button("command", 0, json!(true))).await;
    assert!(result.unrecorded);
    // A row an earlier process left `pending`.
    let mut earlier = fx.latest("command").await.unwrap().0.request;
    earlier.slot = "mode".into();
    fx.log
        .db()
        .insert_pending("earlier", &earlier)
        .await
        .unwrap();

    let view = fx.view().await;
    let command = slot(&view, "command").unwrap();
    assert_eq!(command.state, LatestState::Unrecorded);
    assert_eq!(command.outcome, Some(Outcome::Ok));
    assert_eq!(command.audit_id, Some(42));
    assert!(command.finished_at_ms.is_some());
    let mode = slot(&view, "mode").unwrap();
    assert_eq!(mode.id, "earlier");
    assert_eq!(mode.state, LatestState::Unrecorded);
    assert_eq!(mode.outcome, None);
    assert_eq!(mode.reason, None);
    assert_eq!(mode.finished_at_ms, None);
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(json["slots"][2]["latest"]["state"], "unrecorded");
    assert_eq!(json["slots"][2]["latest"]["outcome"], Value::Null);
}

/// `blocked` is the write's own steps 2 and 5: the write with the same
/// context is refused with the same code.
async fn assert_blocked(fx: &Fixture, context: ViewContext<'_>, code: &str, phase: &str) {
    let view = view_with(&context).await;
    assert_eq!(view.blocked, Some(code));
    assert_eq!(view.phase, phase);
    let write = OperationWrite {
        env: context.env,
        auth: context.auth,
        log: fx.log.clone(),
        project: context.project,
        hub: context.hub,
    };
    let result = operation_write(&write, &button("command", 0, json!(true))).await;
    assert_eq!(result.reason.as_deref(), Some(code), "{result:?}");
}

#[tokio::test]
async fn the_view_is_blocked_by_the_rules_of_the_write() {
    let fx = Fixture::new().await;
    fx.env.runtime.store(false, Ordering::SeqCst);
    assert_blocked(&fx, fx.view_context(), reason::NOT_RUNTIME, "initializing").await;
    fx.env.runtime.store(true, Ordering::SeqCst);
    let mut context = fx.view_context();
    context.auth = None;
    assert_blocked(&fx, context, reason::AUTH_UNAVAILABLE, PHASE_UNKNOWN).await;
    let mut context = fx.view_context();
    context.project = None;
    let view = view_with(&context).await;
    assert_eq!(view.project_id, None);
    assert!(view.slots.is_empty());
    assert_blocked(&fx, context, reason::PROJECT_CHANGED, "initializing").await;
    let mut context = fx.view_context();
    context.hub.write = None;
    assert_blocked(&fx, context, reason::NO_WRITE_KEY, "initializing").await;
    fx.hub_status(200, BEFORE_CONTRACT);
    assert_blocked(
        &fx,
        fx.view_context(),
        reason::HUB_UNSUPPORTED,
        "initializing",
    )
    .await;
    fx.hub_status(200, WITH_CONTRACT);
    // No read client: the contract cannot be asked. (The write stops at
    // step 4's `catalog_unavailable` before it asks.)
    let mut context = fx.view_context();
    context.hub.read = None;
    let view = view_with(&context).await;
    assert_eq!(view.blocked, Some(reason::HUB_UNSUPPORTED));
    // The record could not be opened: the slots are listed without rows.
    let mut context = fx.view_context();
    context.log = None;
    let view = view_with(&context).await;
    assert_eq!(view.blocked, Some(reason::RECORD_FAILED));
    assert_eq!(view.slots.len(), 4);
    assert!(view.slots.iter().all(|slot| slot.latest.is_none()));
    // A transition stopped after its first step, then the operation phase.
    fx.create_admin().await;
    // (A wrong password is refused before step 1, so stop it there instead.)
    assert!(fx
        .auth
        .transition_with("chief", "correct-horse-1", || true, &mut |point| {
            point != Checkpoint::Transitioning
        })
        .await
        .is_err());
    assert_blocked(
        &fx,
        fx.view_context(),
        reason::PHASE_UNAVAILABLE,
        "transitioning",
    )
    .await;
    fx.transition().await;
    assert_blocked(
        &fx,
        fx.view_context(),
        reason::NOT_AUTHORIZED,
        "operational",
    )
    .await;
}

#[tokio::test]
async fn the_view_refuses_an_unknown_or_malformed_equipment() {
    let fx = Fixture::new().await;
    let context = fx.view_context();
    for (id, code) in [
        ("nope".to_owned(), reason::UNKNOWN_EQUIPMENT),
        (String::new(), reason::INVALID_REQUEST),
        ("x".repeat(129), reason::INVALID_REQUEST),
    ] {
        let request = OperationViewRequest { equipment_id: id };
        assert_eq!(operation_view(&context, &request).await, Err(code));
    }
    // Another pump of the type: the same slots, bound or not.
    let request = OperationViewRequest {
        equipment_id: super::tests::OTHER_PUMP.into(),
    };
    let other = operation_view(&context, &request).await.unwrap();
    assert_eq!(other.slots.len(), 4);
    let request: OperationViewRequest =
        serde_json::from_value(json!({"equipmentId": PUMP})).unwrap();
    assert_eq!(request.equipment_id, PUMP);
    assert!(serde_json::from_value::<OperationViewRequest>(
        json!({"equipmentId": PUMP, "projectId": "x"})
    )
    .is_err());
}

#[tokio::test]
async fn a_tripped_key_stops_later_writes_without_sending() {
    let fx = Fixture::new().await;
    fx.hub
        .reply(Reply::Status(403, r#"{"error":"key_tripped"}"#));
    let command = button("command", 0, json!(true));
    let result = fx.run(&command).await;
    assert_eq!(result.outcome, Outcome::Stopped);
    assert_eq!(fx.hub.writes().len(), 1);
    fx.hub.reply(Reply::Status(200, r#"{"audit_id": 43}"#));
    assert_refused_after_send(&fx, &command, reason::WRITE_STOPPED).await;
    let view = fx.view().await;
    assert_eq!(view.blocked, Some(reason::WRITE_STOPPED));
    // Resumed on the screen: the next write is sent and the Hub checks it.
    assert!(fx.log.resume(0).await.unwrap());
    assert_eq!(fx.run(&command).await.outcome, Outcome::Ok);
    assert_eq!(fx.hub.writes().len(), 2);
}

#[tokio::test]
async fn a_refused_key_makes_later_writes_key_invalid() {
    let fx = Fixture::new().await;
    fx.hub
        .reply(Reply::Status(401, r#"{"error":"unauthorized"}"#));
    let command = button("command", 0, json!(true));
    assert_eq!(fx.run(&command).await.outcome, Outcome::NotSent);
    assert_refused_after_send(&fx, &command, reason::KEY_INVALID).await;
    assert_eq!(fx.view().await.blocked, Some(reason::KEY_INVALID));
    // The contract and the key come first (§4-5).
    fx.hub_status(200, BEFORE_CONTRACT);
    assert_refused_after_send(&fx, &command, reason::HUB_UNSUPPORTED).await;
}

#[tokio::test]
async fn a_write_inside_the_minimum_interval_is_too_soon() {
    let mut fx = Fixture::new().await;
    fx.min_interval = Some(Duration::from_secs(60));
    let command = button("command", 0, json!(true));
    assert_eq!(fx.run(&command).await.outcome, Outcome::Ok);
    assert_refused_after_send(&fx, &command, reason::TOO_SOON).await;
    // The view does not show `too_soon`: it depends on when the next
    // request comes.
    assert_eq!(fx.view().await.blocked, None);
    // With no interval the next write goes.
    fx.min_interval = Some(Duration::ZERO);
    assert_eq!(fx.run(&command).await.outcome, Outcome::Ok);
}

/// The product reads the terminal setting at the check (O2c-4b, #324
/// owner's review): an interval saved while a write waits for the catalog
/// applies to that write, which has not been checked yet.
#[tokio::test]
async fn an_interval_saved_while_a_write_waits_for_the_catalog_applies_to_it() {
    let mut fx = Fixture::new().await;
    fx.min_interval = None;
    fx.log.set_min_interval(100).await.unwrap();
    let command = button("command", 0, json!(true));
    assert_eq!(fx.run(&command).await.outcome, Outcome::Ok);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let sent = fx.hub.writes().len();
    let result = run_with_change_before_sending(&fx, &command, async {
        fx.log.set_min_interval(60_000).await.unwrap();
    })
    .await;
    assert_eq!(result.outcome, Outcome::Refused, "{result:?}");
    assert_eq!(result.reason.as_deref(), Some(reason::TOO_SOON));
    assert_eq!(fx.hub.writes().len(), sent);
    // Back to the short interval, the next write goes.
    fx.log.set_min_interval(100).await.unwrap();
    assert_eq!(fx.run(&command).await.outcome, Outcome::Ok);
}

/// A refusal after earlier sends: recorded, nothing more sent.
async fn assert_refused_after_send(fx: &Fixture, request: &OperationWriteRequest, code: &str) {
    let sent = fx.hub.writes().len();
    let result = fx.run(request).await;
    assert_eq!(result.outcome, Outcome::Refused, "{code}: {result:?}");
    assert_eq!(result.reason.as_deref(), Some(code));
    let (row, _) = fx.latest(&request.slot_name).await.unwrap();
    assert_eq!(Some(row.id), result.record_id, "{code}");
    assert_eq!(fx.hub.writes().len(), sent, "{code}: sent");
}

#[tokio::test]
async fn a_key_of_another_hub_is_never_used() {
    let fx = Fixture::new().await;
    let command = button("command", 0, json!(true));
    let mut context = fx.context();
    context.hub.write.as_mut().unwrap().endpoint = "http://127.0.0.1:1".into();
    let result = operation_write(&context, &command).await;
    assert_eq!(result.reason.as_deref(), Some(reason::HUB_MISMATCH));
    // No read connection: no endpoint to match either.
    context.hub.endpoint = None;
    context.hub.write.as_mut().unwrap().endpoint = fx.hub.url.clone();
    let view = view_with(&ViewContext {
        env: context.env.clone(),
        auth: context.auth.clone(),
        log: Some(context.log.clone()),
        project: context.project,
        hub: HubAccess {
            endpoint: None,
            read: Some(&fx.read),
            subscribed_revision: Some(REVISION),
            write: context.hub.write.clone(),
            min_interval: Some(Duration::ZERO),
            timeout: LONG,
        },
    })
    .await;
    assert_eq!(view.blocked, Some(reason::HUB_MISMATCH));
    assert!(fx.hub.writes().is_empty());
}

#[tokio::test]
async fn a_key_registered_again_after_the_check_is_not_sent() {
    // The host loaded the key, then it was registered again (or deleted)
    // before step 6: the request is not sent with the previous key.
    let fx = Fixture::new().await;
    let command = button("command", 0, json!(true));
    fx.log
        .key_registered(
            0,
            &crate::operation_db::KeyRef {
                endpoint: fx.hub.url.clone(),
                id: "newer".into(),
            },
        )
        .await
        .unwrap();
    let result = fx.run(&command).await;
    assert_eq!(result.outcome, Outcome::Refused);
    assert_eq!(result.reason.as_deref(), Some(reason::KEY_CHANGED));
    assert!(result.record_id.is_some());
    assert!(fx.hub.writes().is_empty());
    assert_eq!(fx.log.write_status().state, WriteState::Ready);
}

#[tokio::test]
async fn a_key_changed_between_the_send_slot_and_the_send_is_not_sent() {
    // #321 review: the key is registered again (or deleted) after step 6
    // took the slot but before step 8 starts the send. The record's only
    // connection stops the write at its `pending` row (the slot taken);
    // the transition lock, taken then, keeps it before step 8 while the
    // key changes.
    for delete in [false, true] {
        let fx = Fixture::new().await;
        let command = button("command", 0, json!(true));
        let held = fx.log.db().hold_for_test().await;
        let change = async {
            while !fx.log.is_sending() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let gate = fx.auth.gate().await;
            drop(held);
            if delete {
                fx.log.key_deleted().await.unwrap();
            } else {
                fx.log
                    .key_registered(
                        0,
                        &crate::operation_db::KeyRef {
                            endpoint: fx.hub.url.clone(),
                            id: "newer".into(),
                        },
                    )
                    .await
                    .unwrap();
            }
            drop(gate);
        };
        let (result, ()) = tokio::join!(fx.run(&command), change);
        assert_eq!(result.outcome, Outcome::Refused, "delete: {delete}");
        assert_eq!(result.reason.as_deref(), Some(reason::KEY_CHANGED));
        assert!(fx.hub.writes().is_empty(), "delete: {delete}");
        let finish = fx.finished("command").await;
        assert_eq!(finish.reason.as_deref(), Some(reason::KEY_CHANGED));
        assert!(!fx.log.is_sending());
        assert_eq!(fx.log.write_status().state, WriteState::Ready);
    }
}
