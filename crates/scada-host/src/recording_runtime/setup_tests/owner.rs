//! The registry root over a running recording, its handoff by the stop, and
//! the exit (product-owner design §4-§6, C5-3).
use super::*;
use crate::auth_phase::AuthHost;
use crate::recording_gate::{GateError, RecordingGate, NO_RECORDING_RUN};
use scada_model::recording_wire::{RecordingWireAttachRequest, RecordingWireLeaseRequest};

struct Owned {
    dir: TempDir,
    _hub: Hub,
    auth: Arc<AuthHost>,
    gate: Arc<RecordingGate>,
    runtime: RecordingRuntime,
    project: Project,
}

/// A recording started by the first setup, with its root installed.
async fn owned() -> Owned {
    let dir = TempDir::new();
    let hub = Hub::new(&both()).await;
    let auth = Arc::new(AuthHost::start(&dir.0).await.unwrap());
    let gate = Arc::new(RecordingGate::empty(auth.clone(), NO_RECORDING_RUN));
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    let project = project(Some(plan(true)));
    let phase = runtime
        .initial_setup(&project, hub.client(), hub.client())
        .await
        .unwrap();
    assert_eq!(phase, "running");
    let lock = auth.gate().await;
    assert_eq!(runtime.install_owner(&gate, &lock, &project).await, Ok(1));
    drop(lock);
    Owned {
        dir,
        _hub: hub,
        auth,
        gate,
        runtime,
        project,
    }
}

fn attach(scope: &Value, id: &str) -> RecordingWireAttachRequest {
    RecordingWireAttachRequest::from_value(json!({
        "version":1, "kind":"recordingWireAttachRequest", "scope":scope,
        "attachId":id, "afterRevision":null
    }))
    .unwrap()
}

fn read_lease(scope: &Value, id: &str) -> RecordingWireLeaseRequest {
    RecordingWireLeaseRequest::from_value(json!({
        "version":1, "kind":"recordingWireLeaseRequest", "scope":scope,
        "leaseRequestId":id, "admissionId":format!("admission-{id}"),
        "role":"reconciliation", "requestedBudgetMs":1000
    }))
    .unwrap()
}

#[tokio::test]
async fn the_root_serves_the_running_recording_until_the_stop_hands_it_off() {
    let o = owned().await;
    let installed = o.gate.slot().unwrap();
    assert_eq!(installed.generation, 1);
    let scope = installed.scope;
    // The operations context is this host's management context for the Project.
    let target = o.runtime.management_context(&o.project).unwrap();
    assert_eq!(scope["context"]["target"], target);
    assert_eq!(scope["context"]["recordingRunRef"], "run:1");

    // The inspection reads the DB through the History reader meanwhile.
    let lent = inspect(&o.runtime, &o.project).await;
    assert_eq!(lent["database"]["state"], "available");
    assert_eq!(lent["database"]["latestActivation"]["state"], "active");
    assert_eq!(lent["host"]["phase"], "running");
    assert_eq!(lent["host"]["runRef"], "run:1");
    assert_eq!(lent["host"]["sessionId"], scope["context"]["sessionId"]);
    assert_eq!(lent["host"]["planRecoveryRequired"], Value::Null);
    // History still answers.
    wait_points(&o.runtime, &o.project, 1).await;

    // A recording runs: no second first setup.
    assert_eq!(
        o.runtime
            .initial_setup(&o.project, o._hub.client(), o._hub.client())
            .await,
        Err(SetupFailure::NotAllowed)
    );

    // Registry commands work on the running recording.
    let attached = o.gate.attach(attach(&scope, "attach-1")).await.unwrap();
    assert_eq!(attached.reply.generation, 1);
    let reference = attached.reply.reply.as_value()["outcome"]["subscriptionRef"]
        .as_str()
        .unwrap()
        .to_owned();
    let snapshot = &attached.reply.reply.as_value()["outcome"]["snapshot"];
    assert_eq!(snapshot["closed"], false, "{snapshot}");
    o.gate.lease(read_lease(&scope, "read-1")).await.unwrap();

    // The stop hands the root off, then stops and joins the recording.
    let lock = o.auth.gate().await;
    assert_eq!(o.runtime.stop(&o.gate, &lock).await, Ok("joined"));
    drop(lock);
    assert_eq!(o.gate.slot().map(|i| i.generation), Err(NO_RECORDING_RUN));
    // The handed-off root's subscription ends with `ownerClosed`.
    let mut closed = None;
    for _ in 0..3 {
        let frames = o.gate.frames(1, &reference).await.unwrap().reply;
        if let Some(control) = frames.control {
            closed = Some(control);
            break;
        }
    }
    assert_eq!(closed.unwrap().as_value()["reason"], "ownerClosed");
    // Its other registry commands end with the slot.
    assert!(matches!(
        o.gate.lease(read_lease(&scope, "read-2")).await,
        Err(GateError::Unavailable(NO_RECORDING_RUN))
    ));
    let stopped = inspect(&o.runtime, &o.project).await;
    assert_eq!(stopped["host"]["phase"], "joined");
    assert_eq!(stopped["database"]["latestActivation"]["state"], "closed");
    assert_eq!(stopped["host"]["planRecoveryRequired"], false);

    // Nothing more to stop.
    let lock = o.auth.gate().await;
    assert_eq!(
        o.runtime.stop(&o.gate, &lock).await,
        Err(StopFailure::NotAllowed)
    );
}

#[tokio::test]
async fn the_exit_stops_the_recording_so_the_next_start_finds_it_closed() {
    let o = owned().await;
    let lock = o.auth.gate().await;
    assert_eq!(
        o.runtime
            .exit(Some(&o.gate), &lock, Duration::from_secs(10))
            .await,
        ExitOutcome::Stopped
    );
    drop(lock);
    assert_eq!(o.gate.slot().map(|i| i.generation), Err(NO_RECORDING_RUN));
    let Owned {
        dir,
        runtime,
        project,
        ..
    } = o;
    drop(runtime);
    let restarted = RecordingRuntime::start(&dir.0, "deployment-a");
    let after = inspect(&restarted, &project).await;
    assert_eq!(after["database"]["latestActivation"]["state"], "closed");
    assert_eq!(after["host"]["phase"], "idle");
}

#[tokio::test]
async fn an_exit_without_a_root_stops_a_recording_the_owner_never_took() {
    let dir = TempDir::new();
    let hub = Hub::new(&both()).await;
    let auth = Arc::new(AuthHost::start(&dir.0).await.unwrap());
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    let project = project(Some(plan(true)));
    runtime
        .initial_setup(&project, hub.client(), hub.client())
        .await
        .unwrap();
    let lock = auth.gate().await;
    assert_eq!(
        runtime.exit(None, &lock, Duration::from_secs(10)).await,
        ExitOutcome::Stopped
    );
    drop(lock);
    let after = inspect(&runtime, &project).await;
    assert_eq!(after["database"]["latestActivation"]["state"], "closed");
}
