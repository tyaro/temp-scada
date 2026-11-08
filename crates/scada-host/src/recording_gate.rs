//! The recording registry's entry gate (host-gate design §3-§5, implementation
//! order §9 step 4-2). Tauri-independent: the commands of step 4-3 only parse
//! the wire request and call one method here.
//!
//! Every entry point:
//!
//! 1. takes the transition lock ([`AuthHost::gate`]) and refuses unless the
//!    phase [admits the registry](crate::auth_phase::AuthPhase::admits_registry);
//! 2. re-validates the desktop session and checks the role the command needs
//!    (read: Viewer or above, mutation: Admin), never a role the caller names;
//! 3. uses the registry session held for that desktop session's generation
//!    (`seq`) and role, issuing it on first use. When the generation changed,
//!    the sessions of the old one are revoked first, so `seq` alone decides
//!    revocation;
//! 4. re-validates once more before returning and binds the reply to the
//!    generation it was produced under. If the generation changed meanwhile
//!    (logout, another user, a role change), the reply is withheld as
//!    `Unauthorized`; the registry keeps what it registered and keeps
//!    monitoring, and the same principal recovers it after logging in again.
//!
//! Registry sessions, workflow tickets and principals never leave this type.
use std::sync::{Arc, Mutex, MutexGuard};

use banto_core::BantoError;
use scada_model::recording_wire::{
    RecordingWireAttachReply, RecordingWireAttachRequest, RecordingWireCallInspectionReply,
    RecordingWireCallInspectionRequest, RecordingWireCancelReply, RecordingWireCancelRequest,
    RecordingWireControlReply, RecordingWireControlRequest, RecordingWireLeaseReply,
    RecordingWireLeaseRequest, RecordingWireObservationReply, RecordingWireObservationRequest,
};
use scada_runtime::recording_registry::{
    LeaseError, LeaseRole, RecordingPrincipal, RecordingRegistryRoot, RecordingRegistrySession,
    RecordingSessionIssuer,
};

use crate::auth::{CurrentSession, Role};
use crate::auth_phase::{AuthHost, AuthPhase, PhaseGuard};

/// Why an entry point refused or failed.
#[derive(Debug)]
pub enum GateError {
    /// The phase refuses the registry (`transitioning`, design §6).
    Phase(AuthPhase),
    /// No desktop session, or it changed before the reply was returned.
    Unauthorized,
    /// The session's role does not allow this command or request.
    Forbidden,
    /// The auth DB could not be read. The session is kept and only this
    /// command fails (design §4).
    AuthUnavailable(BantoError),
    /// The registry's own answer.
    Registry(LeaseError),
}

/// A reply bound to the desktop-session generation it was produced under.
/// The UI drops replies of a generation other than its current one (§5).
#[derive(Debug, Clone, PartialEq)]
pub struct Bound<T> {
    pub seq: u64,
    pub reply: T,
}

/// What a command needs from the desktop session (design §5 table).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Need {
    /// Viewer or above, with the read registry session.
    Read,
    /// Admin, with the mutation registry session.
    Mutation,
    /// Authenticated, but the request is never served by this entry point
    /// (a mutation lease outside a workflow): `Forbidden`.
    Refused,
}

impl Need {
    fn min_role(self) -> Role {
        match self {
            Self::Read | Self::Refused => Role::Viewer,
            Self::Mutation => Role::Admin,
        }
    }

    fn lease_role(self) -> LeaseRole {
        match self {
            Self::Read | Self::Refused => LeaseRole::Reconciliation,
            Self::Mutation => LeaseRole::Mutation,
        }
    }
}

/// The registry sessions issued for one desktop-session generation.
struct HeldSessions {
    seq: u64,
    principal: RecordingPrincipal,
    read: Option<RecordingRegistrySession>,
    mutation: Option<RecordingRegistrySession>,
}

struct GateState {
    root: RecordingRegistryRoot,
    issuer: RecordingSessionIssuer,
    held: Option<HeldSessions>,
}

impl GateState {
    /// Revoke the held sessions if they are not newer than `through` and
    /// are not of the still-valid generation `keep`. A check only knows the
    /// generations up to the one it read: sessions issued for a later one
    /// (a login racing the check) are left for the next check.
    fn revoke_through(&mut self, through: u64, keep: Option<u64>) {
        if self
            .held
            .as_ref()
            .is_some_and(|held| held.seq <= through && Some(held.seq) != keep)
        {
            let held = self.held.take().expect("checked above");
            for session in [held.read, held.mutation].into_iter().flatten() {
                // Only this root's sessions are held, so this cannot fail.
                let _ = self.root.revoke_session(&session);
            }
        }
    }

