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
