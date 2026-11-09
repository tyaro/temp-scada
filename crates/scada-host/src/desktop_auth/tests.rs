use std::path::PathBuf;

use serde_json::{json, Value};

use super::*;

/// A fresh app data dir under the OS temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("scada-host-desktop-{}", uuid::Uuid::new_v4()));
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

async fn first_start() -> (TempDir, DesktopAuth) {
    let dir = TempDir::new();
    let auth = Arc::new(AuthHost::start(&dir.0).await.unwrap());
    (dir, DesktopAuth::new(auth))
}

async fn operational() -> (TempDir, DesktopAuth) {
    let (dir, desktop) = first_start().await;
    desktop
        .transition_to_operational("admin", PASSWORD, "管理者")
        .await
        .unwrap();
    (dir, desktop)
}

fn wire<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap()
}

#[tokio::test]
async fn the_first_start_serves_the_synthetic_admin_and_refuses_logins() {
    let (_dir, desktop) = first_start().await;
    assert_eq!(
        wire(&desktop.phase().await.unwrap()),
        json!({"phase": "initializing", "authDisabled": true, "hasAdmin": false})
    );
    assert_eq!(
        wire(&desktop.status().await.unwrap()),
        json!({"initialized": false, "viewerPublic": false})
    );
    let resolved = desktop.resolve().await.unwrap();
    assert_eq!(
        wire(&resolved),
        json!({
            "identity": {"id": "local", "name": "ローカルユーザー", "role": "admin"},
            "kind": "local", "checked": resolved.checked, "current": resolved.current,
            "stale": false
        })
    );

    let refused = desktop.login("admin", PASSWORD).await.unwrap();
    assert!(!refused.success && !refused.superseded);
    assert_eq!(refused.seq, resolved.current);
    let refused = desktop.setup("admin", PASSWORD, "管理者").await.unwrap();
    assert!(!refused.success);
    assert!(!desktop.status().await.unwrap().initialized);
    // Logout is a no-op while the mode keeps the synthetic session.
    assert_eq!(desktop.logout().await.unwrap().seq, resolved.current);
    // The synthetic session owns no password.
    assert_eq!(
        wire(
            &desktop
                .change_password(PASSWORD, "another-horse-2")
                .await
                .unwrap_err()
        ),
        json!({"kind": "forbidden"})
    );
}

#[tokio::test]
async fn the_move_to_operation_signs_the_administrator_in() {
    let (_dir, desktop) = first_start().await;
    let before = desktop.resolve().await.unwrap().current;
    let moved = desktop
        .transition_to_operational("admin", PASSWORD, "管理者")
        .await
        .unwrap();
    assert!(moved.signed_in);
    assert!(moved.seq > before);
    assert_eq!(
        wire(&desktop.phase().await.unwrap()),
        json!({"phase": "operational", "authDisabled": false, "hasAdmin": true})
    );
    let resolved = desktop.resolve().await.unwrap();
    assert_eq!(resolved.kind, Some("account"));
    assert_eq!(
        resolved.identity,
        Some(Identity {
            id: "admin".into(),
            name: "管理者".into(),
            role: "admin".into(),
        })
    );
    assert_eq!((resolved.checked, resolved.current), (moved.seq, moved.seq));
    // Done once: a second move is not offered.
    assert_eq!(
        wire(
            &desktop
                .transition_to_operational("admin", PASSWORD, "管理者")
                .await
                .unwrap_err()
        ),
        json!({"kind": "not_allowed"})
    );
}

#[tokio::test]
async fn login_logout_and_the_own_password_change_report_the_generation() {
    let (_dir, desktop) = operational().await;
    let out = desktop.logout().await.unwrap();
    let none = desktop.resolve().await.unwrap();
    assert_eq!((none.identity, none.kind), (None, None));
    assert_eq!((none.checked, none.current), (out.seq, out.seq));

    let wrong = desktop.login("admin", "wrong-password-0").await.unwrap();
    assert_eq!(
        wire(&wrong),
        json!({
            "success": false, "error": INVALID_CREDENTIALS_MESSAGE,
            "superseded": false, "seq": out.seq
        })
    );
    let login = desktop.login("admin", PASSWORD).await.unwrap();
    assert!(login.success);
    assert_eq!(login.seq, out.seq + 1);

    let changed = desktop
        .change_password(PASSWORD, "another-horse-2")
        .await
        .unwrap();
    assert_eq!(changed.seq, login.seq + 1);
    let resolved = desktop.resolve().await.unwrap();
    assert_eq!(resolved.kind, Some("account"));
    assert_eq!(resolved.current, changed.seq);
    // A wrong current password is Banto's validation error.
    assert_eq!(
        wire(
            &desktop
                .change_password(PASSWORD, "third-horse-3")
                .await
                .unwrap_err()
        )["kind"],
        "validation"
    );
    assert!(desktop.status().await.unwrap().initialized);
    // The account exists, so Banto's first-account setup is refused.
    assert!(
        !desktop
            .setup("other", PASSWORD, "別")
            .await
            .unwrap()
            .success
    );
}

#[tokio::test]
async fn a_failed_move_reports_its_kind() {
    let (_dir, desktop) = first_start().await;
    // Banto's username validation: a field error, nothing saved.
    assert_eq!(
        wire(
            &desktop
                .transition_to_operational("", PASSWORD, "管理者")
                .await
                .unwrap_err()
        )["kind"],
        "validation"
    );
    assert_eq!(desktop.phase().await.unwrap().phase, "transitioning");
    // The re-run verifies once the administrator exists.
    desktop
        .transition_to_operational("admin", PASSWORD, "管理者")
        .await
        .unwrap();
    assert_eq!(desktop.phase().await.unwrap().phase, "operational");
}

#[test]
fn errors_serialize_as_banto_error_bodies() {
    assert_eq!(
        wire(&CommandError::Unavailable(startup_reason(
            &StartupError::PhaseLost
        ))),
        json!({"kind": "auth_unavailable", "reason": "phase_lost"})
    );
    assert_eq!(
        wire(&CommandError::from(TransitionError::Busy)),
        json!({"kind": "busy"})
    );
    assert_eq!(
        wire(&CommandError::from(BantoError::Unauthorized)),
        json!({"kind": "unauthorized"})
    );
}

/// Tauri runs each async command as a spawned task: every command future
/// must be `Send`, with and without a gate.
#[allow(dead_code)]
fn every_command_future_is_send(desktop: &DesktopAuth) {
    fn send<T: Send>(_: T) {}
    send(desktop.status());
    send(desktop.phase());
    send(desktop.login("", ""));
    send(desktop.setup("", "", ""));
    send(desktop.logout());
    send(desktop.resolve());
    send(desktop.change_password("", ""));
    send(desktop.transition_to_operational("", "", ""));
}

#[tokio::test]
async fn the_phase_is_read_as_one_state_with_a_running_move() {
    let (_dir, desktop) = first_start().await;
    let desktop = Arc::new(desktop);
    // A move holds the transition lock; the phase waits for it to finish.
    let guard = desktop.auth().gate().await;
    let reader = desktop.clone();
    let phase = tokio::spawn(async move { reader.phase().await.unwrap() });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(!phase.is_finished());
    drop(guard);
    assert_eq!(
        wire(&phase.await.unwrap()),
        json!({"phase": "initializing", "authDisabled": true, "hasAdmin": false})
    );
}
