//! Product session issuance and read-only quiescence (host-gate design §3, §4, §6).
//! Only the host's auth gate holds the issuer, and it names a principal only through
//! [`RecordingPrincipal`], which is built from a verified Banto identity, never from wire text.
use super::{LeaseError, LeaseRole, RecordingRegistryRoot, RecordingRegistrySession};
use std::{fmt, sync::Arc};

const BANTO_USER_PREFIX: &str = "banto-user:";
const AUTH_DISABLED_LOCAL: &str = "banto-local:auth-disabled";

/// The registry principal of a host desktop session. It is not JSON: it has no parser and
/// no constructor from free text, so a wire string, role name, or Hub key cannot become one.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct RecordingPrincipal(String);

impl RecordingPrincipal {
    /// A Banto `users` account. Bound to `users.id`, never the username, which may change;
    /// Banto never reuses an ID.
    pub fn banto_user(user_id: i64) -> Self {
        Self(format!("{BANTO_USER_PREFIX}{user_id}"))
    }

    /// The synthetic session of Banto's auth-disabled mode. Its workflows end with the mode.
    pub fn auth_disabled_local() -> Self {
        Self(AUTH_DISABLED_LOCAL.to_owned())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for RecordingPrincipal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("RecordingPrincipal").field(&self.0).finish()
    }
}

/// The one capability that issues product sessions for its root. `try_new` returns exactly
/// one, and it is neither `Clone` nor constructible elsewhere.
pub struct RecordingSessionIssuer {
    root_identity: Arc<()>,
}

impl fmt::Debug for RecordingSessionIssuer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecordingSessionIssuer(..)")
    }
}

impl RecordingSessionIssuer {
    pub(super) fn new(root: &RecordingRegistryRoot) -> Self {
        Self {
            root_identity: root.identity.clone(),
        }
    }

    /// Issues a fresh grant for `principal` and `role`. Another root's issuer is `Forbidden`.
    ///
    /// Issuing again for a principal never restores a revoked grant: the new session has its
    /// own grant and serves that principal's saved replies, Observation, cancels, and
    /// subscriptions. Allowed while draining and after close, where the registry itself
    /// keeps only re-fetches and read lookups open.
    pub fn issue(
        &self,
        root: &mut RecordingRegistryRoot,
        principal: RecordingPrincipal,
        role: LeaseRole,
    ) -> Result<RecordingRegistrySession, LeaseError> {
        if !Arc::ptr_eq(&self.root_identity, &root.identity) {
            return Err(LeaseError::Forbidden);
        }
        Ok(RecordingRegistrySession {
            root_identity: root.identity.clone(),
            grant: Arc::new(()),
            scope: root.scope.clone(),
            principal: principal.0,
            role,
        })
    }
}

/// A read-only look at whether the root holds anything a principal change could strand.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistryQuiescence {
    quiescent: bool,
    /// Set only when every unsettled cause is the workflow's own change.
    attributed_to: Option<String>,
}

impl RegistryQuiescence {
    /// No unsettled workflow: no Candidate or Paused change, no registered admission still
    /// waiting for dispatch, no dispatch in flight or `unknown`, and native confirmed
    /// quiescence. A closed root has handed native ownership off and is quiescent.
    pub fn is_quiescent(&self) -> bool {
        self.quiescent
    }

    /// Whether demoting or deleting `principal` could strand unsettled work. Only when every
    /// unsettled cause is the workflow's own change (a stage admission, or a Candidate, Paused,
    /// or unconfirmed native change) is it limited to the workflow's principal. A read, an
    /// operation in flight, or a contended native lock names no owner, so it holds everyone.
    pub fn holds(&self, principal: &RecordingPrincipal) -> bool {
        !self.quiescent
            && self
                .attributed_to
                .as_deref()
                .is_none_or(|owner| owner == principal.as_str())
    }
}

impl RecordingRegistryRoot {
    /// Reports quiescence without changing anything: no lease, registration, dispatch, cancel,
    /// or native call. The host checks it under its own transition lock (design §4, §6), so
    /// nothing new is accepted between this answer and the auth change it guards.
    pub fn quiescence(&self) -> RegistryQuiescence {
        if self.closed {
            return RegistryQuiescence {
                quiescent: true,
                attributed_to: None,
            };
        }
        let native = self.seed.native_quiescence();
        let change_settled = native.change_settled
            && !self.workflow.as_ref().is_some_and(|workflow| {
                workflow.has_undispatched() || workflow.has_uncertain_dispatch()
            });
        let other_settled = native.other_settled
            && !self
                .reconciliations
                .iter()
                .any(|read| read.is_undispatched() || read.is_uncertain());
        let attributed_to = self
            .workflow
            .as_ref()
            .filter(|_| other_settled)
            .map(|workflow| workflow.principal.clone());
        RegistryQuiescence {
            quiescent: change_settled && other_settled,
            attributed_to,
        }
    }
}
