//! The recording commands and events through the real IPC of a mock app
//! (host-gate design §5, §9 step 4-3-2): with the Tauri commands alone, a
//! workflow runs from its reservation through the first preflight,
//! pause/join and apply to the original apply's reconcile, a mutation lease
//! asked first is `forbidden` without blocking the reservation, and a
//! subscription's frames arrive as `scada:recording` events until a logout
//! ends them. The behavior itself is tested in `scada_host::desktop_recording`
//! and `scada_host::recording_gate`.
use super::*;
use scada_host::auth_phase::AuthHost;
use scada_host::desktop_recording::RECORDING_EVENT;
use scada_host::recording_epoch::create_recording_root;
use scada_host::recording_gate::{RecordingGate, NO_RECORDING_RUN};
use scada_runtime::recording_host::test_support::{self, TestStoreDir};
use scada_runtime::recording_registry::RecordingRegistryOwnerSeed;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
use tauri::webview::{InvokeRequest, WebviewWindow};
use tauri::{test::MockRuntime, App, Listener, WebviewWindowBuilder};

/// A fresh app data dir under the OS temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "banto-scada-recording-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Host {
    app: App<MockRuntime>,
    webview: WebviewWindow<MockRuntime>,
    gate: Arc<RecordingGate>,
    events: mpsc::Receiver<Value>,
    scope: Value,
    _store: TestStoreDir,
    _dir: TempDir,
}

/// The first start of a host with a recording owner: the auth and recording
/// commands share one gate (`AuthState::with_gate`).
fn host() -> Host {
    let dir = TempDir::new();
    let auth = Arc::new(tauri::async_runtime::block_on(AuthHost::start(&dir.0)).unwrap());
    // The native owner runs its tasks on the app's async runtime.
    let context = test_support::context().as_value().clone();
    let (store, (root, issuer, generation)) = tauri::async_runtime::block_on(async {
        let (owner, store) = test_support::joined_owner();
        let seed = RecordingRegistryOwnerSeed::try_from_owner(owner).unwrap();
        (
            store,
            create_recording_root(&dir.0, seed, context.clone()).unwrap(),
        )
    });
    let gate = Arc::new(RecordingGate::new(
        auth,
        root,
        issuer,
        generation.scope(context.clone()),
    ));
    let app = commands(mock_builder())
        .manage(AuthState::with_gate(gate.clone()))
        .manage(DesktopRecording::with_interval(
            gate.clone(),
            Duration::from_millis(10),
        ))
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let events = listen(&webview);
    Host {
        app,
        webview,
        gate,
        events,
        scope: generation.scope(context),
        _store: store,
        _dir: dir,
    }
}

/// The recording events emitted to `webview` (each pump emits to the webview
/// that attached it only, `EventTarget::Webview`).
fn listen(webview: &WebviewWindow<MockRuntime>) -> mpsc::Receiver<Value> {
    let (sender, events) = mpsc::channel();
    AsRef::<tauri::Webview<MockRuntime>>::as_ref(webview).listen(RECORDING_EVENT, move |event| {
        let _ = sender.send(serde_json::from_str(event.payload()).unwrap());
    });
    events
}

fn invoke_on(webview: &WebviewWindow<MockRuntime>, cmd: &str, args: Value) -> Result<Value, Value> {
    get_ipc_response(
        webview,
        InvokeRequest {
            cmd: cmd.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}

impl Host {
    fn invoke(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        invoke_on(&self.webview, cmd, args)
    }

    /// Retry a call the registry answers `busy` until the native stage it
    /// waits for has completed.
    fn when_ready(&self, cmd: &str, args: Value) -> Value {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match self.invoke(cmd, args.clone()) {
                Err(error) if error["kind"] == "busy" && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(10))
                }
                other => return other.unwrap_or_else(|error| panic!("{cmd}: {error}")),
            }
        }
    }

    fn next_event(&self) -> Value {
        next(&self.events)
    }
}

fn next(events: &mpsc::Receiver<Value>) -> Value {
    events
        .recv_timeout(Duration::from_secs(10))
        .expect("the pump delivers")
}

fn lease(scope: &Value, id: &str, role: &str) -> Value {
    json!({"version":1, "kind":"recordingWireLeaseRequest", "scope":scope,
        "leaseRequestId":format!("{id}-lease"), "admissionId":id, "role":role,
        "requestedBudgetMs":5000})
}

