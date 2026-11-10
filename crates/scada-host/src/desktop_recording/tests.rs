//! The recording commands over a gate of a native owner (§9 step 4-3-2):
//! argument and error shapes, the host without an owner, and the frame pump
//! (delivery bound to the attaching generation, the hold on an auth DB read
//! failure, the end on a new generation or a detach).
use std::path::PathBuf;

use scada_runtime::recording_host::test_support::{self, TestStoreDir};
use scada_runtime::recording_registry::RecordingRegistryOwnerSeed;
use tokio::sync::mpsc;
use tokio::time::timeout;

use super::*;
use crate::auth::AUTH_DB_FILE;
use crate::auth_phase::{AuthHost, AuthPhase};
use crate::desktop_auth::DesktopAuth;
use crate::recording_epoch::create_recording_root;

/// A fresh app data dir under the OS temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("scada-host-recording-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    async fn raw(&self) -> sqlx::SqlitePool {
        sqlx::SqlitePool::connect_with(
            sqlx::sqlite::SqliteConnectOptions::new().filename(self.0.join(AUTH_DB_FILE)),
        )
        .await
        .unwrap()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const PASSWORD: &str = "correct-horse-1";
/// The page that attaches in most tests.
const PAGE: u64 = 1;

struct Fixture {
    recording: DesktopRecording,
    gate: Arc<RecordingGate>,
    auth: DesktopAuth,
    scope: Value,
    _store: TestStoreDir,
    dir: TempDir,
}

/// `initializing`, with the auth and recording commands over one gate.
async fn initializing() -> Fixture {
    let dir = TempDir::new();
    let auth = Arc::new(AuthHost::start(&dir.0).await.unwrap());
    let (owner, store) = test_support::joined_owner();
    let seed = RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap();
    let context = test_support::context().as_value().clone();
    let (root, issuer, generation) = create_recording_root(&dir.0, seed, context.clone()).unwrap();
    let gate = Arc::new(RecordingGate::new(
        auth,
        root,
        issuer,
        generation.scope(context.clone()),
    ));
    let recording = DesktopRecording::with_interval(gate.clone(), Duration::from_millis(10));
    // The page most tests attach from, and the next page of its webview.
    recording.begin_page(PAGE);
    recording.begin_page(PAGE + 1);
    Fixture {
        recording,
        auth: DesktopAuth::with_gate(gate.clone()),
        gate,
        scope: generation.scope(context),
        _store: store,
        dir,
    }
}

/// `operational`, with the administrator logged in.
async fn operational() -> Fixture {
    let f = initializing().await;
    let moved = f
        .auth
        .transition_to_operational("admin", PASSWORD, "管理者")
        .await
        .unwrap();
    assert!(moved.signed_in);
    f
}

fn wire<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}

fn error_of<T>(result: Result<T, RecordingCommandError>) -> Value {
    match result {
        Ok(_) => panic!("expected a refusal"),
        Err(error) => wire(&error),
    }
}

fn lease(scope: &Value, id: &str, role: &str) -> Value {
    json!({"version":1, "kind":"recordingWireLeaseRequest", "scope":scope,
        "leaseRequestId":format!("{id}-lease"), "admissionId":id, "role":role,
        "requestedBudgetMs":5000})
}

fn attach(scope: &Value, id: &str) -> Value {
    json!({"version":1, "kind":"recordingWireAttachRequest", "scope":scope,
        "attachId":id, "afterRevision":null})
}

fn detach(scope: &Value, id: &str, reference: &str) -> Value {
    json!({"version":1, "kind":"recordingWireControlRequest", "scope":scope,
        "controlId":id, "subscriptionRef":reference, "action":"detach"})
}

/// Reserve a workflow and admit its preflight, so the owner snapshot moves.
async fn preflight(f: &Fixture, change_id: &str) {
    let change = test_support::change(change_id);
    let reserved = f
        .recording
        .workflow_reserve(change.as_value().clone())
        .await
        .unwrap();
    assert_eq!(reserved.reply, json!({"changeId": change_id}));
    let lease = f
        .recording
        .workflow_lease("preflight", None, lease(&f.scope, "preflight", "mutation"))
        .await
        .unwrap();
    let admitted = f
        .recording
        .admission(json!({"version":1, "kind":"recordingAdmissionRequest",
            "ownerRef":f.scope["ownerRef"], "admissionId":"preflight",
            "context":f.scope["context"],
            "deadlineLeaseRef":lease.reply["outcome"]["deadlineLeaseRef"],
            "action":{"kind":"preflight", "change":change.as_value()}}))
        .await
        .unwrap();
    assert_eq!(admitted.reply["outcome"]["kind"], "accepted");
}

