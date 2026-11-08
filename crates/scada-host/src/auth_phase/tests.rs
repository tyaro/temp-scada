use std::path::PathBuf;
use std::time::Duration;

use banto_admin_services::settings::AuthSettings;

use super::*;
use crate::auth::LoginOutcome;

/// A fresh app data dir under the OS temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("scada-host-phase-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn phase_file(&self) -> PathBuf {
        self.0.join(AUTH_PHASE_FILE)
    }

    fn db(&self) -> PathBuf {
        self.0.join(AUTH_DB_FILE)
    }

    fn saved_phase(&self) -> Option<Value> {
        std::fs::read(self.phase_file())
            .ok()
            .map(|bytes| serde_json::from_slice(&bytes).unwrap())
    }

    fn write_phase(&self, phase: &str) {
        std::fs::write(
            self.phase_file(),
            serde_json::to_vec(&json!({"version": 1, "phase": phase})).unwrap(),
        )
        .unwrap();
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const PASSWORD: &str = "correct-horse-1";

fn phase_json(phase: &str) -> Option<Value> {
    Some(json!({"version": 1, "phase": phase}))
}

/// Stops at `stop`, as a process kill there would.
fn crash_at(stop: Checkpoint) -> impl FnMut(Checkpoint) -> bool {
    move |point| point != stop
}

async fn session(host: &AuthHost) -> Option<DesktopSession> {
    host.auth().current().await.unwrap().map(|c| c.session)
}

async fn auth_config(host: &AuthHost) -> AuthSettings {
    host.auth().settings().auth_config().await.unwrap()
}

async fn transition(host: &AuthHost, password: &str) -> Result<Transitioned, TransitionError> {
    host.transition_to_operational("admin", password, "管理者", || true)
        .await
}

async fn assert_initialized(host: &AuthHost, dir: &TempDir) {
    assert_eq!(host.phase().await, AuthPhase::Initializing);
    assert_eq!(dir.saved_phase(), phase_json("initializing"));
    let config = auth_config(host).await;
    assert!(config.disabled);
    assert_eq!(config.disabled_role, Role::Admin);
    match session(host).await {
        Some(DesktopSession::AuthDisabledLocal(identity)) => {
            assert_eq!(identity.role, Role::Admin)
        }
        other => panic!("expected the synthetic admin session, got {other:?}"),
    }
}

#[tokio::test]
async fn first_start_creates_the_auth_db_with_auth_disabled_mode_on() {
    let dir = TempDir::new();
    let host = AuthHost::start(&dir.0).await.unwrap();
    assert!(dir.db().exists());
    assert_initialized(&host, &dir).await;
    assert!(AuthPhase::Initializing.admits_registry());
    assert!(!host.auth().users().is_initialized().await.unwrap());
}

#[tokio::test]
async fn a_later_start_keeps_the_saved_phase_and_settings() {
    let dir = TempDir::new();
    let host = AuthHost::start(&dir.0).await.unwrap();
    host.auth()
        .set_auth_config(&AuthSettings {
            disabled: true,
            disabled_role: Role::Viewer,
            ..auth_config(&host).await
        })
        .await
        .unwrap();
    drop(host);

    let host = AuthHost::start(&dir.0).await.unwrap();
    assert_eq!(host.phase().await, AuthPhase::Initializing);
    assert_eq!(auth_config(&host).await.disabled_role, Role::Viewer);
}

#[tokio::test]
async fn an_interrupted_first_start_resumes_from_the_db_step() {
    for stop in [
        Checkpoint::Bootstrapping,
        Checkpoint::Migrated,
        Checkpoint::Configured,
    ] {
        let dir = TempDir::new();
        let crashed = AuthHost::start_with(&dir.0, &mut crash_at(stop)).await;
        assert!(
            matches!(crashed, Err(StartupError::Crashed(point)) if point == stop),
            "{stop:?}"
        );
        assert_eq!(dir.saved_phase(), phase_json("bootstrapping"), "{stop:?}");

        let host = AuthHost::start(&dir.0).await.unwrap();
        assert_initialized(&host, &dir).await;
    }
}

#[tokio::test]
async fn bootstrapping_reconfigures_whatever_the_db_holds() {
    let dir = TempDir::new();
    // A DB left by an earlier attempt with the mode saved off.
    let auth = HostAuth::open(dir.db()).await.unwrap();
    auth.settings()
        .set_auth_config(&AuthSettings::default())
        .await
        .unwrap();
    drop(auth);
    dir.write_phase("bootstrapping");

    let host = AuthHost::start(&dir.0).await.unwrap();
    assert_initialized(&host, &dir).await;
}

#[tokio::test]
async fn an_auth_db_without_a_phase_record_is_refused() {
    let dir = TempDir::new();
    drop(HostAuth::open(dir.db()).await.unwrap());
    assert!(matches!(
        AuthHost::start(&dir.0).await,
        Err(StartupError::PhaseLost)
    ));
    assert_eq!(dir.saved_phase(), None);
}

#[tokio::test]
async fn a_missing_auth_db_after_the_first_start_is_refused_and_not_recreated() {
    for phase in ["initializing", "transitioning", "operational"] {
        let dir = TempDir::new();
        dir.write_phase(phase);
        let refused = AuthHost::start(&dir.0).await;
        assert!(
            matches!(refused, Err(StartupError::AuthDbMissing(p)) if p.as_str() == phase),
            "{phase}"
        );
        assert!(!dir.db().exists(), "{phase}");
        assert_eq!(dir.saved_phase(), phase_json(phase));
    }
}

#[tokio::test]
async fn an_invalid_phase_record_is_refused_and_kept() {
    for body in [
        "not json",
        r#"{"version":1,"phase":"unknown"}"#,
        r#"{"version":2,"phase":"operational"}"#,
        r#"{"version":1,"phase":"operational","extra":true}"#,
        r#"["operational"]"#,
    ] {
        let dir = TempDir::new();
        std::fs::write(dir.phase_file(), body).unwrap();
        assert!(
            matches!(
                AuthHost::start(&dir.0).await,
                Err(StartupError::PhaseCorrupt)
            ),
            "{body}"
        );
        assert_eq!(std::fs::read_to_string(dir.phase_file()).unwrap(), body);
        assert!(!dir.db().exists());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_dangling_phase_link_is_unreadable_not_absent() {
    let dir = TempDir::new();
    std::os::unix::fs::symlink(dir.0.join("gone"), dir.phase_file()).unwrap();
    assert!(matches!(
        AuthHost::start(&dir.0).await,
        Err(StartupError::PhaseUnreadable)
    ));
    assert!(!dir.db().exists());
}

#[tokio::test]
async fn one_host_per_data_dir() {
    let dir = TempDir::new();
    let host = AuthHost::start(&dir.0).await.unwrap();
    assert!(matches!(
        AuthHost::start(&dir.0).await,
        Err(StartupError::InUse)
    ));
    drop(host);
    AuthHost::start(&dir.0).await.unwrap();
}

#[tokio::test]
async fn the_transition_creates_the_admin_and_ends_auth_disabled_mode() {
    let dir = TempDir::new();
    let host = AuthHost::start(&dir.0).await.unwrap();
    let local_seq = host.auth().seq();

    let done = transition(&host, PASSWORD).await.unwrap();
    let current = done.session.expect("the admin's session");
    match &current.session {
        DesktopSession::Account(identity) => {
            assert_eq!(identity.username, "admin");
            assert_eq!(identity.role, Role::Admin);
        }
        other => panic!("expected the admin account, got {other:?}"),
    }
    assert!(current.seq > local_seq);
    assert_eq!(host.phase().await, AuthPhase::Operational);
    assert_eq!(dir.saved_phase(), phase_json("operational"));
    assert!(!auth_config(&host).await.disabled);
    assert!(matches!(
        transition(&host, PASSWORD).await,
        Err(TransitionError::NotAllowed)
    ));
    drop(host);

    // A restart is operational with auth on and no session until a login.
    let host = AuthHost::start(&dir.0).await.unwrap();
    assert_eq!(host.phase().await, AuthPhase::Operational);
    assert_eq!(session(&host).await, None);
    assert!(matches!(
        host.auth().login("admin", PASSWORD).await.unwrap(),
        LoginOutcome::LoggedIn(_)
    ));
}

#[tokio::test]
async fn the_transition_needs_the_synthetic_admin_session_in_initializing() {
    let dir = TempDir::new();
    let host = AuthHost::start(&dir.0).await.unwrap();
    let config = auth_config(&host).await;

    host.auth()
        .set_auth_config(&AuthSettings {
            disabled_role: Role::Editor,
            ..config.clone()
        })
        .await
        .unwrap();
    assert!(matches!(
        transition(&host, PASSWORD).await,
        Err(TransitionError::NotAllowed)
    ));

    host.auth()
        .set_auth_config(&AuthSettings {
            disabled: false,
            ..config
        })
        .await
        .unwrap();
    assert!(matches!(
        transition(&host, PASSWORD).await,
        Err(TransitionError::NotAllowed)
    ));
    assert_eq!(dir.saved_phase(), phase_json("initializing"));
    assert!(!host.auth().users().is_initialized().await.unwrap());
}

#[tokio::test]
async fn a_busy_registry_refuses_the_transition_without_saving() {
    let dir = TempDir::new();
    let host = AuthHost::start(&dir.0).await.unwrap();
    let refused = host
        .transition_to_operational("admin", PASSWORD, "管理者", || false)
        .await;
    assert!(matches!(refused, Err(TransitionError::Busy)));
    assert_eq!(host.phase().await, AuthPhase::Initializing);
    assert_eq!(dir.saved_phase(), phase_json("initializing"));
    assert!(!host.auth().users().is_initialized().await.unwrap());
    assert!(auth_config(&host).await.disabled);
}

#[tokio::test]
async fn the_transition_waits_for_the_gate_and_the_gate_sees_its_phase() {
    let dir = TempDir::new();
    let host = AuthHost::start(&dir.0).await.unwrap();
    let gate = host.gate().await;
    assert_eq!(gate.phase(), AuthPhase::Initializing);
    let blocked =
        tokio::time::timeout(Duration::from_millis(100), transition(&host, PASSWORD)).await;
    assert!(
        blocked.is_err(),
        "the transition ran while the gate was held"
    );
    assert_eq!(dir.saved_phase(), phase_json("initializing"));
    drop(gate);

    transition(&host, PASSWORD).await.unwrap();
    assert_eq!(host.gate().await.phase(), AuthPhase::Operational);
}

#[tokio::test]
async fn an_existing_admin_is_verified_instead_of_created() {
    let dir = TempDir::new();
    let host = AuthHost::start(&dir.0).await.unwrap();
    host.auth()
        .users()
        .setup_first_user("admin", PASSWORD, "管理者")
        .await
        .unwrap();
    host.auth()
        .users()
        .create_user("viewer", PASSWORD, "閲覧者", Role::Viewer)
        .await
        .unwrap();

    assert!(matches!(
        transition(&host, "wrong-password-1").await,
        Err(TransitionError::InvalidCredentials)
    ));
    assert!(matches!(
        host.transition_to_operational("viewer", PASSWORD, "", || true)
            .await,
        Err(TransitionError::NotAdmin)
    ));
    // Step 1 is saved before the credentials are checked.
    assert_eq!(host.phase().await, AuthPhase::Transitioning);
    assert!(!AuthPhase::Transitioning.admits_registry());
    assert!(auth_config(&host).await.disabled);

    transition(&host, PASSWORD).await.unwrap();
    assert_eq!(host.phase().await, AuthPhase::Operational);
}

#[tokio::test]
async fn an_interrupted_transition_resumes_after_a_restart() {
    for stop in [
        Checkpoint::Transitioning,
        Checkpoint::AdminReady,
        Checkpoint::AuthEnabled,
    ] {
        let dir = TempDir::new();
        let host = AuthHost::start(&dir.0).await.unwrap();
        let crashed = host
            .transition_with("admin", PASSWORD, "管理者", || true, &mut crash_at(stop))
            .await;
        assert!(
            matches!(crashed, Err(TransitionError::Crashed(point)) if point == stop),
            "{stop:?}"
        );
        drop(host);

        let host = AuthHost::start(&dir.0).await.unwrap();
        assert_eq!(host.phase().await, AuthPhase::Transitioning, "{stop:?}");
        assert_eq!(dir.saved_phase(), phase_json("transitioning"));
        if stop != Checkpoint::Transitioning {
            // The administrator exists: the credentials must verify.
            assert!(
                matches!(
                    transition(&host, "wrong-password-1").await,
                    Err(TransitionError::InvalidCredentials)
                ),
                "{stop:?}"
            );
        }
        let busy = host
            .transition_to_operational("admin", PASSWORD, "管理者", || false)
            .await;
        assert!(matches!(busy, Err(TransitionError::Busy)), "{stop:?}");

        let done = transition(&host, PASSWORD).await.unwrap();
        assert!(done.session.is_some(), "{stop:?}");
        assert_eq!(dir.saved_phase(), phase_json("operational"));
        assert!(!auth_config(&host).await.disabled);
        assert_eq!(
            host.auth().users().list_users().await.unwrap().len(),
            1,
            "{stop:?}"
        );
    }
}

#[tokio::test]
async fn a_crash_after_the_completion_point_leads_to_a_normal_login() {
    let dir = TempDir::new();
    let host = AuthHost::start(&dir.0).await.unwrap();
    let crashed = host
        .transition_with(
            "admin",
            PASSWORD,
            "管理者",
            || true,
            &mut crash_at(Checkpoint::Operational),
        )
        .await;
    assert!(matches!(
        crashed,
        Err(TransitionError::Crashed(Checkpoint::Operational))
    ));
    drop(host);

    let host = AuthHost::start(&dir.0).await.unwrap();
    assert_eq!(host.phase().await, AuthPhase::Operational);
    assert_eq!(session(&host).await, None);
    assert!(matches!(
        transition(&host, PASSWORD).await,
        Err(TransitionError::NotAllowed)
    ));
    assert!(matches!(
        host.auth().login("admin", PASSWORD).await.unwrap(),
        LoginOutcome::LoggedIn(_)
    ));
}

#[tokio::test]
async fn accounts_without_an_admin_refuse_the_transition_before_step_one() {
    let dir = TempDir::new();
    let host = AuthHost::start(&dir.0).await.unwrap();
    host.auth()
        .users()
        .setup_first_user("first", PASSWORD, "")
        .await
        .unwrap();
    // Banto keeps the last admin; only an outside write removes it.
    let raw = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(dir.db()),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE users SET role = 'viewer'")
        .execute(&raw)
        .await
        .unwrap();

    assert!(matches!(
        transition(&host, PASSWORD).await,
        Err(TransitionError::NotAllowed)
    ));
    assert_eq!(dir.saved_phase(), phase_json("initializing"));
    assert!(auth_config(&host).await.disabled);
}
