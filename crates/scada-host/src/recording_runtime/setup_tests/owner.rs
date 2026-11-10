//! The registry root over a running recording, its handoff by the stop, and
//! the exit (product-owner design §4-§6, C5-3).
use super::*;
use crate::auth_phase::AuthHost;
use crate::recording_gate::{
    GateError, RecordingGate, WorkflowStage, NO_RECORDING_RUN, SHUTDOWN_ACTOR,
};
use scada_model::recording_admission::RecordingAdmissionRequest;
use scada_model::recording_operations::RecordingChangeRequest;
use scada_model::recording_wire::{RecordingWireAttachRequest, RecordingWireLeaseRequest};
use scada_runtime::recording_operations::OperationsPhase;

pub(super) struct Owned {
    pub(super) dir: TempDir,
    pub(super) _hub: Hub,
    pub(super) auth: Arc<AuthHost>,
    pub(super) gate: Arc<RecordingGate>,
    pub(super) runtime: RecordingRuntime,
    pub(super) project: Project,
}

/// A recording started by the first setup, with its root installed.
pub(super) async fn owned() -> Owned {
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

/// A change of the running recording's plan to disabled, in the root's
/// operations context.
fn disable(scope: &Value) -> RecordingChangeRequest {
    let mut desired = plan(false);
    desired["revision"] = json!(2);
    RecordingChangeRequest::from_value(json!({
        "version":1, "kind":"recordingChangeRequest", "changeId":"exit-change",
        "context":scope["context"],
        "apply":{"requestId":"apply:exit-change", "desired":desired,
            "expectedAppliedRevision":1, "expectedMappingRevision":null,
            "expectedRetentionAppliedRevision":null}
    }))
    .unwrap()
}

pub(super) fn stage_lease(scope: &Value, id: &str) -> RecordingWireLeaseRequest {
    RecordingWireLeaseRequest::from_value(json!({
        "version":1, "kind":"recordingWireLeaseRequest", "scope":scope,
        "leaseRequestId":format!("{id}-lease"), "admissionId":id, "role":"mutation",
        "requestedBudgetMs":5000
    }))
    .unwrap()
}

pub(super) fn admission(
    scope: &Value,
    id: &str,
    lease: &Value,
    action: Value,
) -> RecordingAdmissionRequest {
    RecordingAdmissionRequest::from_value(json!({
        "version":1, "kind":"recordingAdmissionRequest", "ownerRef":scope["ownerRef"],
        "admissionId":id, "context":scope["context"],
        "deadlineLeaseRef":lease["outcome"]["deadlineLeaseRef"], "action":action
    }))
    .unwrap()
}

/// Reserve the change and dispatch its preflight through the gate (the
/// synthetic Admin of auth-disabled mode). Returns the change and the
/// accepted reply; the preflight may still be running.
async fn preflight(o: &Owned, scope: &Value) -> (RecordingChangeRequest, Value) {
    let change = disable(scope);
    o.gate.workflow_reserve(change.clone()).await.unwrap();
    let lease = o
        .gate
        .workflow_lease(WorkflowStage::Preflight, stage_lease(scope, "preflight"))
        .await
        .unwrap();
    let accepted = o
        .gate
        .admission(admission(
            scope,
            "preflight",
            lease.reply.as_value(),
            json!({"kind":"preflight", "change":change.as_value()}),
        ))
        .await
        .unwrap();
    let accepted = accepted.reply.as_value().clone();
    assert_eq!(accepted["outcome"]["kind"], "accepted", "{accepted}");
    (change, accepted)
}

pub(super) async fn until_phase(gate: &RecordingGate, phase: OperationsPhase) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while gate.owner_phase() != Some(phase) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("the owner reaches {phase:?}: {:?}", gate.owner_phase()));
}