fn admission(scope: &Value, id: &str, lease: &Value, action: Value) -> Value {
    json!({"version":1, "kind":"recordingAdmissionRequest", "ownerRef":scope["ownerRef"],
        "admissionId":id, "context":scope["context"],
        "deadlineLeaseRef":lease["reply"]["outcome"]["deadlineLeaseRef"], "action":action})
}

fn operation(change: &Value, id: &str, stage: &str) -> Value {
    json!({"version":1, "kind":"recordingOperationRequest", "operationId":id,
        "stage":stage, "change":change})
}

fn handle(reply: &Value, field: &str) -> Value {
    reply["reply"]["outcome"]["handle"][field].clone()
}

#[test]
fn the_tauri_commands_alone_run_a_workflow_to_the_original_apply_reconcile() {
    let h = host();
    let scope = &h.scope;
    let seq = h.invoke("auth_resolve", json!({})).unwrap()["current"].clone();

    // A mutation lease outside the workflow is refused and does not block
    // the reservation (design §5).
    assert_eq!(
        h.invoke(
            "recording_lease",
            json!({"request": lease(scope, "stray", "mutation")})
        )
        .unwrap_err(),
        json!({"kind": "forbidden"})
    );
    let change = test_support::change("ipc-change").as_value().clone();
    let reserved = h
        .invoke("recording_workflow_reserve", json!({"request": change}))
        .unwrap();
    assert_eq!(
        reserved,
        json!({"seq": seq, "reply": {"changeId": "ipc-change"}})
    );

    // A subscription delivers the workflow's revisions as events.
    let attached = h
        .invoke(
            "recording_attach",
            json!({"request": {"version":1, "kind":"recordingWireAttachRequest",
                "scope":scope, "attachId":"attach-1", "afterRevision":null}}),
        )
        .unwrap();
    assert_eq!(attached["seq"], seq);
    let reference = attached["reply"]["outcome"]["subscriptionRef"].clone();

    // Preflight.
    let leased = h
        .invoke(
            "recording_workflow_lease",
            json!({"stage": "preflight", "request": lease(scope, "preflight", "mutation")}),
        )
        .unwrap();
    let preflight = admission(
        scope,
        "preflight",
        &leased,
        json!({"kind":"preflight", "change":change}),
    );
    let accepted = h
        .invoke("recording_admission", json!({"request": preflight}))
        .unwrap();
    assert_eq!(accepted["seq"], seq);
    assert_eq!(accepted["reply"]["outcome"]["kind"], "accepted");
    let inspected = h
        .invoke(
            "recording_admission_inspection",
            json!({"request": {"version":1, "kind":"recordingAdmissionInspectionRequest",
                "inspectionId":"inspect-preflight", "original":preflight}}),
        )
        .unwrap();
    assert_eq!(inspected["seq"], seq);
    let frame = h.next_event();
    assert_eq!(frame["kind"], "frames");
    assert_eq!(frame["subscriptionRef"], reference);
    assert_eq!(frame["seq"], seq);
    assert_eq!(frame["state"]["subscriptionRef"], reference);

    // Pause/join, once the Candidate is ready.
    let leased = h.when_ready(
        "recording_workflow_lease",
        json!({"stage": "pauseJoin", "operationId": "pause:ipc",
            "request": lease(scope, "pause", "mutation")}),
    );
    let paused = h
        .invoke(
            "recording_admission",
            json!({"request": admission(scope, "pause", &leased,
                json!({"kind":"pauseJoin", "changeRef":handle(&accepted, "changeRef"),
                    "operation":operation(&change, "pause:ipc", "pauseJoin")}))}),
        )
        .unwrap();
    assert_eq!(paused["reply"]["outcome"]["kind"], "accepted");

    // Apply, once paused; its native response is lost, so the original
    // apply needs a reconcile.
    let leased = h.when_ready(
        "recording_workflow_lease",
        json!({"stage": "apply", "operationId": "apply:ipc",
            "request": lease(scope, "apply", "mutation")}),
    );
    h.gate.test_lose_next_apply_response();
    let apply_operation = operation(&change, "apply:ipc", "apply");
    let applied = h
        .invoke(
            "recording_admission",
            json!({"request": admission(scope, "apply", &leased,
                json!({"kind":"apply", "changeRef":handle(&paused, "changeRef"),
                    "operation":apply_operation}))}),
        )
        .unwrap();
    assert_eq!(applied["reply"]["outcome"]["kind"], "accepted");
    let observed = h
        .invoke(
            "recording_observation",
            json!({"request": {"version":1, "kind":"recordingWireObservationRequest",
                "scope":scope, "observationId":"observe-apply",
                "target":{"kind":"operation", "operationRef":"apply:ipc",
                    "request":apply_operation}}}),
        )
        .unwrap();
    assert_eq!(observed["seq"], seq);

    // Reconcile the original apply with a read lease.
    let read_lease = lease(scope, "reconcile", "reconciliation");
    let leased = h
        .invoke("recording_lease", json!({"request": read_lease}))
        .unwrap();
    let reconcile = admission(
        scope,
        "reconcile",
        &leased,
        json!({"kind":"reconcile", "changeRef":handle(&applied, "changeRef"),
            "operationRef":handle(&applied, "operationRef"),
            "reconciliation":{"version":1, "kind":"recordingReconciliationRequest",
                "reconciliationId":"read:original-apply", "operation":apply_operation}}),
    );
    let reconciled = h.when_ready("recording_admission", json!({"request": reconcile}));
    assert_eq!(reconciled["seq"], seq);
    assert_eq!(reconciled["reply"]["outcome"]["kind"], "accepted");

    // The read lease call is recovered by call inspection, and a cancel of
    // an unknown read answers as the registry does.
    let recovered = h
        .invoke(
            "recording_call_inspection",
            json!({"request": {"version":1, "kind":"recordingWireCallInspectionRequest",
                "scope":scope, "callInspectionId":"inspect-lease", "original":read_lease}}),
        )
        .unwrap();
    assert_eq!(recovered["seq"], seq);
    let cancelled = h
        .invoke(
            "recording_cancel",
            json!({"request": {"version":1, "kind":"recordingWireCancelRequest",
                "scope":scope, "cancelId":"cancel-1",
                "target":{"kind":"reconciliation", "ref":"missing"}}}),
        )
        .unwrap();
    assert_eq!(cancelled["reply"]["outcome"]["kind"], "rejected");
    let snapshot = h
        .invoke(
            "recording_control",
            json!({"request": {"version":1, "kind":"recordingWireControlRequest",
                "scope":scope, "controlId":"snapshot-1", "subscriptionRef":reference,
                "action":"snapshot"}}),
        )
        .unwrap();
    assert_eq!(snapshot["seq"], seq);
}

