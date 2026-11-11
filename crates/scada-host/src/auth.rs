//! Desktop authentication of the embedded SCADA host (host-gate design §2-§4).
//!
//! Users, settings and the audit log are Banto v7.0.0's
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
use banto_admin_services::settings::{AuthSettings, SettingsService};
pub use banto_admin_services::users::UserIdentity;
use banto_admin_services::users::{bound_username_for_audit, UsersService};
pub use banto_admin_services::Role;
pub use banto_core::BantoError;
use banto_storage::Db;
use scada_runtime::recording_registry::RecordingPrincipal;

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
    pub fn principal(&self) -> RecordingPrincipal {
        match self {
            Self::Account(identity) => RecordingPrincipal::banto_user(identity.id),
            Self::AuthDisabledLocal(_) => RecordingPrincipal::auth_disabled_local(),
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

/// What [`HostAuth::verify_login`] decided.
#[derive(Debug)]
pub(crate) enum Verified {
    /// The credentials verified; install with [`HostAuth::install_login`].
    Account {
        identity: UserIdentity,
        seq_at_entry: u64,
    },
    /// Nothing to install.
    Refused(LoginOutcome),
}

/// Outcome of [`HostAuth::resolve`].
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub session: Option<DesktopSession>,
    pub checked: u64,
    pub current: u64,
    pub stale: bool,
}

/// How many times [`HostAuth::current`] re-reads the store when concurrent
/// re-binds keep the slot from matching what it read.
const SETTLE_ATTEMPTS: usize = 3;

/// Outcome of one settle attempt.
#[derive(Debug, PartialEq)]
enum Settled {
    /// `moved`: another command re-bound the slot after it was read, and
    /// `current` is that newer session because the read reports exactly its
    /// binding; nothing was written.
    Decided {
        current: Option<CurrentSession>,
        moved: bool,
        /// The slot generation when this was decided.
        seq: u64,
    },
    /// The slot was re-bound meanwhile and no longer matches this read.
    Retry,
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
    /// The auth mode is read first, whatever the slot holds, so the slot
    /// follows Banto's invariant `auth.disabled <=> AuthDisabledLocal` even
    /// when the settings were changed outside this host:
    ///
    /// - mode on: the synthetic session with the current `disabled_role`.
    ///   An account session (or an empty slot) is replaced by it.
    /// - mode off, `Account`: the row is re-read; gone, another `id`, or
    ///   another `auth_epoch` clears the session.
    /// - mode off, `AuthDisabledLocal`: the session is cleared.
    ///
    /// A read failure is `Err` and keeps the session (a DB hiccup must not
    /// log the user out). The lock is never held across an `.await`.
    ///
    /// If another check or command re-bound the slot while the store was
    /// read and the slot no longer matches what this call read, the check is
    /// repeated (at most [`SETTLE_ATTEMPTS`] times, then `Err` like a read
    /// failure). It never answers with a role this call did not read.
    pub async fn current(&self) -> Result<Option<CurrentSession>, BantoError> {
        for _ in 0..SETTLE_ATTEMPTS {
            let (cached, seq_at_entry) = {
                let slot = self.lock();
                (slot.session.clone(), slot.seq)
            };
            let fresh = self.read_source(cached.as_ref()).await?;
            if let Settled::Decided { current, .. } = self.settle(fresh, seq_at_entry) {
                return Ok(current);
            }
        }
        Err(BantoError::Other(
            "認証状態の確認が他の操作と競合しました".to_string(),
        ))
    }

    /// Save the auth-mode settings, then settle the slot to the new mode
    /// within the same call (design §5: an auth change ends the sessions it
    /// affects without waiting for the next check). A raw
    /// `settings().set_auth_config` is still caught by the next [`Self::current`].
    pub async fn set_auth_config(
        &self,
        config: &AuthSettings,
    ) -> Result<Option<CurrentSession>, BantoError> {
        self.settings.set_auth_config(config).await?;
        self.current().await
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
        match self.verify_login(username, password).await? {
            Verified::Account {
                identity,
                seq_at_entry,
            } => self.install_verified(seq_at_entry, identity).await,
            Verified::Refused(outcome) => Ok(outcome),
        }
    }

    /// The first half of [`Self::login`]: check the mode and the credentials
    /// without writing the slot. The registry gate installs the result under
    /// its transition lock ([`Self::install_login`]), so a user switch does
    /// not overtake a registry command that validated the previous user.
    pub(crate) async fn verify_login(
        &self,
        username: &str,
        password: &str,
    ) -> Result<Verified, BantoError> {
        let seq_at_entry = self.seq();
        if self.settings.auth_config().await?.disabled {
            return Ok(Verified::Refused(LoginOutcome::AuthDisabled));
        }
        let verified = self.users.verify(username, password).await?;
        // The mode may have been turned on while the password was checked.
        if self.settings.auth_config().await?.disabled {
            return Ok(Verified::Refused(LoginOutcome::AuthDisabled));
        }
        let Some(identity) = verified else {
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
            return Ok(Verified::Refused(LoginOutcome::InvalidCredentials));
        };
        Ok(Verified::Account {
            identity,
            seq_at_entry,
        })
    }

    /// The second half of [`Self::login`]: install what
    /// [`Self::verify_login`] verified, unless the slot moved since.
    pub(crate) async fn install_login(
        &self,
        seq_at_entry: u64,
        identity: UserIdentity,
    ) -> Result<LoginOutcome, BantoError> {
        self.install_verified(seq_at_entry, identity).await
    }

    /// `auth_resolve` (Banto's `resolve_body`): re-validate once and report
    /// which slot write the answer is about. `checked` is the generation
    /// read before the store; `current` the one after this call's settle
    /// (`checked + 1` when this call ended or re-bound the session). If
    /// another command re-bound the slot while the store was read, nothing
    /// is written and the answer is `stale` with no session.
    pub async fn resolve(&self) -> Result<Resolved, BantoError> {
        let (cached, checked) = {
            let slot = self.lock();
            (slot.session.clone(), slot.seq)
        };
        let fresh = self.read_source(cached.as_ref()).await?;
        Ok(match self.settle(fresh, checked) {
            // The generation this call decided at, not a later one another
            // command may have reached since.
            Settled::Decided {
                current,
                moved: false,
                seq,
            } => Resolved {
                session: current.map(|c| c.session),
                checked,
                current: seq,
                stale: false,
            },
            Settled::Decided { moved: true, .. } | Settled::Retry => Resolved {
                session: None,
                checked,
                current: self.seq(),
                stale: true,
            },
        })
    }

    /// `auth_change_password`: change the logged-in account's own password
    /// and return the slot generation after it. The change advances the
    /// account's `auth_epoch`, which ends its sessions; this session just
    /// proved the current password, so it is re-bound to the new epoch
    /// (advancing `seq`), unless the account changed in between (then it
    /// ends at the next check). The synthetic session owns no credentials
    /// (`Forbidden`). Only `Unauthorized` can follow a slot write (the
    /// initial check clearing a revoked session), as in Banto.
    pub async fn change_own_password(
        &self,
        current_password: &str,
        new_password: &str,
    ) -> Result<u64, BantoError> {
        let (identity, validated) = match self.current().await? {
            Some(CurrentSession {
                session: DesktopSession::Account(identity),
                seq,
            }) => (identity, seq),
            Some(_) => return Err(BantoError::Forbidden),
            None => return Err(BantoError::Unauthorized),
        };
        let new_epoch = self
            .users
            .change_password(&identity.username, current_password, new_password)
            .await?;
        let seq = self.rebind_after_password_change(&identity, validated, new_epoch);
        // Never the old or new password, nor a hash (Banto spec M14).
        self.record_ok(
            &identity,
            "password_change",
            "users",
            Some(&identity.id.to_string()),
            None,
        )
        .await;
        Ok(seq)
    }

    /// Install an account the caller has just verified or created (the
    /// operational transition, design §6 step 5), like a login.
    pub(crate) async fn adopt(&self, identity: UserIdentity) -> Result<LoginOutcome, BantoError> {
        let seq_at_entry = self.seq();
        self.install_verified(seq_at_entry, identity).await
    }

    /// Install a verified account, then re-validate it before reporting
    /// success: the row read by `verify` may have been demoted, deleted or
    /// reset (or the mode turned on) while the password was checked. Such a
    /// session is cleared by that re-validation and reported `Superseded`.
    async fn install_verified(
        &self,
        seq_at_entry: u64,
        identity: UserIdentity,
    ) -> Result<LoginOutcome, BantoError> {
        let session = DesktopSession::Account(identity.clone());
        if self
            .compare_and_set(seq_at_entry, Some(session.clone()))
            .is_none()
        {
            return Ok(LoginOutcome::Superseded);
        }
        match self.current().await? {
            Some(current) if same_binding(&current.session, &session) => {
                self.record_ok(current.session.identity(), "login", "auth", None, None)
                    .await;
                Ok(LoginOutcome::LoggedIn(current))
            }
            _ => Ok(LoginOutcome::Superseded),
        }
    }

    /// End the account session and return the slot generation after it.
    /// A logout of an empty slot still advances `seq`, so a login that
    /// started before it can no longer install (Banto's rule). While
    /// auth-disabled mode keeps the synthetic session, logout is a no-op:
    /// the next check would install it again anyway.
    pub async fn logout(&self) -> u64 {
        let (ended, seq) = {
            let mut slot = self.lock();
            let ended = match slot.session.take() {
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
            };
            (ended, slot.seq)
        };
        if let Some(identity) = ended {
            self.record_ok(&identity, "logout", "auth", None, None)
                .await;
        }
        // The generation this logout set, not one a later login installed
        // while the audit entry was written.
        seq
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
        self.record(actor, action, resource, entity_id, detail, "ok")
            .await;
    }

    /// Record an actor-attributed event with its `result` (`ok`, `denied`
    /// or `failed`), best effort like [`Self::record_ok`].
    pub async fn record(
        &self,
        actor: &UserIdentity,
        action: &str,
        resource: &str,
        entity_id: Option<&str>,
        detail: Option<serde_json::Value>,
        result: &str,
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
                result,
            })
            .await;
    }

    /// Move the session validated at `validated` to the account's new epoch
    /// after its own password change, and return the slot generation. Only
    /// that session: a logout and a new login of the same account meanwhile
    /// (same id and epoch, a later `seq`) is a session the change ends, so
    /// it is left for the next check to clear.
    fn rebind_after_password_change(
        &self,
        identity: &UserIdentity,
        validated: u64,
        new_epoch: i64,
    ) -> u64 {
        let mut slot = self.lock();
        if new_epoch == identity.auth_epoch + 1 && slot.seq == validated {
            if let Some(DesktopSession::Account(session)) = slot.session.as_mut() {
                if session.id == identity.id && session.auth_epoch == identity.auth_epoch {
                    session.auth_epoch = new_epoch;
                    slot.seq += 1;
                }
            }
        }
        slot.seq
    }

    async fn read_source(
        &self,
        cached: Option<&DesktopSession>,
    ) -> Result<Option<DesktopSession>, BantoError> {
        let config = self.settings.auth_config().await?;
        if config.disabled {
            return Ok(Some(local_session(config.disabled_role)));
        }
        Ok(match cached {
            Some(DesktopSession::Account(identity)) => self
                .users
                .get_by_username(&identity.username)
                .await?
                .map(DesktopSession::Account),
            Some(DesktopSession::AuthDisabledLocal(_)) | None => None,
        })
    }

    /// Decide on `fresh` (read without the lock) against the slot as it is
    /// now. If another command re-bound the slot meanwhile, write nothing and
    /// keep the newer session only if `fresh` reports exactly its binding.
    ///
    /// Otherwise: the same binding is refreshed (`seq` advances only if the
    /// role changed); a synthetic `fresh` is installed over anything else; an
    /// account `fresh` of another binding clears the slot, so a session is
    /// never moved to the account's newest epoch on its behalf.
    fn settle(&self, fresh: Option<DesktopSession>, seq_at_entry: u64) -> Settled {
        let mut slot = self.lock();
        let same = match (slot.session.as_ref(), fresh.as_ref()) {
            (Some(now), Some(fresh)) => same_binding(now, fresh),
            _ => false,
        };
        if slot.seq != seq_at_entry {
            return match (slot.session.clone(), fresh) {
                (Some(session), Some(_)) if same => Settled::Decided {
                    current: Some(CurrentSession {
                        session,
                        seq: slot.seq,
                    }),
                    moved: true,
                    seq: slot.seq,
                },
                (None, None) => Settled::Decided {
                    current: None,
                    moved: true,
                    seq: slot.seq,
                },
                _ => Settled::Retry,
            };
        }
        let next = match fresh {
            Some(session) if same => {
                let role_changed =
                    slot.session.as_ref().map(DesktopSession::role) != Some(session.role());
                Some((session, role_changed))
            }
            Some(local @ DesktopSession::AuthDisabledLocal(_)) => Some((local, true)),
            Some(DesktopSession::Account(_)) | None => None,
        };
        let current = match next {
            Some((session, rebound)) => {
                if rebound {
                    slot.seq += 1;
                }
                slot.session = Some(session.clone());
                Some(CurrentSession {
                    session,
                    seq: slot.seq,
                })
            }
            None => {
                if slot.session.take().is_some() {
                    slot.seq += 1;
                }
                None
            }
        };
        Settled::Decided {
            current,
            moved: false,
            seq: slot.seq,
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
        // The synthetic session has no epoch: its role is its binding.
        (DesktopSession::AuthDisabledLocal(a), DesktopSession::AuthDisabledLocal(b)) => {
            a.role == b.role
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests;