    /// Apply one re-validation: `seen` is the slot generation read before it
    /// started, `current` its answer. An answer of no session ends every
    /// generation up to `seen`; a session ends every older one.
    fn settle(&mut self, seen: u64, current: Option<&CurrentSession>) {
        match current {
            Some(current) => self.revoke_through(current.seq, Some(current.seq)),
            None => self.revoke_through(seen, None),
        }
    }

    /// The registry session of `current`'s generation and `role`, issued on
    /// first use. Sessions of an older generation are revoked first.
    fn session_for(
        &mut self,
        current: &CurrentSession,
        role: LeaseRole,
    ) -> Result<RecordingRegistrySession, LeaseError> {
        // Called under the transition lock with a just-validated session:
        // anything held for another generation is stale.
        if self
            .held
            .as_ref()
            .is_some_and(|held| held.seq != current.seq)
        {
            self.revoke_through(u64::MAX, None);
        }
        let Self { root, issuer, held } = self;
        let held = held.get_or_insert_with(|| HeldSessions {
            seq: current.seq,
            principal: current.session.principal(),
            read: None,
            mutation: None,
        });
        let slot = match role {
            LeaseRole::Reconciliation => &mut held.read,
            LeaseRole::Mutation => &mut held.mutation,
        };
        if let Some(session) = slot {
            return Ok(session.clone());
        }
        let session = issuer.issue(root, held.principal.clone(), role)?;
        *slot = Some(session.clone());
        Ok(session)
    }
}

/// A command accepted under the transition lock, before its generation check.
struct Entered<'a, T> {
    _phase: PhaseGuard<'a>,
    current: CurrentSession,
    result: Result<T, LeaseError>,
}

#[cfg(test)]
type AfterCall = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

/// The host's single entry to the recording registry: it owns the root, its
/// issuer, and the registry sessions of the current desktop session.
pub struct RecordingGate {
    auth: Arc<AuthHost>,
    state: Mutex<GateState>,
    /// Test only: see [`Self::run_hook`].
    #[cfg(test)]
    after_call: Mutex<Option<AfterCall>>,
}

impl RecordingGate {
    /// Take ownership of the root and its issuer. The issuer never leaves
    /// the gate, so only the gate issues product sessions (design §3).
    pub fn new(
        auth: Arc<AuthHost>,
        root: RecordingRegistryRoot,
        issuer: RecordingSessionIssuer,
    ) -> Self {
        Self {
            auth,
            state: Mutex::new(GateState {
                root,
                issuer,
                held: None,
            }),
            #[cfg(test)]
            after_call: Mutex::new(None),
        }
    }

    pub fn auth(&self) -> &AuthHost {
        &self.auth
    }

    /// Re-validate the desktop session now and revoke the registry sessions
    /// of any other generation. Auth-changing commands (logout, role or
    /// password change, deletion, auth-mode switch) call this before they
    /// return, so the revocation does not wait for the next registry command
    /// (design §5). A read failure keeps the sessions.
    pub async fn refresh(&self) -> Result<Option<CurrentSession>, GateError> {
        let seen = self.auth.auth().seq();
        let current = self
            .auth
            .auth()
            .current()
            .await
            .map_err(GateError::AuthUnavailable)?;
        #[cfg(test)]
        self.run_hook().await;
        self.lock().settle(seen, current.as_ref());
        Ok(current)
    }

    /// `recording_lease`: a reconciliation lease only. A mutation lease is
    /// `Forbidden`; outside a workflow it has no use and would block the
    /// workflow reservation (design §5).
    pub async fn lease(
        &self,
        request: RecordingWireLeaseRequest,
    ) -> Result<Bound<RecordingWireLeaseReply>, GateError> {
        let need = if request.as_value()["role"] == "reconciliation" {
            Need::Read
        } else {
            Need::Refused
        };
        let entered = self
            .enter(need, "recording_lease", |root, session| {
                root.issue_lease(session, request)
            })
            .await?;
        self.bind(entered).await
    }

    /// `recording_observation` (read).
    pub async fn observation(
        &self,
        request: RecordingWireObservationRequest,
    ) -> Result<Bound<RecordingWireObservationReply>, GateError> {
        let entered = self
            .enter(Need::Read, "recording_observation", |root, session| {
                root.observe_result(session, request)
            })
            .await?;
        self.bind(entered).await
    }

    /// `recording_call_inspection`: read, whatever the original call's kind,
    /// so a principal demoted after losing a reply can recover it (§4).
    pub async fn call_inspection(
        &self,
        request: RecordingWireCallInspectionRequest,
    ) -> Result<Bound<RecordingWireCallInspectionReply>, GateError> {
        let entered = self
            .enter(Need::Read, "recording_call_inspection", |root, session| {
                root.inspect_call(session, request)
            })
            .await?;
        self.bind(entered).await
    }

