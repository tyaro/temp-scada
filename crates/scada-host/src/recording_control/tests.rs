use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use super::*;
use crate::auth_phase::AuthHost;

/// A fresh app data dir under the OS temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("scada-host-control-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const PASSWORD: &str = "correct-horse-1";

/// The auth (first start: auth-disabled, synthetic Admin) and the recording
/// DB of one data dir.
async fn host() -> (TempDir, DesktopAuth, RecordingRuntime) {
    let dir = TempDir::new();
    let auth = DesktopAuth::new(Arc::new(AuthHost::start(&dir.0).await.unwrap()));
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    (dir, auth, runtime)
}

fn project() -> Project {
    let mut value: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../examples/minimal.project.json"
    )))
    .unwrap();
    value["recordingPlan"] = json!({"version": 1, "kind": "recordingPlan", "planId": "plan-a",
        "revision": 1, "enabled": true, "group": {"groupId": "group", "hubRef": "hub",
            "periodMs": 1000, "members": [{"memberId": "member-0",
                "externalName": "Line1.Temperature", "valueType": "number"}]}});
    Project::from_json(&value.to_string()).unwrap()
}

fn kind<T: std::fmt::Debug>(result: Result<T, ControlError>) -> Value {
    serde_json::to_value(result.unwrap_err()).unwrap()["kind"].clone()
}

fn request(context: Value) -> Value {
    json!({"version": 1, "kind": "recordingInspectionRequest", "requestId": "r",
        "context": context})
}

#[tokio::test]
async fn the_synthetic_admin_inspects_and_reaches_the_setup() {
    let (_dir, auth, runtime) = host().await;
    let project = project();
    let context = super::context(&auth, &runtime, &project).await.unwrap();
    let response = status(&auth, &runtime, request(context)).await.unwrap();
    assert_eq!(response["database"]["applied"], Value::Null);
    assert_eq!(
        kind(initial_setup(&auth, &runtime, &project, None).await),
        "hub_not_configured"
    );
    assert_eq!(
        kind(status(&auth, &runtime, json!({})).await),
        "invalidRequest"
    );
    let closed = RecordingRuntime::unavailable(crate::recording_runtime::STORE_LOCKED);
    assert_eq!(
        serde_json::to_value(super::context(&auth, &closed, &project).await.unwrap_err()).unwrap(),
        json!({"kind": "recordingUnavailable", "reason": "store_locked"})
    );
}

#[tokio::test]
async fn a_viewer_inspects_but_does_not_set_up_and_no_session_does_neither() {
    let (_dir, auth, runtime) = host().await;
    let project = project();
    auth.transition_to_operational("admin", PASSWORD, "管理者")
        .await
        .unwrap();
    auth.users_create("viewer", PASSWORD, "閲覧者", Role::Viewer)
        .await
        .unwrap();
    auth.logout().await.unwrap();
    assert_eq!(
        kind(super::context(&auth, &runtime, &project).await),
        "unauthorized"
    );
    assert_eq!(
        kind(initial_setup(&auth, &runtime, &project, None).await),
        "unauthorized"
    );
    assert!(auth.login("viewer", PASSWORD).await.unwrap().success);
    let context = super::context(&auth, &runtime, &project).await.unwrap();
    assert!(status(&auth, &runtime, request(context)).await.is_ok());
    assert_eq!(
        kind(initial_setup(&auth, &runtime, &project, None).await),
        "forbidden"
    );
}

/// The auth and recording DB of one data dir, the auth through an empty gate.
async fn gated() -> (TempDir, DesktopAuth, RecordingRuntime) {
    let dir = TempDir::new();
    let host = Arc::new(AuthHost::start(&dir.0).await.unwrap());
    let gate = crate::recording_gate::RecordingGate::empty(host, NO_RECORDING_RUN);
    let auth = DesktopAuth::with_gate(Arc::new(gate));
    let runtime = RecordingRuntime::start(&dir.0, "deployment-a");
    (dir, auth, runtime)
}

