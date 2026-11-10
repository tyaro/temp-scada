//! The resume and the stopped reconfiguration (product-owner design §5,
//! C5-4): after a stop, after a restart and after the registry's apply.
use super::owner::{admission, owned, stage_lease, until_phase, Owned};
use super::*;
use crate::auth_phase::AuthHost;
use crate::recording_gate::{RecordingGate, WorkflowStage, NO_RECORDING_RUN};
use scada_model::recording_operations::RecordingChangeRequest;
use scada_runtime::recording_operations::OperationsPhase;

async fn resume(o: &Owned) -> Result<&'static str, SetupFailure> {
    let lock = o.auth.gate().await;
    o.runtime
        .resume(Some(&o.gate), &lock, o._hub.client(), o._hub.client())
        .await
}

/// Resume, then install the new root as the command does.
async fn resume_installed(o: &Owned) -> u64 {
    assert_eq!(resume(o).await, Ok("running"));
    let lock = o.auth.gate().await;
    o.runtime
        .install_owner(&o.gate, &lock, &o.project)
        .await
        .unwrap()
}

async fn stop(o: &Owned) {
    let lock = o.auth.gate().await;
    assert_eq!(o.runtime.stop(&o.gate, &lock).await, Ok("joined"));
}

fn series(runtime: &RecordingRuntime, project: &Project) -> Vec<(String, String)> {
    let context = runtime.history_context(project).unwrap().unwrap();
    let mut series: Vec<_> = context["series"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["label"].as_str().unwrap().to_owned(),
                s["seriesId"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    series.sort();
    series
}

#[tokio::test]
async fn a_stopped_recording_resumes_under_a_new_root() {
    let o = owned().await;
    // A recording that runs is not resumed, and its root stays.
    assert_eq!(resume(&o).await, Err(SetupFailure::NotAllowed));
    assert_eq!(o.gate.slot().map(|i| i.generation), Ok(1));

    stop(&o).await;
    assert_eq!(resume_installed(&o).await, 2);
    let after = inspect(&o.runtime, &o.project).await;
    assert_eq!(after["host"]["phase"], "running");
    assert_eq!(after["host"]["runRef"], "run:2");
    assert_eq!(after["database"]["latestActivation"]["state"], "active");
    // The plan is the same one: no new revision.
    assert_eq!(after["database"]["applied"]["appliedRevision"], 1);
    let scope = o.gate.slot().unwrap().scope;
    assert_eq!(scope["context"]["recordingRunRef"], "run:2");
    assert_eq!(scope["context"]["sessionId"], after["host"]["sessionId"]);
    wait_points(&o.runtime, &o.project, 1).await;
}

#[tokio::test]
async fn a_restarted_host_resumes_the_applied_plan() {
    let o = owned().await;
    let lock = o.auth.gate().await;
    o.runtime
        .exit(Some(&o.gate), &lock, Duration::from_secs(10))
        .await;
    drop(lock);
    let Owned {
        dir,
        _hub: hub,
        project,
        runtime,
        gate,
        auth,
    } = o;
    let before = series(&runtime, &project);
    drop((gate, auth, runtime));

    let auth = Arc::new(AuthHost::start(&dir.0).await.unwrap());
    let gate = Arc::new(RecordingGate::empty(auth.clone(), NO_RECORDING_RUN));
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    assert_eq!(inspect(&runtime, &project).await["host"]["phase"], "idle");
    let o = Owned {
        dir,
        _hub: hub,
        auth,
        gate,
        runtime,
        project,
    };
    assert_eq!(resume_installed(&o).await, 1);
    let after = inspect(&o.runtime, &o.project).await;
    assert_eq!(after["host"]["phase"], "running");
    assert_eq!(after["database"]["latestActivation"]["state"], "active");
    // The same series continue.
    assert_eq!(series(&o.runtime, &o.project), before);
    wait_points(&o.runtime, &o.project, 1).await;
}

#[tokio::test]
async fn a_disabled_plan_is_not_resumed_until_it_is_enabled_again() {
    let o = owned().await;
    stop(&o).await;
    let before = series(&o.runtime, &o.project);
    let mut disabled = plan(false);
    disabled["revision"] = json!(2);
    let applied = o
        .runtime
        .reconfigure(&project(Some(disabled.clone())), None)
        .await;
    assert_eq!(
        applied,
        Ok(Reconfigured {
            changed: true,
            enabled: false
        })
    );
    // A repeated call finds it applied.
    assert_eq!(
        o.runtime
            .reconfigure(&project(Some(disabled.clone())), None)
            .await,
        Ok(Reconfigured {
            changed: false,
            enabled: false
        })
    );
    assert_eq!(resume(&o).await, Err(SetupFailure::PlanDisabled));
    // The same plan ID and revision with other content is refused.
    let mut altered = disabled.clone();
    altered["enabled"] = json!(true);
    assert_eq!(
        o.runtime
            .reconfigure(&project(Some(altered.clone())), Some(o._hub.client()))
            .await,
        Err(SetupFailure::PlanConflict)
    );

    // Enabled again with the same members: the registered mapping is bound
    // and the Hub is not read.
    altered["revision"] = json!(3);
    let subscriptions = o._hub.subscriptions.load(Ordering::SeqCst);
    assert_eq!(
        o.runtime.reconfigure(&project(Some(altered)), None).await,
        Ok(Reconfigured {
            changed: true,
            enabled: true
        })
    );
    assert_eq!(o._hub.subscriptions.load(Ordering::SeqCst), subscriptions);
    let db = &inspect(&o.runtime, &o.project).await["database"];
    assert_eq!(db["applied"]["appliedRevision"], 3);
    assert_eq!(db["applied"]["mappingRevision"], 1);
    assert_eq!(db["applied"]["retentionAppliedRevision"], 1);
    resume_installed(&o).await;
    let project3 = project(Some(db["applied"]["desired"].clone()));
    assert_eq!(series(&o.runtime, &project3), before);
}

#[tokio::test]
async fn changed_members_register_a_mapping_that_keeps_the_unchanged_identities() {
    let o = owned().await;
    // Not while recording.
    let mut fewer = plan(true);
    fewer["revision"] = json!(2);
    fewer["group"]["members"] = json!([
        {"memberId": "member-level", "externalName": LEVEL, "valueType": "number"}]);
    assert_eq!(
        o.runtime
            .reconfigure(&project(Some(fewer.clone())), Some(o._hub.client()))
            .await,
        Err(SetupFailure::NotAllowed)
    );
    stop(&o).await;
    let before = series(&o.runtime, &o.project);
    // A new mapping needs the Hub.
    assert_eq!(
        o.runtime
            .reconfigure(&project(Some(fewer.clone())), None)
            .await,
        Err(SetupFailure::HubNotConfigured)
    );
    let fewer = project(Some(fewer));
    assert_eq!(
        o.runtime.reconfigure(&fewer, Some(o._hub.client())).await,
        Ok(Reconfigured {
            changed: true,
            enabled: true
        })
    );
    let db = &inspect(&o.runtime, &fewer).await["database"];
    assert_eq!(db["applied"]["appliedRevision"], 2);
    assert_eq!(db["currentMappingRevision"], 2);
    assert_eq!(db["applied"]["mappingRevision"], 2);
    // The level keeps its series; the History host follows the new plan.
    let level: Vec<_> = before.into_iter().filter(|(l, _)| l == LEVEL).collect();
    assert_eq!(series(&o.runtime, &fewer), level);
    let o = Owned {
        project: fewer,
        ..o
    };
    resume_installed(&o).await;
    wait_points(&o.runtime, &o.project, 1).await;
}

#[tokio::test]
async fn a_store_without_an_applied_plan_is_not_reconfigured_or_resumed() {
    let dir = TempDir::new();
    let hub = Hub::new(&both()).await;
    let auth = Arc::new(AuthHost::start(&dir.0).await.unwrap());
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    assert_eq!(
        runtime
            .reconfigure(&project(Some(plan(true))), Some(hub.client()))
            .await,
        Err(SetupFailure::NotAllowed)
    );
    let lock = auth.gate().await;
    assert_eq!(
        runtime
            .resume(None, &lock, hub.client(), hub.client())
            .await,
        Err(SetupFailure::NoRecordingPlan)
    );
    assert_eq!(hub.subscriptions.load(Ordering::SeqCst), 0);
}

/// The registry's change of the running plan to `desired` (same members),
/// through the gate: preflight, pause/join and apply.
async fn registry_apply(o: &Owned, desired: Value) {
    let scope = o.gate.slot().unwrap().scope;
    let change = RecordingChangeRequest::from_value(json!({
        "version":1, "kind":"recordingChangeRequest", "changeId":"resume-change",
        "context":scope["context"],
        "apply":{"requestId":"apply:resume-change", "desired":desired,
            "expectedAppliedRevision":1, "expectedMappingRevision":1,
            "expectedRetentionAppliedRevision":1}
    }))
    .unwrap();
    o.gate.workflow_reserve(change.clone()).await.unwrap();
    let lease = o
        .gate
        .workflow_lease(WorkflowStage::Preflight, stage_lease(&scope, "preflight"))
        .await
        .unwrap();
    let accepted = o
        .gate
        .admission(admission(
            &scope,
            "preflight",
            lease.reply.as_value(),
            json!({"kind":"preflight", "change":change.as_value()}),
        ))
        .await
        .unwrap();
    let accepted = accepted.reply.as_value().clone();
    until_phase(&o.gate, OperationsPhase::Candidate).await;
    let operation = |id: &str, stage: &str| {
        json!({"version":1, "kind":"recordingOperationRequest", "operationId":id,
            "stage":stage, "change":change.as_value()})
    };
    let lease = o
        .gate
        .workflow_lease(
            WorkflowStage::PauseJoin {
                operation_id: "pause:resume".into(),
            },
            stage_lease(&scope, "pause"),
        )
        .await
        .unwrap();
    let paused = o
        .gate
        .admission(admission(
            &scope,
            "pause",
            lease.reply.as_value(),
            json!({"kind":"pauseJoin", "changeRef":accepted["outcome"]["handle"]["changeRef"],
                "operation":operation("pause:resume", "pauseJoin")}),
        ))
        .await
        .unwrap();
    let paused = paused.reply.as_value().clone();
    assert_eq!(paused["outcome"]["kind"], "accepted", "{paused}");
    until_phase(&o.gate, OperationsPhase::Paused).await;
    let lease = o
        .gate
        .workflow_lease(
            WorkflowStage::Apply {
                operation_id: "apply:resume".into(),
            },
            stage_lease(&scope, "apply"),
        )
        .await
        .unwrap();
    let applied = o
        .gate
        .admission(admission(
            &scope,
            "apply",
            lease.reply.as_value(),
            json!({"kind":"apply", "changeRef":paused["outcome"]["handle"]["changeRef"],
                "operation":operation("apply:resume", "apply")}),
        ))
        .await
        .unwrap();
    assert_eq!(
        applied.reply.as_value()["outcome"]["kind"],
        "accepted",
        "{:?}",
        applied.reply.as_value()
    );
    until_phase(&o.gate, OperationsPhase::Completed).await;
}

#[tokio::test]
async fn the_registry_apply_is_resumed_by_taking_the_root_back() {
    let o = owned().await;
    let mut desired = plan(true);
    desired["revision"] = json!(2);
    desired["group"]["groupId"] = json!("group-2");
    registry_apply(&o, desired).await;
    // The apply left the recording stopped and the root installed.
    let lent = inspect(&o.runtime, &o.project).await;
    assert_eq!(lent["database"]["applied"]["appliedRevision"], 2);
    assert_eq!(lent["database"]["activeSessionId"], Value::Null);
    assert_eq!(o.gate.slot().map(|i| i.generation), Ok(1));
    // Stopped, but the root holds the Supervisor: no reconfiguration.
    assert_eq!(
        o.runtime
            .reconfigure(&o.project, Some(o._hub.client()))
            .await,
        Err(SetupFailure::NotAllowed)
    );

    assert_eq!(resume_installed(&o).await, 2);
    let after = inspect(&o.runtime, &o.project).await;
    assert_eq!(after["host"]["phase"], "running");
    assert_eq!(after["database"]["latestActivation"]["appliedRevision"], 2);
    assert_eq!(after["database"]["latestActivation"]["state"], "active");
    wait_points(&o.runtime, &o.project, 1).await;
}