/// Run `pump` in the background, its events into the returned receiver.
fn spawn(
    pump: FramePump,
) -> (
    mpsc::UnboundedReceiver<RecordingEvent>,
    tokio::task::JoinHandle<()>,
) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let task = tokio::spawn(pump.run(
        move |event| sender.send(event).is_ok(),
        std::future::pending(),
    ));
    (receiver, task)
}

async fn next(receiver: &mut mpsc::UnboundedReceiver<RecordingEvent>) -> RecordingEvent {
    timeout(Duration::from_secs(10), receiver.recv())
        .await
        .expect("the pump delivers")
        .expect("the pump is running")
}

#[tokio::test]
async fn a_host_without_a_recording_owner_answers_why() {
    let recording = DesktopRecording::unavailable(NO_RECORDING_OWNER);
    let unavailable = json!({"kind": "recordingUnavailable", "reason": "no_recording_owner"});
    assert_eq!(
        error_of(recording.workflow_reserve(json!({})).await),
        unavailable
    );
    assert_eq!(
        error_of(recording.workflow_lease("preflight", None, json!({})).await),
        unavailable
    );
    assert_eq!(error_of(recording.lease(json!({})).await), unavailable);
    assert_eq!(error_of(recording.admission(json!({})).await), unavailable);
    assert_eq!(
        error_of(recording.admission_inspection(json!({})).await),
        unavailable
    );
    assert_eq!(
        error_of(recording.observation(json!({})).await),
        unavailable
    );
    assert_eq!(error_of(recording.cancel(json!({})).await), unavailable);
    assert_eq!(
        error_of(recording.call_inspection(json!({})).await),
        unavailable
    );
    assert_eq!(
        error_of(recording.attach(json!({}), PAGE).await),
        unavailable
    );
    assert_eq!(error_of(recording.control(json!({})).await), unavailable);
}

#[tokio::test]
async fn arguments_are_checked_and_refusals_keep_their_kind() {
    let f = initializing().await;
    let invalid = json!({"kind": "invalidRequest"});
    assert_eq!(
        error_of(f.recording.lease(json!({"kind": "nonsense"})).await),
        invalid
    );
    // A stage and its operation ID go together.
    for (stage, operation) in [
        ("pauseJoin", None),
        ("apply", None),
        ("preflight", Some("op")),
        ("discard", Some("op")),
        ("reconcile", None),
    ] {
        assert_eq!(
            error_of(
                f.recording
                    .workflow_lease(
                        stage,
                        operation.map(str::to_owned),
                        lease(&f.scope, "x", "mutation")
                    )
                    .await
            ),
            invalid,
            "{stage}"
        );
    }
    // A mutation lease outside a workflow, and a stage before the
    // reservation (design §5).
    assert_eq!(
        error_of(
            f.recording
                .lease(lease(&f.scope, "stray", "mutation"))
                .await
        ),
        json!({"kind": "forbidden"})
    );
    assert_eq!(
        error_of(
            f.recording
                .workflow_lease("preflight", None, lease(&f.scope, "early", "mutation"))
                .await
        ),
        json!({"kind": "invalidInput"})
    );
    // A reply carries the generation it was produced under.
    let leased = f
        .recording
        .lease(lease(&f.scope, "read", "reconciliation"))
        .await
        .unwrap();
    assert_eq!(leased.seq, f.auth.resolve().await.unwrap().current);
    assert_eq!(leased.reply["kind"], "recordingWireLeaseReply");

    // The gate's own refusals.
    assert_eq!(
        wire(&RecordingCommandError::Gate(GateError::Phase(
            AuthPhase::Transitioning
        ))),
        json!({"kind": "phase", "phase": "transitioning"})
    );
    assert_eq!(
        wire(&RecordingCommandError::Gate(GateError::Unauthorized)),
        json!({"kind": "unauthorized"})
    );
    assert_eq!(
        wire(&RecordingCommandError::Gate(GateError::Registry(
            LeaseError::Busy
        ))),
        json!({"kind": "busy"})
    );
}

