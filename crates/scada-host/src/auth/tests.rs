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
        .create_user("chief", PASSWORD, "管理者", Role::Admin)
        .await
        .unwrap();
    // Banto v8.0.0's 0015 opens a new DB in auth-disabled mode; these tests
    // start login-required, which needs the administrator first. Reopened so
    // the slot starts empty at generation 0.
    set_disabled(&auth, false, Role::Admin).await;
    drop(auth);
    let auth = HostAuth::open(db.path()).await.unwrap();
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
async fn open_applies_banto_migrations_once_and_starts_in_auth_disabled_mode() {
    let db = TempDb::new();
    let auth = HostAuth::open(db.path()).await.unwrap();
    // Banto v8.0.0's 0015: a new DB starts without login, as Admin.
    let current = auth.current().await.unwrap().unwrap();
    assert!(matches!(
        current.session,
        DesktopSession::AuthDisabledLocal(_)
    ));
    assert_eq!(current.session.role(), Role::Admin);
    // The built-in `admin` row (0014) is no administrator who can log in.
    assert!(!auth.users().has_admin().await.unwrap());
    drop(auth);

    let _auth = HostAuth::open(db.path()).await.unwrap();
    let applied: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&db.raw().await)
            .await
            .unwrap();
    assert_eq!(applied, [2, 3, 4, 5, 7, 8, 10, 12, 13, 14, 15]);
    // 0010's generated record-scope columns back the audit list's
    // `recordResource` / `recordId` filters.
    let scope_columns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_xinfo('audit_log') WHERE name IN ('record_resource', 'record_id')",
    )
    .fetch_one(&db.raw().await)
    .await
    .unwrap();
    assert_eq!(scope_columns, 2);
}