/// Exit, then start again over the same data dir; the start's inspection.
async fn exit_and_restart(o: Owned) -> (ExitOutcome, Value, TempDir) {
    let lock = o.auth.gate().await;
    let outcome = o
        .runtime
        .exit(Some(&o.gate), &lock, Duration::from_secs(10))
        .await;
    drop(lock);
    let Owned {
        dir,
        runtime,
        project,
        gate,
        auth,
        ..
    } = o;
    // The process ends: a root left installed goes with it.
    drop(gate);
    drop(auth);
    drop(runtime);
    let restarted = RecordingRuntime::start(&dir.0, "deployment-a");
    let after = inspect(&restarted, &project).await;
    (outcome, after, dir)
}

/// The recording audit rows as (action, entity, result, actor).
async fn admission_audit(dir: &TempDir) -> Vec<(String, String, String, String)> {
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(dir.0.join(crate::auth::AUTH_DB_FILE)),
    )
    .await
    .unwrap();
    sqlx::query_as(
        "SELECT action, COALESCE(entity_id, ''), result, actor_username FROM audit_log \
         WHERE resource = 'recording_admission' ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn the_exit_discards_a_candidate_then_stops_the_recording() {
    let o = owned().await;
    let scope = o.gate.slot().unwrap().scope;
    // The exit starts right after the preflight was accepted: it waits for
    // the preflight to complete, then discards its Candidate (design §6.1).
    preflight(&o, &scope).await;

    let (outcome, after, dir) = exit_and_restart(o).await;
    assert_eq!(outcome, ExitOutcome::Stopped);
    // Stopped and joined: the next start finds no interrupted session.
    assert_eq!(after["database"]["latestActivation"]["state"], "closed");
    assert_eq!(after["host"]["phase"], "idle");
    // The plan is unchanged.
    assert_eq!(after["database"]["applied"]["appliedRevision"], 1);
    let audit = admission_audit(&dir).await;
    let (action, entity, result, actor) = audit.last().unwrap();
    assert_eq!(
        (action.as_str(), result.as_str(), actor.as_str()),
        ("register", "ok", SHUTDOWN_ACTOR),
        "{audit:?}"
    );
    assert!(entity.starts_with("shutdown-discard:"), "{entity}");
}

#[tokio::test]
async fn the_exit_leaves_a_paused_change_without_an_interruption() {
    let o = owned().await;
    let scope = o.gate.slot().unwrap().scope;
    let (change, accepted) = preflight(&o, &scope).await;
    until_phase(&o.gate, OperationsPhase::Candidate).await;
    let stage = WorkflowStage::PauseJoin {
        operation_id: "pause:exit".into(),
    };
    let lease = o
        .gate
        .workflow_lease(stage, stage_lease(&scope, "pause"))
        .await
        .unwrap();
    let paused = o
        .gate
        .admission(admission(
            &scope,
            "pause",
            lease.reply.as_value(),
            json!({"kind":"pauseJoin", "changeRef":accepted["outcome"]["handle"]["changeRef"],
                "operation":{"version":1, "kind":"recordingOperationRequest",
                    "operationId":"pause:exit", "stage":"pauseJoin",
                    "change":change.as_value()}}),
        ))
        .await
        .unwrap();
    assert_eq!(paused.reply.as_value()["outcome"]["kind"], "accepted");
    until_phase(&o.gate, OperationsPhase::Paused).await;

    let (outcome, after, dir) = exit_and_restart(o).await;
    assert_eq!(outcome, ExitOutcome::Paused);
    // The pause/join already ended the session.
    assert_eq!(after["database"]["latestActivation"]["state"], "closed");
    assert_eq!(after["host"]["phase"], "idle");
    // Nothing was discarded.
    assert!(admission_audit(&dir)
        .await
        .iter()
        .all(|(_, _, _, actor)| actor != SHUTDOWN_ACTOR));
}