#[tokio::test]
async fn the_pump_delivers_to_the_attaching_generation_and_ends_at_a_new_one() {
    let f = operational().await;
    let (attached, pump) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE)
        .await
        .unwrap();
    let reference = attached.reply["outcome"]["subscriptionRef"]
        .as_str()
        .unwrap()
        .to_owned();
    let pump = pump.expect("a new subscription gets a pump");
    assert_eq!(pump.subscription_ref(), reference);
    // A replayed attach answers the same reply and starts no second pump.
    let (again, second) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE)
        .await
        .unwrap();
    assert_eq!(again, attached);
    assert!(second.is_none());

    let (mut events, task) = spawn(pump);
    preflight(&f, "pump-change").await;
    let RecordingEvent::Frames {
        subscription_ref,
        owner_epoch,
        seq,
        state,
        control,
    } = next(&mut events).await
    else {
        panic!("frames first");
    };
    assert_eq!(subscription_ref, reference);
    // The root's epoch rides on every event (product-owner design §7.2).
    assert_eq!(owner_epoch, f.scope["ownerEpoch"].as_str().unwrap());
    assert_eq!(seq, attached.seq);
    assert_eq!(state.unwrap()["subscriptionRef"], reference.as_str());
    assert_eq!(control, None);

    // A logout ends the generation: the pump says so and stops, and the
    // frames never reach the next session.
    f.auth.logout().await.unwrap();
    loop {
        match next(&mut events).await {
            // The native preflight's completion may arrive before the logout.
            RecordingEvent::Frames { seq, .. } => assert_eq!(seq, attached.seq),
            ended => {
                assert_eq!(
                    wire(&ended),
                    json!({"kind": "ended", "subscriptionRef": reference,
                        "ownerEpoch": f.scope["ownerEpoch"], "reason": "unauthorized"})
                );
                break;
            }
        }
    }
    timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap();
    // The pump released the subscription; its replayed attach is refused
    // without a session.
    assert_eq!(
        error_of(f.recording.attach(attach(&f.scope, "attach-1"), PAGE).await),
        json!({"kind": "unauthorized"})
    );
}

#[tokio::test]
async fn an_auth_db_read_failure_holds_the_frame_until_the_next_delivery() {
    let f = operational().await;
    let (attached, pump) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE)
        .await
        .unwrap();
    preflight(&f, "held-change").await;
    let raw = f.dir.raw().await;
    sqlx::query("ALTER TABLE users RENAME TO users_hidden")
        .execute(&raw)
        .await
        .unwrap();

    let (mut events, _task) = spawn(pump.unwrap());
    // Several deliveries fail to re-validate: nothing is sent meanwhile.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(events.try_recv().is_err());

    sqlx::query("ALTER TABLE users_hidden RENAME TO users")
        .execute(&raw)
        .await
        .unwrap();
    let RecordingEvent::Frames { seq, state, .. } = next(&mut events).await else {
        panic!("the held frame is delivered");
    };
    assert_eq!(seq, attached.seq);
    assert!(state.is_some());
}

#[tokio::test]
async fn a_detach_ends_the_pump_and_a_released_subscription_gets_a_new_one() {
    let f = initializing().await;
    let (attached, pump) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE)
        .await
        .unwrap();
    let reference = attached.reply["outcome"]["subscriptionRef"]
        .as_str()
        .unwrap()
        .to_owned();
    // A pump that never ran releases the subscription when dropped.
    drop(pump);
    let (_, pump) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE)
        .await
        .unwrap();
    let (mut events, task) = spawn(pump.expect("released"));

    let detached = f
        .recording
        .control(detach(&f.scope, "detach-1", &reference))
        .await
        .unwrap();
    assert_eq!(detached.seq, attached.seq);
    assert_eq!(
        wire(&next(&mut events).await),
        json!({"kind": "ended", "subscriptionRef": reference, "ownerEpoch": f.scope["ownerEpoch"], "reason": "invalidInput"})
    );
    timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap();
}