#[tokio::test]
async fn audit_rows_written_before_0010_are_scoped_by_record() {
    // Rows written while only the migrations up to 0008 were applied.
    let db = TempDb::new();
    {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(db.path())
            .create_if_missing(true);
        let pool = sqlx::SqlitePool::connect_with(options).await.unwrap();
        let mut migrator = sqlx::migrate::Migrator::new(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations-sqlite"),
        )
        .await
        .unwrap();
        let old: Vec<_> = migrator
            .migrations
            .iter()
            .filter(|m| m.version <= 8)
            .cloned()
            .collect();
        migrator.migrations = old.into();
        migrator.run(&pool).await.unwrap();
        for (resource, entity, detail) in [
            ("users", Some("7"), None),
            ("users", Some("7"), Some(r#"{"changes":["role"]}"#)),
            (
                "attachments",
                Some("a1"),
                Some(r#"{"parentResource":"users","parentId":"7"}"#),
            ),
            // Only one parent key, or broken JSON: the row keeps its own scope.
            (
                "attachments",
                Some("a2"),
                Some(r#"{"parentResource":"users"}"#),
            ),
            ("settings", None, Some("{not json")),
        ] {
            sqlx::query(
                "INSERT INTO audit_log (action, resource, entity_id, detail, origin) \
                 VALUES ('update', ?, ?, ?, 'tauri')",
            )
            .bind(resource)
            .bind(entity)
            .bind(detail)
            .execute(&pool)
            .await
            .unwrap();
        }
        pool.close().await;
    }

    let auth = HostAuth::open(db.path()).await.unwrap();
    let applied: Vec<i64> =
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
            .fetch_all(&db.raw().await)
            .await
            .unwrap();
    assert_eq!(applied, [2, 3, 4, 5, 7, 8, 10, 12, 13, 14, 15]);

    let scoped = |field: &str, value: &str| banto_core::FilterState {
        field: field.to_string(),
        op: banto_core::FilterOp::Eq,
        value: serde_json::json!(value),
    };
    let all = auth
        .audit()
        .list(banto_core::ListParams::default())
        .await
        .unwrap();
    assert_eq!(all.total_count, 5);
    let user_seven = auth
        .audit()
        .list(banto_core::ListParams {
            filters: vec![scoped("recordResource", "users"), scoped("recordId", "7")],
            ..Default::default()
        })
        .await
        .unwrap();
    let mut entities: Vec<_> = user_seven
        .rows
        .iter()
        .map(|row| (row.resource.as_str(), row.entity_id.as_deref()))
        .collect();
    entities.sort();
    assert_eq!(
        entities,
        [
            ("attachments", Some("a1")),
            ("users", Some("7")),
            ("users", Some("7"))
        ]
    );
    let a2 = auth
        .audit()
        .list(banto_core::ListParams {
            filters: vec![
                scoped("recordResource", "attachments"),
                scoped("recordId", "a2"),
            ],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(a2.total_count, 1);
    // The malformed-JSON row keeps its own columns and scopes to itself.
    let settings = auth
        .audit()
        .list(banto_core::ListParams {
            filters: vec![scoped("recordResource", "settings")],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(settings.total_count, 1);
    let row = &settings.rows[0];
    assert_eq!(
        (
            row.resource.as_str(),
            row.entity_id.as_deref(),
            row.detail.as_deref()
        ),
        ("settings", None, Some("{not json"))
    );
}

#[tokio::test]
async fn an_auth_db_created_before_banto_v8_is_refused() {
    // Banto v8.0.0 rewrote 0003 / 0005 in place (no data migration), so a DB
    // created earlier holds other checksums for them and does not open.
    let db = TempDb::new();
    drop(HostAuth::open(db.path()).await.unwrap());
    sqlx::query("UPDATE _sqlx_migrations SET checksum = X'00' WHERE version = 3")
        .execute(&db.raw().await)
        .await
        .unwrap();
    assert!(matches!(
        HostAuth::open(db.path()).await,
        Err(AuthOpenError::Outdated)
    ));
}

/// Open `db` after `edit` was run on it directly; the open must be refused
/// by Banto's startup check with a message containing `needle`.
async fn refused_after(db: &TempDb, edit: &str, needle: &str) {
    sqlx::raw_sql(sqlx::AssertSqlSafe(edit.to_owned()))
        .execute(&db.raw().await)
        .await
        .unwrap();
    match HostAuth::open(db.path()).await {
        Err(AuthOpenError::Refused(error)) => {
            let message = error.to_string();
            assert!(message.contains(needle), "{message}");
        }
        Err(other) => panic!("expected Refused, got {other:?}"),
        Ok(_) => panic!("expected Refused, the DB opened"),
    }
}

#[tokio::test]
async fn a_db_without_the_built_in_admin_row_is_refused() {
    let db = TempDb::new();
    drop(HostAuth::open(db.path()).await.unwrap());
    refused_after(
        &db,
        "DELETE FROM users WHERE kind = 'builtin'",
        "admin の行がありません",
    )
    .await;
}

#[tokio::test]
async fn a_users_read_that_fails_is_an_auth_error_not_a_refusal() {
    // The check never ran (here the table cannot be read at all): this must
    // not be reported as an edited DB to restore or set aside.
    let db = TempDb::new();
    drop(HostAuth::open(db.path()).await.unwrap());
    sqlx::query("ALTER TABLE users RENAME TO users_gone")
        .execute(&db.raw().await)
        .await
        .unwrap();
    match HostAuth::open(db.path()).await {
        Err(AuthOpenError::Auth(BantoError::Storage(_))) => {}
        Err(other) => panic!("expected Auth(Storage), got {other:?}"),
        Ok(_) => panic!("expected Auth(Storage), the DB opened"),
    }
}

#[tokio::test]
async fn an_account_named_like_the_built_in_admin_is_refused() {
    let db = TempDb::new();
    drop(HostAuth::open(db.path()).await.unwrap());
    refused_after(
        &db,
        "INSERT INTO users (username, password_hash, display_name, role, kind, account_uid) \
         VALUES ('Admin', 'x', '', 'viewer', 'account', 'uid-admin')",
        "同じ名前のアカウント",
    )
    .await;
}

#[tokio::test]
async fn login_required_without_an_admin_account_is_refused() {
    let (db, auth, admin) = with_admin().await;
    drop(auth);
    refused_after(
        &db,
        &format!("DELETE FROM users WHERE id = {}", admin.id),
        "ログインできる管理者のアカウントがありません",
    )
    .await;
}

#[tokio::test]
async fn the_reserved_name_admin_is_refused_ignoring_case() {
    // Banto v8.0.0 reserves the built-in `admin` for account names.
    let db = TempDb::new();
    let auth = HostAuth::open(db.path()).await.unwrap();
    for name in ["admin", "Admin", "ADMIN"] {
        let refused = auth
            .users()
            .create_user(name, PASSWORD, "", Role::Admin)
            .await;
        assert!(
            matches!(&refused, Err(BantoError::Validation { field_errors })
                if field_errors[0].field == "username"),
            "{name}: {refused:?}"
        );
    }
    assert!(!auth.users().has_admin().await.unwrap());
    drop(db);
}

#[tokio::test]
async fn login_installs_an_account_session_bound_to_the_user_id() {
    let (db, auth, admin) = with_admin().await;
    assert_eq!(
        auth.login("chief", "wrong-password").await.unwrap(),
        LoginOutcome::InvalidCredentials
    );
    let current = login(&auth, "chief").await;
    assert_eq!(
        current.session.principal().as_str(),
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
    let current = login(&auth, "chief").await;
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
    let current = login(&auth, "chief").await;
    let seq = auth.logout().await;
    assert!(seq > current.seq);
    assert_eq!(auth.current().await.unwrap(), None);
    assert_eq!(audit_rows(&db).await.last().unwrap().0, "logout");

    let again = login(&auth, "chief").await;
    assert_eq!(again.session.principal(), current.session.principal());
    assert!(again.seq > seq);
}

#[tokio::test]
async fn a_logout_during_an_initial_login_supersedes_it() {
    let (_db, auth, _) = with_admin().await;
    let seq_before = auth.seq();
    // The login reads `seq`, then awaits the auth DB; the logout of the
    // still-empty slot runs meanwhile and must win.
    let (outcome, seq_after_logout) = tokio::join!(auth.login("chief", PASSWORD), auth.logout());
    assert_eq!(outcome.unwrap(), LoginOutcome::Superseded);
    assert!(seq_after_logout > seq_before);
    assert_eq!(auth.current().await.unwrap(), None);
}

#[tokio::test]
async fn auth_disabled_mode_follows_the_current_role_and_ends_when_turned_off() {
    let db = TempDb::new();
    let auth = HostAuth::open(db.path()).await.unwrap();
    // Turning the mode off (below) needs an administrator (Banto v8.0.0).
    auth.users()
        .create_user("chief", PASSWORD, "管理者", Role::Admin)
        .await
        .unwrap();
    set_disabled(&auth, true, Role::Viewer).await;
    drop(auth);

    let auth = HostAuth::open(db.path()).await.unwrap();
    let viewer = auth.current().await.unwrap().unwrap();
    assert_eq!(
        viewer.session.principal().as_str(),
        "banto-local:auth-disabled"
    );
    assert_eq!(viewer.session.role(), Role::Viewer);
    assert_eq!(
        auth.login("chief", PASSWORD).await.unwrap(),
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
    let admin = login(&auth, "chief").await;

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
    assert_eq!(
        local.session.principal().as_str(),
        "banto-local:auth-disabled"
    );
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
    let admin = login(&auth, "chief").await;
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
    let (outcome, ()) = tokio::join!(auth.login("chief", PASSWORD), async {
        set_disabled(&auth, true, Role::Viewer).await;
    });
    assert_eq!(outcome.unwrap(), LoginOutcome::AuthDisabled);
    let current = auth.current().await.unwrap().unwrap();
    assert!(matches!(
        current.session,
        DesktopSession::AuthDisabledLocal(_)
    ));
}

#[tokio::test]
async fn a_stale_check_never_answers_with_a_role_it_did_not_read() {
    let (_db, auth, _admin) = with_admin().await;
    set_disabled(&auth, true, Role::Admin).await;
    let admin = auth.current().await.unwrap().unwrap();
    let stale = admin.seq - 1;

    // Another check moved the slot on; this one read Viewer meanwhile.
    assert_eq!(
        auth.settle(Some(local_session(Role::Viewer)), stale),
        Settled::Retry
    );
    assert_eq!(auth.current().await.unwrap(), Some(admin.clone()));
    // A stale read that agrees with the slot is answered from the slot.
    assert_eq!(
        auth.settle(Some(local_session(Role::Admin)), stale),
        Settled::Decided {
            current: Some(admin.clone()),
            moved: true,
            seq: admin.seq,
        }
    );
}

#[tokio::test]
async fn a_login_whose_account_changed_during_the_password_check_does_not_succeed() {
    let (_db, auth, _) = with_admin().await;
    let operator = auth
        .users()
        .create_user("operator", PASSWORD, "運転員", Role::Admin)
        .await
        .unwrap();

    // `verify` read the row as Admin; the account is demoted before install.
    let verified = auth
        .users()
        .verify("operator", PASSWORD)
        .await
        .unwrap()
        .unwrap();
    auth.users()
        .update_user(operator.id, "運転員", Role::Viewer)
        .await
        .unwrap();
    assert_eq!(
        auth.install_verified(auth.seq(), verified).await.unwrap(),
        LoginOutcome::Superseded
    );
    assert_eq!(auth.current().await.unwrap(), None);

    // Deleted meanwhile: the same.
    let verified = auth
        .users()
        .verify("operator", PASSWORD)
        .await
        .unwrap()
        .unwrap();
    auth.users().delete_user(operator.id, None).await.unwrap();
    assert_eq!(
        auth.install_verified(auth.seq(), verified).await.unwrap(),
        LoginOutcome::Superseded
    );
    assert_eq!(auth.current().await.unwrap(), None);

    // Auth-disabled mode turned on meanwhile: the synthetic session wins.
    let verified = auth
        .users()
        .verify("chief", PASSWORD)
        .await
        .unwrap()
        .unwrap();
    set_disabled(&auth, true, Role::Viewer).await;
    assert_eq!(
        auth.install_verified(auth.seq(), verified).await.unwrap(),
        LoginOutcome::Superseded
    );
    assert!(matches!(
        auth.current().await.unwrap().unwrap().session,
        DesktopSession::AuthDisabledLocal(_)
    ));
}

#[tokio::test]
async fn resolve_reports_the_generation_it_checked_and_the_one_it_left() {
    let (_db, auth, admin) = with_admin().await;
    let empty = auth.resolve().await.unwrap();
    assert_eq!(
        (empty.session, empty.checked, empty.current, empty.stale),
        (None, 0, 0, false)
    );

    let logged_in = login(&auth, "chief").await;
    let resolved = auth.resolve().await.unwrap();
    assert_eq!(resolved.session, Some(logged_in.session));
    assert_eq!(
        (resolved.checked, resolved.current, resolved.stale),
        (logged_in.seq, logged_in.seq, false)
    );

    // A reset ends the session: this call clears it (`current` = `checked` + 1).
    auth.users()
        .reset_password(admin.id, "another-horse-2")
        .await
        .unwrap();
    let ended = auth.resolve().await.unwrap();
    assert_eq!(ended.session, None);
    assert_eq!(
        (ended.checked, ended.current, ended.stale),
        (logged_in.seq, logged_in.seq + 1, false)
    );
}

#[tokio::test]
async fn a_resolve_overtaken_by_a_re_bind_is_stale_and_writes_nothing() {
    let (_db, auth, _) = with_admin().await;
    let logged_in = login(&auth, "chief").await;
    // Read as of the generation before the login: the slot has moved since.
    assert_eq!(
        auth.settle(Some(logged_in.session.clone()), logged_in.seq - 1),
        Settled::Decided {
            current: Some(logged_in.clone()),
            moved: true,
            seq: logged_in.seq,
        }
    );
    assert_eq!(auth.seq(), logged_in.seq);
}

#[tokio::test]
async fn changing_the_own_password_re_binds_this_session_to_the_new_epoch() {
    let (db, auth, admin) = with_admin().await;
    let before = login(&auth, "chief").await;
    let seq = auth
        .change_own_password(PASSWORD, "another-horse-2")
        .await
        .unwrap();
    assert_eq!(seq, before.seq + 1);
    let after = auth.current().await.unwrap().unwrap();
    assert_eq!(after.seq, seq);
    assert_eq!(after.session.identity().id, admin.id);
    assert_eq!(after.session.identity().auth_epoch, admin.auth_epoch + 1);
    assert!(audit_rows(&db)
        .await
        .iter()
        .any(|(action, resource, _)| action == "password_change" && resource == "users"));

    // A wrong current password changes nothing.
    assert!(matches!(
        auth.change_own_password(PASSWORD, "third-horse-3").await,
        Err(BantoError::Validation { .. })
    ));
    assert_eq!(auth.current().await.unwrap(), Some(after));
}

#[tokio::test]
async fn only_an_account_session_changes_its_own_password() {
    let (_db, auth, _admin) = with_admin().await;
    assert!(matches!(
        auth.change_own_password(PASSWORD, "another-horse-2").await,
        Err(BantoError::Unauthorized)
    ));
    set_disabled(&auth, true, Role::Admin).await;
    assert!(matches!(
        auth.change_own_password(PASSWORD, "another-horse-2").await,
        Err(BantoError::Forbidden)
    ));
}

#[tokio::test]
async fn a_relogin_during_the_password_change_is_not_re_bound() {
    let (_db, auth, admin) = with_admin().await;
    let before = login(&auth, "chief").await;
    let validated = before.session.identity().clone();
    // A logout and a new login of the same account (same id and epoch)
    // happen while the change validated `before` runs.
    auth.logout().await;
    let relogin = login(&auth, "chief").await;
    let new_epoch = auth
        .users()
        .change_password("chief", PASSWORD, "another-horse-2")
        .await
        .unwrap();
    assert_eq!(new_epoch, admin.auth_epoch + 1);
    assert_eq!(
        auth.rebind_after_password_change(&validated, before.seq, new_epoch),
        relogin.seq
    );
    // The newer session is ended by the change, not moved to the new epoch.
    assert_eq!(auth.current().await.unwrap(), None);
}
