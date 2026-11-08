//! Desktop authentication of the embedded SCADA host (host-gate design §2-§4).
//!
//! Users, settings and the audit log are Banto v6.10.0's
//! `banto-admin-services`; this module only owns the webview's single
//! [`DesktopSession`] slot and re-validates it on every check, ported from
//! Banto admin-template's `current_session` / `require_role`.
//!
//! One rule differs from Banto: the slot's `seq` also advances when the
//! synthetic auth-disabled session's role changes. `seq` therefore changes
//! exactly when what the session is authorized as changes, so a registry
//! session bound to `(seq, role)` can be revoked by comparing `seq` alone.
use std::path::Path;
use std::sync::Mutex;

use banto_admin_services::audit::{AuditEntry, AuditLogService};
use banto_admin_services::settings::SettingsService;
pub use banto_admin_services::users::UserIdentity;
use banto_admin_services::users::{bound_username_for_audit, UsersService};
pub use banto_admin_services::Role;
pub use banto_core::BantoError;
use banto_storage::Db;

/// File name of the auth DB inside the app data dir (design §2, §8-3).
pub const AUTH_DB_FILE: &str = "scada-auth.sqlite3";

/// `UserIdentity.id` of the synthetic auth-disabled session. Display only:
/// whether a session is synthetic is the [`DesktopSession`] variant.
const LOCAL_SESSION_ID: i64 = 0;
const LOCAL_USERNAME: &str = "local";

/// The webview session (design §3).
#[derive(Debug, Clone, PartialEq)]
pub enum DesktopSession {
    /// A Banto `users` account, bound to the row's `id` and `auth_epoch`.
    Account(UserIdentity),
    /// The synthetic identity of auth-disabled mode, valid while the mode is
    /// on, with the mode's current `disabled_role`.
    AuthDisabledLocal(UserIdentity),
}

impl DesktopSession {
    pub fn identity(&self) -> &UserIdentity {
        match self {
            Self::Account(identity) | Self::AuthDisabledLocal(identity) => identity,
        }
    }

    pub fn role(&self) -> Role {
        self.identity().role
    }

    /// The registry principal this session stands for (design §3). Bound to
    /// `users.id`, never the username, which may change.
    pub fn principal(&self) -> String {
        match self {
            Self::Account(identity) => format!("banto-user:{}", identity.id),
            Self::AuthDisabledLocal(_) => "banto-local:auth-disabled".to_string(),
        }
    }
}

/// A re-validated session and the slot generation it was validated under.
#[derive(Debug, Clone, PartialEq)]
pub struct CurrentSession {
    pub session: DesktopSession,
    pub seq: u64,
}

/// Outcome of [`HostAuth::login`].
#[derive(Debug, Clone, PartialEq)]
pub enum LoginOutcome {
    LoggedIn(CurrentSession),
    /// Unknown username or wrong password (not distinguished).
    InvalidCredentials,
    /// Auth-disabled mode is on; Banto refuses logins then.
    AuthDisabled,
    /// Another command re-bound the slot while the credentials were checked.
    Superseded,
}

#[derive(Debug, Default)]
struct AuthSlot {
    session: Option<DesktopSession>,
    seq: u64,
}

pub struct HostAuth {
    users: UsersService,
    settings: SettingsService,
    audit: AuditLogService,
    slot: Mutex<AuthSlot>,
}

impl HostAuth {
    /// Open (creating if missing) the auth DB at `path`, apply the copied
    /// Banto migrations and install the initial session: the synthetic
    /// session while auth-disabled mode is on, otherwise none.
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, BantoError> {
        let db = Db::connect_sqlite(path).await?;
        migrate(&db).await?;
        let auth = Self {
            users: UsersService::new(db.clone()),
            settings: SettingsService::new(db.clone()),
            audit: AuditLogService::new(db),
            slot: Mutex::new(AuthSlot::default()),
        };
        let config = auth.settings.auth_config().await?;
        if config.disabled {
            auth.lock().session = Some(local_session(config.disabled_role));
        }
        Ok(auth)
    }