#[test]
fn a_logout_ends_the_subscription_events_of_its_generation() {
    let h = host();
    let scope = &h.scope;
    let moved = h
        .invoke(
            "auth_transition_to_operational",
            json!({"username": "admin", "password": "correct-horse-1", "displayName": "管理者"}),
        )
        .unwrap();
    let attached = h
        .invoke(
            "recording_attach",
            json!({"request": {"version":1, "kind":"recordingWireAttachRequest",
                "scope":scope, "attachId":"attach-1", "afterRevision":null}}),
        )
        .unwrap();
    assert_eq!(attached["seq"], moved["seq"]);
    let reference = attached["reply"]["outcome"]["subscriptionRef"].clone();

    // A listener of the webview window of the same label is not the
    // webview's: it receives nothing.
    let (sender, window_events) = mpsc::channel::<String>();
    h.webview.listen(RECORDING_EVENT, move |event| {
        let _ = sender.send(event.payload().to_owned());
    });
    h.invoke("auth_logout", json!({})).unwrap();
    assert_eq!(
        h.next_event(),
        json!({"kind": "ended", "subscriptionRef": reference, "reason": "unauthorized"})
    );
    assert!(window_events.try_recv().is_err());
    assert_eq!(
        h.invoke(
            "recording_attach",
            json!({"request": {"version":1, "kind":"recordingWireAttachRequest",
                "scope":scope, "attachId":"attach-2", "afterRevision":null}}),
        )
        .unwrap_err(),
        json!({"kind": "unauthorized"})
    );
}