/// Run `pump` until the returned sender is dropped (the page ends).
fn spawn_page(
    pump: FramePump,
) -> (
    tokio::sync::oneshot::Sender<()>,
    mpsc::UnboundedReceiver<RecordingEvent>,
    tokio::task::JoinHandle<()>,
) {
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let (sender, events) = mpsc::unbounded_channel();
    let task = tokio::spawn(pump.run(move |event| sender.send(event).is_ok(), async {
        let _ = stopped.await;
    }));
    (stop, events, task)
}

#[tokio::test]
async fn the_end_of_the_attaching_page_ends_its_subscription_in_the_registry() {
    let f = initializing().await;
    let (attached, pump) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE)
        .await
        .unwrap();
    let reference = attached.reply["outcome"]["subscriptionRef"].clone();
    let (stop, mut events, task) = spawn_page(pump.unwrap());
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(stop);
    timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap();
    // Nothing was delivered, no `ended` either: the page is gone.
    assert!(events.try_recv().is_err());
    // The subscription is over: a later page replaying its attach is told so.
    let (_, pump) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE + 1)
        .await
        .unwrap();
    let (mut events, _task) = spawn(pump.expect("the claim was released"));
    assert_eq!(
        wire(&next(&mut events).await),
        json!({"kind": "ended", "subscriptionRef": reference, "ownerEpoch": f.scope["ownerEpoch"], "reason": "unauthorized"})
    );
}

#[tokio::test]
async fn pages_that_end_free_their_live_subscriptions() {
    let f = initializing().await;
    // More pages than the registry's live subscriptions, one after another:
    // each ended page frees its slot for the next one.
    for page in 10..18 {
        f.recording.begin_page(page);
        let id = format!("attach-{page}");
        let (_, pump) = f
            .recording
            .attach(attach(&f.scope, &id), page)
            .await
            .unwrap_or_else(|error| panic!("page {page}: {}", wire(&error)));
        let (stop, _events, task) = spawn_page(pump.unwrap());
        drop(stop);
        timeout(Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn another_open_page_takes_the_subscription_over_at_once() {
    let f = initializing().await;
    let (_, pump) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE)
        .await
        .unwrap();
    let (old_stop, mut old_events, old_task) = spawn_page(pump.unwrap());
    // The same page again starts no second pump.
    let (_, again) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE)
        .await
        .unwrap();
    assert!(again.is_none());

    // Another webview's page replays the attach while the first page is
    // open: delivery moves to the new page at once.
    let (_, pump) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE + 1)
        .await
        .unwrap();
    let (mut events, _task) = spawn(pump.expect("the new page takes over"));
    // The old pump stops without ending the subscription, even when its
    // page end arrives afterwards.
    timeout(Duration::from_secs(10), old_task)
        .await
        .unwrap()
        .unwrap();
    drop(old_stop);
    preflight(&f, "takeover-change").await;
    let RecordingEvent::Frames { state, .. } = next(&mut events).await else {
        panic!("the new page receives the frames");
    };
    assert!(state.is_some());
    assert!(old_events.try_recv().is_err());
}

#[tokio::test]
async fn a_replay_from_the_next_page_finds_the_ended_subscription_before_the_old_pump_stops() {
    let f = initializing().await;
    let (attached, pump) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE)
        .await
        .unwrap();
    let reference = attached.reply["outcome"]["subscriptionRef"].clone();
    // The page ends, but its pump has not noticed (its stop never fires).
    let (_old_stop, mut old_events, old_task) = spawn_page(pump.unwrap());
    f.recording.end_page(PAGE);

    // The next page's replay ends the subscription and is told so.
    let (_, pump) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE + 1)
        .await
        .unwrap();
    let (mut events, _task) = spawn(pump.expect("the next page gets a pump"));
    assert_eq!(
        wire(&next(&mut events).await),
        json!({"kind": "ended", "subscriptionRef": reference, "ownerEpoch": f.scope["ownerEpoch"], "reason": "unauthorized"})
    );
    timeout(Duration::from_secs(10), old_task)
        .await
        .unwrap()
        .unwrap();
    assert!(old_events.try_recv().is_err());
}