    /// `recording_cancel`: an operation needs mutation (Admin), a
    /// reconciliation read needs read (adapter design §5).
    pub async fn cancel(
        &self,
        request: RecordingWireCancelRequest,
    ) -> Result<Bound<RecordingWireCancelReply>, GateError> {
        let need = if request.as_value()["target"]["kind"] == "operation" {
            Need::Mutation
        } else {
            Need::Read
        };
        let entered = self
            .enter(need, "recording_cancel", |root, session| {
                root.request_cancel(session, request)
            })
            .await?;
        self.bind(entered).await
    }

    /// `recording_attach` (read).
    pub async fn attach(
        &self,
        request: RecordingWireAttachRequest,
    ) -> Result<Bound<RecordingWireAttachReply>, GateError> {
        let entered = self
            .enter(Need::Read, "recording_attach", |root, session| {
                root.attach(session, request)
            })
            .await?;
        self.bind(entered).await
    }

    /// `recording_control` (read).
    pub async fn control(
        &self,
        request: RecordingWireControlRequest,
    ) -> Result<Bound<RecordingWireControlReply>, GateError> {
        let entered = self
            .enter(Need::Read, "recording_control", |root, session| {
                root.control(session, request)
            })
            .await?;
        self.bind(entered).await
    }

    /// Steps 1-3: the phase, the session and role, then the registry call
    /// with the held session of the current generation.
    async fn enter<T>(
        &self,
        need: Need,
        resource: &str,
        call: impl FnOnce(
            &mut RecordingRegistryRoot,
            &RecordingRegistrySession,
        ) -> Result<T, LeaseError>,
    ) -> Result<Entered<'_, T>, GateError> {
        let phase = self.auth.gate().await;
        if !phase.phase().admits_registry() {
            return Err(GateError::Phase(phase.phase()));
        }
        let seen = self.auth.auth().seq();
        let current = match self
            .auth
            .auth()
            .require_role(need.min_role(), resource)
            .await
        {
            Ok(current) => current,
            Err(BantoError::Unauthorized) => {
                self.lock().settle(seen, None);
                return Err(GateError::Unauthorized);
            }
            Err(BantoError::Forbidden) => {
                // The check just ran, so `seq` is the validated generation.
                let seq = self.auth.auth().seq();
                self.lock().revoke_through(seq, Some(seq));
                return Err(GateError::Forbidden);
            }
            Err(error) => return Err(GateError::AuthUnavailable(error)),
        };
        if need == Need::Refused {
            self.lock().settle(seen, Some(&current));
            return Err(GateError::Forbidden);
        }
        let result = {
            let mut state = self.lock();
            state
                .session_for(&current, need.lease_role())
                .and_then(|session| call(&mut state.root, &session))
        };
        Ok(Entered {
            _phase: phase,
            current,
            result,
        })
    }

    /// Step 4: re-validate and return the reply only to the generation that
    /// asked. The registry's state is never rolled back here.
    async fn bind<T>(&self, entered: Entered<'_, T>) -> Result<Bound<T>, GateError> {
        #[cfg(test)]
        self.run_hook().await;
        let seq = entered.current.seq;
        let seen = self.auth.auth().seq();
        match self.auth.auth().current().await {
            Ok(Some(after)) if after.seq == seq => {}
            Ok(after) => {
                self.lock().settle(seen, after.as_ref());
                return Err(GateError::Unauthorized);
            }
            Err(error) => return Err(GateError::AuthUnavailable(error)),
        }
        entered
            .result
            .map(|reply| Bound { seq, reply })
            .map_err(GateError::Registry)
    }

    fn lock(&self) -> MutexGuard<'_, GateState> {
        self.state.lock().expect("recording gate mutex poisoned")
    }

    /// Test only: run `hook` after the next registry call, before its
    /// generation check (a logout or user switch racing the command), or
    /// inside the next [`Self::refresh`], between its check and the
    /// revocation it decides (a login and command racing the refresh).
    #[cfg(test)]
    async fn run_hook(&self) {
        let hook = self.after_call.lock().expect("hook mutex").take();
        if let Some(hook) = hook {
            hook.await;
        }
    }

    #[cfg(test)]
    fn after_next_call(&self, hook: impl std::future::Future<Output = ()> + Send + 'static) {
        *self.after_call.lock().expect("hook mutex") = Some(Box::pin(hook));
    }

    /// Test only: the held session of `role`, if any.
    #[cfg(test)]
    fn held(&self, role: LeaseRole) -> Option<(u64, RecordingRegistrySession)> {
        let state = self.lock();
        let held = state.held.as_ref()?;
        let session = match role {
            LeaseRole::Reconciliation => held.read.clone(),
            LeaseRole::Mutation => held.mutation.clone(),
        }?;
        Some((held.seq, session))
    }

    /// Test only: direct access to the root.
    #[cfg(test)]
    fn with_root<T>(&self, f: impl FnOnce(&mut RecordingRegistryRoot) -> T) -> T {
        f(&mut self.lock().root)
    }
}

#[cfg(test)]
mod tests;