#[tokio::test]
async fn the_slot_is_read_by_a_viewer_and_the_stop_needs_an_admin_and_a_recording() {
    let (_dir, auth, runtime) = gated().await;
    assert_eq!(
        slot(&auth, &runtime).await.unwrap(),
        json!({"state": "empty", "reason": "no_recording_run"})
    );
    // The synthetic Admin: nothing records yet.
    assert_eq!(kind(stop(&auth, &runtime).await), "not_allowed");

    auth.transition_to_operational("admin", PASSWORD, "管理者")
        .await
        .unwrap();
    auth.users_create("viewer", PASSWORD, "閲覧者", Role::Viewer)
        .await
        .unwrap();
    auth.logout().await.unwrap();
    assert_eq!(kind(slot(&auth, &runtime).await), "unauthorized");
    assert_eq!(kind(stop(&auth, &runtime).await), "unauthorized");
    assert!(auth.login("viewer", PASSWORD).await.unwrap().success);
    assert_eq!(slot(&auth, &runtime).await.unwrap()["state"], "empty");
    assert_eq!(kind(stop(&auth, &runtime).await), "forbidden");

    // Without a gate (no auth registry) the slot names the store's state.
    let (_dir, plain, _) = host().await;
    let closed = RecordingRuntime::unavailable(crate::recording_runtime::STORE_LOCKED);
    assert_eq!(
        slot(&plain, &closed).await.unwrap(),
        json!({"state": "empty", "reason": "store_locked"})
    );
    assert_eq!(
        serde_json::to_value(stop(&plain, &closed).await.unwrap_err()).unwrap(),
        json!({"kind": "recordingUnavailable", "reason": "store_locked"})
    );
}

#[tokio::test]
async fn the_resume_and_the_reconfiguration_need_an_admin_and_an_applied_plan() {
    let (_dir, auth, runtime) = gated().await;
    let project = project();
    // The synthetic Admin: no Hub, then no applied plan.
    assert_eq!(
        kind(resume(&auth, &runtime, &project, None).await),
        "hub_not_configured"
    );
    assert_eq!(
        kind(reconfigure(&auth, &runtime, &project, None).await),
        "not_allowed"
    );

    auth.transition_to_operational("admin", PASSWORD, "管理者")
        .await
        .unwrap();
    auth.users_create("viewer", PASSWORD, "閲覧者", Role::Viewer)
        .await
        .unwrap();
    auth.logout().await.unwrap();
    assert_eq!(
        kind(resume(&auth, &runtime, &project, None).await),
        "unauthorized"
    );
    assert_eq!(
        kind(reconfigure(&auth, &runtime, &project, None).await),
        "unauthorized"
    );
    assert!(auth.login("viewer", PASSWORD).await.unwrap().success);
    assert_eq!(
        kind(resume(&auth, &runtime, &project, None).await),
        "forbidden"
    );
    assert_eq!(
        kind(reconfigure(&auth, &runtime, &project, None).await),
        "forbidden"
    );
    auth.logout().await.unwrap();

    // An Admin's refusals are audited.
    assert!(auth.login("admin", PASSWORD).await.unwrap().success);
    assert_eq!(
        kind(reconfigure(&auth, &runtime, &project, None).await),
        "not_allowed"
    );
    let closed = RecordingRuntime::unavailable(crate::recording_runtime::STORE_LOCKED);
    assert_eq!(
        serde_json::to_value(
            reconfigure(&auth, &closed, &project, None)
                .await
                .unwrap_err()
        )
        .unwrap(),
        json!({"kind": "recordingUnavailable", "reason": "store_locked"})
    );
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(_dir.0.join(crate::auth::AUTH_DB_FILE)),
    )
    .await
    .unwrap();
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT action, result FROM audit_log WHERE resource = 'recording' ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows.iter()
            .filter(|(action, _)| action == "reconfigure" || action == "resume")
            .map(|(a, r)| (a.as_str(), r.as_str()))
            .collect::<Vec<_>>(),
        vec![
            ("resume", "failed"),
            ("reconfigure", "failed"),
            ("reconfigure", "failed"),
            ("reconfigure", "failed"),
        ]
    );
}