    pub fn users(&self) -> &UsersService {
        &self.users
    }

    pub fn settings(&self) -> &SettingsService {
        &self.settings
    }

    pub fn audit(&self) -> &AuditLogService {
        &self.audit
    }

    /// The slot generation now, without re-validating.
    pub fn seq(&self) -> u64 {
        self.lock().seq
    }

    /// Re-validate the session against the auth DB (design §4).
    ///
    /// - `Account`: the row is re-read; gone, another `id`, or another
    ///   `auth_epoch` clears the session.
    /// - `AuthDisabledLocal`: the mode is re-read; off clears the session,
    ///   otherwise the current `disabled_role` applies.
    ///
    /// A read failure is `Err` and keeps the session (a DB hiccup must not
    /// log the user out). The lock is never held across an `.await`.
    pub async fn current(&self) -> Result<Option<CurrentSession>, BantoError> {
        let (cached, seq_at_entry) = {
            let slot = self.lock();
            (slot.session.clone(), slot.seq)
        };
        let Some(cached) = cached else {
            return Ok(None);
        };
        let fresh = self.read_source(&cached).await?;
        Ok(self.settle(fresh, seq_at_entry))
    }

    /// Require a session with at least `min`. No session is `Unauthorized`;
    /// a lower role is `Forbidden` and recorded as `denied` (best effort).
    pub async fn require_role(
        &self,
        min: Role,
        resource: &str,
    ) -> Result<CurrentSession, BantoError> {
        match self.current().await? {
            Some(current) if current.session.role().at_least(min) => Ok(current),
            Some(current) => {
                let identity = current.session.identity();
                self.audit
                    .record(AuditEntry {
                        actor_username: Some(&identity.username),
                        actor_role: Some(identity.role.as_str()),
                        action: "denied",
                        resource,
                        entity_id: None,
                        detail: None,
                        origin: "tauri",
                        result: "denied",
                    })
                    .await;
                Err(BantoError::Forbidden)
            }
            None => Err(BantoError::Unauthorized),
        }
    }

    /// Verify the credentials and install an account session.
    pub async fn login(&self, username: &str, password: &str) -> Result<LoginOutcome, BantoError> {
        let seq_at_entry = self.seq();
        if self.settings.auth_config().await?.disabled {
            return Ok(LoginOutcome::AuthDisabled);
        }
        let Some(identity) = self.users.verify(username, password).await? else {
            let bounded = bound_username_for_audit(username);
            self.audit
                .record(AuditEntry {
                    actor_username: Some(&bounded),
                    actor_role: None,
                    action: "login_failed",
                    resource: "auth",
                    entity_id: None,
                    detail: None,
                    origin: "tauri",
                    result: "failed",
                })
                .await;
            return Ok(LoginOutcome::InvalidCredentials);
        };
        let session = DesktopSession::Account(identity.clone());
        let Some(seq) = self.compare_and_set(seq_at_entry, Some(session.clone())) else {
            return Ok(LoginOutcome::Superseded);
        };
        self.record_ok(&identity, "login", "auth", None, None).await;
        Ok(LoginOutcome::LoggedIn(CurrentSession { session, seq }))
    }

    /// End the account session and return the slot generation after it.
    /// A logout of an empty slot still advances `seq`, so a login that
    /// started before it can no longer install (Banto's rule). While
    /// auth-disabled mode keeps the synthetic session, logout is a no-op:
    /// the next check would install it again anyway.
    pub async fn logout(&self) -> u64 {
        let ended = {
            let mut slot = self.lock();
            match slot.session.take() {
                Some(DesktopSession::Account(identity)) => {
                    slot.seq += 1;
                    Some(identity)
                }
                Some(local @ DesktopSession::AuthDisabledLocal(_)) => {
                    slot.session = Some(local);
                    None
                }
                None => {
                    slot.seq += 1;
                    None
                }
            }
        };
        if let Some(identity) = ended {
            self.record_ok(&identity, "logout", "auth", None, None)
                .await;
        }
        self.seq()
    }