#[test]
fn taking_the_root_out_ends_its_subscription_with_owner_closed() {
    let h = host();
    let scope = &h.scope;
    let attached = h
        .invoke(
            "recording_attach",
            json!({"request": {"version":1, "kind":"recordingWireAttachRequest",
                "scope":scope, "attachId":"attach-1", "afterRevision":null}}),
        )
        .unwrap();
    let reference = attached["reply"]["outcome"]["subscriptionRef"].clone();

    // The handoff the stop and the resume use (product-owner design §4).
    tauri::async_runtime::block_on(async {
        let lock = h.gate.auth().gate().await;
        assert!(h.gate.try_take(&lock, NO_RECORDING_RUN).unwrap().is_some());
    });
    let closed = loop {
        let event = h.next_event();
        assert_eq!(event["subscriptionRef"], reference);
        assert_eq!(event["kind"], "frames", "{event}");
        if !event["control"].is_null() {
            break event;
        }
    };
    assert_eq!(closed["control"]["reason"], "ownerClosed");
    assert_eq!(closed["control"]["scope"], *scope);
    // The registry commands end with the root.
    assert_eq!(
        h.invoke(
            "recording_lease",
            json!({"request": lease(scope, "after", "reconciliation")})
        )
        .unwrap_err(),
        json!({"kind": "recordingUnavailable", "reason": "no_recording_run"})
    );
    // The pump delivers nothing after the control frame.
    assert!(h.events.recv_timeout(Duration::from_millis(100)).is_err());
}

#[test]
fn a_host_with_an_empty_slot_answers_why() {
    let dir = TempDir::new();
    // The product host before any recording runs (product-owner design §4).
    let (auth, recording) =
        tauri::async_runtime::block_on(AuthState::start(&dir.0, "no_recording_run"));
    let app = commands(mock_builder())
        .manage(auth)
        .manage(recording)
        .build(mock_context(noop_assets()))
        .unwrap();
    let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let h = |cmd: &str, args: Value| {
        get_ipc_response(
            &webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|body| body.deserialize::<Value>().unwrap())
    };
    for cmd in [
        "recording_workflow_reserve",
        "recording_lease",
        "recording_admission",
        "recording_admission_inspection",
        "recording_observation",
        "recording_cancel",
        "recording_call_inspection",
        "recording_attach",
        "recording_control",
    ] {
        assert_eq!(
            h(cmd, json!({"request": {}})).unwrap_err(),
            json!({"kind": "recordingUnavailable", "reason": "no_recording_run"}),
            "{cmd}"
        );
    }
    assert_eq!(
        h(
            "recording_workflow_lease",
            json!({"stage": "preflight", "request": {}})
        )
        .unwrap_err(),
        json!({"kind": "recordingUnavailable", "reason": "no_recording_run"})
    );
    // The auth commands still answer on such a host.
    assert_eq!(h("auth_phase", json!({})).unwrap()["phase"], "initializing");
}

#[test]
fn a_reloaded_page_ends_its_subscriptions_and_the_next_page_attaches_anew() {
    let h = host();
    let scope = &h.scope;
    let attach = |id: &str| {
        json!({"request": {"version":1, "kind":"recordingWireAttachRequest",
            "scope":scope, "attachId":id, "afterRevision":null}})
    };
    let first = h.invoke("recording_attach", attach("attach-1")).unwrap();
    let old = first["reply"]["outcome"]["subscriptionRef"].clone();
    // What the page load hook does on a reload (`commands`); the mock
    // runtime emits no page load or destroy event.
    recording::end_page(&h.app, "main");

    // The next page of the same webview: the old subscription is over, so a
    // replay of its attach is told so; a new attach delivers.
    h.invoke("recording_attach", attach("attach-1")).unwrap();
    assert_eq!(
        h.next_event(),
        json!({"kind": "ended", "subscriptionRef": old, "reason": "unauthorized"})
    );
    let fresh = h.invoke("recording_attach", attach("attach-2")).unwrap();
    let reference = fresh["reply"]["outcome"]["subscriptionRef"].clone();
    assert_ne!(reference, old);
    let change = test_support::change("next-page").as_value().clone();
    h.invoke("recording_workflow_reserve", json!({"request": change}))
        .unwrap();
    let leased = h
        .invoke(
            "recording_workflow_lease",
            json!({"stage": "preflight", "request": lease(scope, "preflight", "mutation")}),
        )
        .unwrap();
    h.invoke(
        "recording_admission",
        json!({"request": admission(scope, "preflight", &leased,
            json!({"kind":"preflight", "change":change}))}),
    )
    .unwrap();
    let frame = h.next_event();
    assert_eq!(frame["kind"], "frames");
    assert_eq!(frame["subscriptionRef"], reference);
}