#[tokio::test]
async fn a_refused_discard_leaves_the_recording_running_for_the_interruption() {
    let o = owned().await;
    let scope = o.gate.slot().unwrap().scope;
    preflight(&o, &scope).await;
    until_phase(&o.gate, OperationsPhase::Candidate).await;
    o.gate.refuse_next_shutdown_discard();

    let lock = o.auth.gate().await;
    let outcome = o
        .runtime
        .exit(Some(&o.gate), &lock, Duration::from_secs(10))
        .await;
    drop(lock);
    assert_eq!(outcome, ExitOutcome::Interrupted);
    // The root and its Candidate are left as they are, and the recording
    // keeps running until the process ends; the next start then closes its
    // session as interrupted (design §6 step 4).
    assert_eq!(o.gate.slot().map(|i| i.generation), Ok(1));
    assert_eq!(o.gate.owner_phase(), Some(OperationsPhase::Candidate));
    let lent = inspect(&o.runtime, &o.project).await;
    assert_eq!(lent["host"]["phase"], "running");
    assert_eq!(lent["database"]["latestActivation"]["state"], "active");
    let audit = admission_audit(&o.dir).await;
    let (_, _, result, actor) = audit.last().unwrap();
    assert_eq!(
        (result.as_str(), actor.as_str()),
        ("denied", SHUTDOWN_ACTOR)
    );
}

/// The Project after an edit: the same ID and plan, the next revision.
fn edited(project: &Project) -> Project {
    let mut value: Value = serde_json::from_str(&project.to_json()).unwrap();
    value["manifest"]["projectRevision"] = json!(project.revision() + 1);
    Project::from_json(&value.to_string()).unwrap()
}

async fn rebind(o: &Owned, project: &Project) -> Result<&'static str, RebindFailure> {
    let lock = o.auth.gate().await;
    o.runtime.rebind_owner(&o.gate, &lock, project).await
}

#[tokio::test]
async fn the_rebind_gives_the_running_recording_a_root_for_the_edited_project() {
    let o = owned().await;
    let before = o.gate.slot().unwrap();
    let edited = edited(&o.project);
    // An unsettled root stays as it is.
    let (change, accepted) = preflight(&o, &before.scope).await;
    until_phase(&o.gate, OperationsPhase::Candidate).await;
    assert_eq!(rebind(&o, &edited).await, Err(RebindFailure::Busy));
    assert_eq!(o.gate.slot().map(|i| i.generation), Ok(1));
    let lease = o
        .gate
        .workflow_lease(
            WorkflowStage::Discard,
            stage_lease(&before.scope, "discard"),
        )
        .await
        .unwrap();
    let discarded = o
        .gate
        .admission(admission(
            &before.scope,
            "discard",
            lease.reply.as_value(),
            json!({"kind":"discard",
                "changeRef":accepted["outcome"]["handle"]["changeRef"],
                "change":change.as_value()}),
        ))
        .await
        .unwrap();
    assert_eq!(
        discarded.reply.as_value()["outcome"]["kind"],
        "completedDiscard",
        "{}",
        discarded.reply.as_value()
    );
    until_phase(&o.gate, OperationsPhase::Idle).await;

    assert_eq!(rebind(&o, &edited).await, Ok("installed"));
    let after = o.gate.slot().unwrap();
    assert_eq!(after.generation, 2);
    // The new context names the edited revision, over the same recording.
    let target = &after.scope["context"]["target"];
    assert_eq!(target["projectRevision"], edited.revision());
    assert_eq!(target, &o.runtime.management_context(&edited).unwrap());
    assert_eq!(
        after.scope["context"]["recordingRunRef"],
        before.scope["context"]["recordingRunRef"]
    );
    assert_ne!(after.scope["ownerEpoch"], before.scope["ownerEpoch"]);
    let inspected = inspect(&o.runtime, &edited).await;
    assert_eq!(inspected["host"]["phase"], "running");
    assert_eq!(inspected["database"]["latestActivation"]["state"], "active");

    // A stopped recording keeps no root to rebind.
    let lock = o.auth.gate().await;
    assert_eq!(o.runtime.stop(&o.gate, &lock).await, Ok("joined"));
    drop(lock);
    assert_eq!(rebind(&o, &edited).await, Err(RebindFailure::NotAllowed));
}