    /// Record a successful, actor-attributed event (best effort, Banto's
    /// `record`): a failed audit write never fails the operation.
    pub async fn record_ok(
        &self,
        actor: &UserIdentity,
        action: &str,
        resource: &str,
        entity_id: Option<&str>,
        detail: Option<serde_json::Value>,
    ) {
        self.audit
            .record(AuditEntry {
                actor_username: Some(&actor.username),
                actor_role: Some(actor.role.as_str()),
                action,
                resource,
                entity_id,
                detail,
                origin: "tauri",
                result: "ok",
            })
            .await;
    }

    async fn read_source(
        &self,
        cached: &DesktopSession,
    ) -> Result<Option<DesktopSession>, BantoError> {
        Ok(match cached {
            DesktopSession::Account(identity) => self
                .users
                .get_by_username(&identity.username)
                .await?
                .map(DesktopSession::Account),
            DesktopSession::AuthDisabledLocal(_) => {
                let config = self.settings.auth_config().await?;
                config.disabled.then(|| local_session(config.disabled_role))
            }
        })
    }

    /// Decide on `fresh` (read without the lock) against the slot as it is
    /// now. If another command re-bound the slot meanwhile, write nothing and
    /// keep the newer session only if `fresh` reports exactly its binding.
    fn settle(&self, fresh: Option<DesktopSession>, seq_at_entry: u64) -> Option<CurrentSession> {
        let mut slot = self.lock();
        let valid = match slot.session.as_ref() {
            Some(now) => fresh.filter(|fresh| same_binding(now, fresh)),
            None => None,
        };
        if slot.seq != seq_at_entry {
            let session = valid.and(slot.session.clone())?;
            return Some(CurrentSession {
                session,
                seq: slot.seq,
            });
        }
        let previous_role = slot.session.as_ref().map(DesktopSession::role);
        match valid {
            Some(session) => {
                if previous_role != Some(session.role()) {
                    slot.seq += 1;
                }
                slot.session = Some(session.clone());
                Some(CurrentSession {
                    session,
                    seq: slot.seq,
                })
            }
            None => {
                slot.session = None;
                slot.seq += 1;
                None
            }
        }
    }

    /// Write `next` and advance `seq` only if `seq` is still `expected`.
    fn compare_and_set(&self, expected: u64, next: Option<DesktopSession>) -> Option<u64> {
        let mut slot = self.lock();
        if slot.seq != expected {
            return None;
        }
        slot.session = next;
        slot.seq += 1;
        Some(slot.seq)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, AuthSlot> {
        self.slot.lock().expect("auth slot mutex poisoned")
    }
}

/// Banto admin-template's SQLite migrations 0002-0008 without the demo
/// `items` (0001) and attachments (0006), copied verbatim so their checksums
/// match Banto's.
async fn migrate(db: &Db) -> Result<(), BantoError> {
    let pool = db
        .as_sqlite()
        .ok_or_else(|| BantoError::Storage("auth DB must be SQLite".to_string()))?;
    sqlx::migrate!("./migrations-sqlite")
        .run(pool)
        .await
        .map_err(|error| BantoError::Storage(error.to_string()))
}

fn local_session(role: Role) -> DesktopSession {
    DesktopSession::AuthDisabledLocal(UserIdentity {
        id: LOCAL_SESSION_ID,
        username: LOCAL_USERNAME.to_string(),
        display_name: String::new(),
        role,
        auth_epoch: 0,
    })
}

fn same_binding(a: &DesktopSession, b: &DesktopSession) -> bool {
    match (a, b) {
        (DesktopSession::Account(a), DesktopSession::Account(b)) => {
            a.id == b.id && a.auth_epoch == b.auth_epoch
        }
        (DesktopSession::AuthDisabledLocal(_), DesktopSession::AuthDisabledLocal(_)) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests;