#[tokio::test]
async fn a_page_that_ended_mid_delivery_receives_nothing_and_its_subscription_ends() {
    let f = initializing().await;
    let (attached, pump) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE)
        .await
        .unwrap();
    let reference = attached.reply["outcome"]["subscriptionRef"].clone();
    preflight(&f, "ended-page").await;
    // The pump's delivery re-validated the session and waits to take the
    // frame; meanwhile the page ends (the hook ran, the pump's `stop` has
    // not fired). The frame it then takes is for a page that is gone.
    let (taken, take) = tokio::sync::oneshot::channel::<()>();
    f.gate.after_next_call(async {
        let _ = take.await;
    });
    let (_old_stop, mut events, task) = spawn_page(pump.unwrap());
    tokio::time::sleep(Duration::from_millis(50)).await;
    f.recording.end_page(PAGE);
    taken.send(()).unwrap();
    timeout(Duration::from_secs(10), task)
        .await
        .unwrap()
        .unwrap();
    assert!(events.try_recv().is_err());
    // The subscription was ended in the registry.
    let (_, pump) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE + 1)
        .await
        .unwrap();
    let (mut events, _task) = spawn(pump.unwrap());
    assert_eq!(
        wire(&next(&mut events).await),
        json!({"kind": "ended", "subscriptionRef": reference, "ownerEpoch": f.scope["ownerEpoch"], "reason": "unauthorized"})
    );
}

#[tokio::test]
async fn only_open_pages_are_remembered() {
    let f = initializing().await;
    f.recording.end_page(PAGE);
    f.recording.end_page(PAGE + 1);
    for page in 10..18 {
        f.recording.begin_page(page);
        f.recording.end_page(page);
    }
    assert_eq!(f.recording.live_page_count(), 0);
}

#[tokio::test]
async fn an_attach_of_an_ended_page_never_takes_the_next_pages_subscription() {
    let f = initializing().await;
    // The next page has attached; the old page's attach, still in flight
    // when its page ended, reaches its claim only now.
    let (_, pump) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE + 1)
        .await
        .unwrap();
    let (mut events, _task) = spawn(pump.expect("the next page's pump"));
    f.recording.end_page(PAGE);
    let (_, stale) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE)
        .await
        .unwrap();
    assert!(stale.is_none());
    // The next page keeps its subscription and its frames.
    preflight(&f, "stale-attach").await;
    let RecordingEvent::Frames { state, .. } = next(&mut events).await else {
        panic!("the next page still receives the frames");
    };
    assert!(state.is_some());
}

#[tokio::test]
async fn an_attach_of_an_ended_page_that_no_open_page_holds_ends_its_subscription() {
    let f = initializing().await;
    // The page ended while its first attach ran: no pump, and the
    // subscription does not hold a live slot for nobody.
    f.recording.end_page(PAGE);
    let (attached, pump) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE)
        .await
        .unwrap();
    assert!(pump.is_none());
    let reference = attached.reply["outcome"]["subscriptionRef"].clone();
    let (_, pump) = f
        .recording
        .attach(attach(&f.scope, "attach-1"), PAGE + 1)
        .await
        .unwrap();
    let (mut events, _task) = spawn(pump.unwrap());
    assert_eq!(
        wire(&next(&mut events).await),
        json!({"kind": "ended", "subscriptionRef": reference, "ownerEpoch": f.scope["ownerEpoch"], "reason": "unauthorized"})
    );
}

#[tokio::test]
async fn the_end_of_a_page_frees_its_live_slots_before_its_pumps_stop() {
    let f = initializing().await;
    // The page holds every live subscription; its pumps never run, so only
    // `end_page` can free them.
    let mut pumps = Vec::new();
    for i in 0..4 {
        let (_, pump) = f
            .recording
            .attach(attach(&f.scope, &format!("old-{i}")), PAGE)
            .await
            .unwrap();
        pumps.push(pump.unwrap());
    }
    assert_eq!(
        error_of(
            f.recording
                .attach(attach(&f.scope, "one-too-many"), PAGE)
                .await
        ),
        json!({"kind": "capacity"})
    );
    f.recording.end_page(PAGE);
    // The next page attaches at once, while the old pumps still exist.
    for i in 0..4 {
        let (_, pump) = f
            .recording
            .attach(attach(&f.scope, &format!("new-{i}")), PAGE + 1)
            .await
            .unwrap_or_else(|error| panic!("new-{i}: {}", wire(&error)));
        assert!(pump.is_some());
    }
    drop(pumps);
}
