use std::path::PathBuf;

use banto_admin_services::settings::AuthSettings;

use super::*;

/// A fresh auth DB file under the OS temp dir, removed on drop.
struct TempDb(PathBuf);

impl TempDb {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("scada-host-auth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> PathBuf {
        self.0.join(AUTH_DB_FILE)
    }

    async fn raw(&self) -> sqlx::SqlitePool {
        sqlx::SqlitePool::connect_with(
            sqlx::sqlite::SqliteConnectOptions::new().filename(self.path()),
        )
        .await
        .unwrap()
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const PASSWORD: &str = "correct-horse-1";

async fn with_admin() -> (TempDb, HostAuth, UserIdentity) {
    let db = TempDb::new();
    let auth = HostAuth::open(db.path()).await.unwrap();
    let admin = auth
        .users()
        .setup_first_user("admin", PASSWORD, "管理者")
        .await
        .unwrap();
    (db, auth, admin)
}

async fn login(auth: &HostAuth, username: &str) -> CurrentSession {
    match auth.login(username, PASSWORD).await.unwrap() {
        LoginOutcome::LoggedIn(current) => current,
        other => panic!("login failed: {other:?}"),
    }
}

async fn set_disabled(auth: &HostAuth, disabled: bool, role: Role) {
    auth.settings()
        .set_auth_config(&AuthSettings {
            disabled,
            disabled_role: role,
            autologin_enabled: false,
            autologin_username: None,
        })
        .await
        .unwrap();
}

async fn audit_rows(db: &TempDb) -> Vec<(String, String, String)> {
    sqlx::query_as("SELECT action, resource, result FROM audit_log ORDER BY id")
        .fetch_all(&db.raw().await)
        .await
        .unwrap()
}

#[tokio::test]
async fn open_applies_banto_migrations_once_and_starts_without_a_session() {
    let db = TempDb::new();
    let auth = HostAuth::open(db.path()).await.unwrap();
    assert_eq!(auth.current().await.unwrap(), None);
    assert!(!auth.users().is_initialized().await.unwrap());
    drop(auth);

    let auth = HostAuth::open(db.path()).await.unwrap();
    let applied: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&db.raw().await)
            .await
            .unwrap();
    assert_eq!(applied, [2, 3, 4, 5, 7, 8]);
    assert!(matches!(
        auth.require_role(Role::Viewer, "recording").await,
        Err(BantoError::Unauthorized)
    ));
}

#[tokio::test]
async fn login_installs_an_account_session_bound_to_the_user_id() {
    let (db, auth, admin) = with_admin().await;
    assert_eq!(
        auth.login("admin", "wrong-password").await.unwrap(),
        LoginOutcome::InvalidCredentials
    );
    let current = login(&auth, "admin").await;
    assert_eq!(
        current.session.principal(),
        format!("banto-user:{}", admin.id)
    );
    assert_eq!(
        auth.require_role(Role::Admin, "recording").await.unwrap(),
        current
    );
    assert_eq!(
        audit_rows(&db).await,
        [
            ("login_failed".into(), "auth".into(), "failed".into()),
            ("login".into(), "auth".into(), "ok".into()),
        ]
    );
}

#[tokio::test]
async fn a_lower_role_is_forbidden_and_recorded_as_denied() {
    let (db, auth, _) = with_admin().await;
    auth.users()
        .create_user("viewer", PASSWORD, "閲覧者", Role::Viewer)
        .await
        .unwrap();
    let viewer = login(&auth, "viewer").await;
    assert_eq!(
        auth.require_role(Role::Viewer, "recording").await.unwrap(),
        viewer
    );
    assert!(matches!(
        auth.require_role(Role::Admin, "recording").await,
        Err(BantoError::Forbidden)
    ));
    assert_eq!(
        audit_rows(&db).await.last().unwrap(),
        &("denied".into(), "recording".into(), "denied".into())
    );
}

#[tokio::test]
async fn role_change_password_reset_and_deletion_end_the_session() {
    let (_db, auth, admin) = with_admin().await;
    let other = auth
        .users()
        .create_user("operator", PASSWORD, "運転員", Role::Admin)
        .await
        .unwrap();

    let before = login(&auth, "operator").await;
    auth.users()
        .update_user(other.id, "運転員（改名）", Role::Admin)
        .await
        .unwrap();
    let renamed = auth.current().await.unwrap().unwrap();
    assert_eq!(
        renamed.seq, before.seq,
        "a display-name edit keeps the session"
    );
    assert_eq!(renamed.session.identity().display_name, "運転員（改名）");

    auth.users()
        .update_user(other.id, "運転員", Role::Viewer)
        .await
        .unwrap();
    assert_eq!(auth.current().await.unwrap(), None);
    assert!(auth.seq() > before.seq);

    let before = login(&auth, "operator").await;
    assert_eq!(before.session.role(), Role::Viewer);
    auth.users()
        .reset_password(other.id, PASSWORD)
        .await
        .unwrap();
    assert_eq!(auth.current().await.unwrap(), None);

    login(&auth, "operator").await;
    auth.users()
        .delete_user(other.id, Some(admin.id))
        .await
        .unwrap();
    assert_eq!(auth.current().await.unwrap(), None);
}

#[tokio::test]
async fn a_read_failure_keeps_the_session_and_fails_only_that_check() {
    let (db, auth, _) = with_admin().await;
    let current = login(&auth, "admin").await;
    let raw = db.raw().await;
    sqlx::query("ALTER TABLE users RENAME TO users_hidden")
        .execute(&raw)
        .await
        .unwrap();
    assert!(auth.current().await.is_err());
    assert_eq!(auth.seq(), current.seq);

    sqlx::query("ALTER TABLE users_hidden RENAME TO users")
        .execute(&raw)
        .await
        .unwrap();
    assert_eq!(auth.current().await.unwrap(), Some(current));
}

#[tokio::test]
async fn logout_ends_the_account_session_and_advances_the_generation() {
    let (db, auth, _) = with_admin().await;
    let current = login(&auth, "admin").await;
    let seq = auth.logout().await;
    assert!(seq > current.seq);
    assert_eq!(auth.current().await.unwrap(), None);
    assert_eq!(audit_rows(&db).await.last().unwrap().0, "logout");

    let again = login(&auth, "admin").await;
    assert_eq!(again.session.principal(), current.session.principal());
    assert!(again.seq > seq);
}

#[tokio::test]
async fn a_logout_during_an_initial_login_supersedes_it() {
    let (_db, auth, _) = with_admin().await;
    let seq_before = auth.seq();
    // The login reads `seq`, then awaits the auth DB; the logout of the
    // still-empty slot runs meanwhile and must win.
    let (outcome, seq_after_logout) = tokio::join!(auth.login("admin", PASSWORD), auth.logout());
    assert_eq!(outcome.unwrap(), LoginOutcome::Superseded);
    assert!(seq_after_logout > seq_before);
    assert_eq!(auth.current().await.unwrap(), None);
}

#[tokio::test]
async fn auth_disabled_mode_follows_the_current_role_and_ends_when_turned_off() {
    let db = TempDb::new();
    let auth = HostAuth::open(db.path()).await.unwrap();
    set_disabled(&auth, true, Role::Viewer).await;
    drop(auth);

    let auth = HostAuth::open(db.path()).await.unwrap();
    let viewer = auth.current().await.unwrap().unwrap();
    assert_eq!(viewer.session.principal(), "banto-local:auth-disabled");
    assert_eq!(viewer.session.role(), Role::Viewer);
    assert_eq!(
        auth.login("admin", PASSWORD).await.unwrap(),
        LoginOutcome::AuthDisabled
    );
    assert_eq!(
        auth.logout().await,
        viewer.seq,
        "logout keeps the synthetic session"
    );

    set_disabled(&auth, true, Role::Admin).await;
    let admin = auth.require_role(Role::Admin, "recording").await.unwrap();
    assert!(
        admin.seq > viewer.seq,
        "a role change re-binds the generation"
    );
    assert_eq!(auth.current().await.unwrap(), Some(admin.clone()));

    set_disabled(&auth, false, Role::Admin).await;
    assert_eq!(auth.current().await.unwrap(), None);
    assert!(auth.seq() > admin.seq);
}

#[tokio::test]
async fn turning_auth_disabled_mode_on_replaces_a_logged_in_account() {
    let (_db, auth, _) = with_admin().await;
    let admin = login(&auth, "admin").await;

    let local = auth
        .set_auth_config(&AuthSettings {
            disabled: true,
            disabled_role: Role::Viewer,
            autologin_enabled: false,
            autologin_username: None,
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(local.session.principal(), "banto-local:auth-disabled");
    assert_eq!(local.session.role(), Role::Viewer);
    assert!(local.seq > admin.seq);
    assert!(matches!(
        auth.require_role(Role::Admin, "recording").await,
        Err(BantoError::Forbidden)
    ));
}

#[tokio::test]
async fn a_mode_change_made_outside_the_host_is_followed_on_the_next_check() {
    let (_db, auth, _) = with_admin().await;
    let admin = login(&auth, "admin").await;
    set_disabled(&auth, true, Role::Viewer).await;
    let local = auth.current().await.unwrap().unwrap();
    assert!(matches!(
        local.session,
        DesktopSession::AuthDisabledLocal(_)
    ));
    assert!(local.seq > admin.seq);

    // An empty slot also picks the synthetic session up.
    set_disabled(&auth, false, Role::Viewer).await;
    assert_eq!(auth.current().await.unwrap(), None);
    set_disabled(&auth, true, Role::Admin).await;
    let installed = auth.current().await.unwrap().unwrap();
    assert_eq!(installed.session.role(), Role::Admin);
    assert_eq!(auth.current().await.unwrap(), Some(installed));
}

#[tokio::test]
async fn a_login_racing_the_mode_turning_on_never_leaves_an_account_session() {
    let (_db, auth, _) = with_admin().await;
    let (outcome, ()) = tokio::join!(auth.login("admin", PASSWORD), async {
        set_disabled(&auth, true, Role::Viewer).await;
    });
    assert_eq!(outcome.unwrap(), LoginOutcome::AuthDisabled);
    let current = auth.current().await.unwrap().unwrap();
    assert!(matches!(
        current.session,
        DesktopSession::AuthDisabledLocal(_)
    ));
}
