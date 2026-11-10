//! The exit's discard of a Candidate (product-owner design §6.1): the one
//! registry operation the host runs without a user's authorization, only to
//! return the native owner from Candidate to `Idle` so the exit can take the
//! Supervisor back and stop the recording. The discard changes no native
//! state (plan, mapping, retention or recording).
//!
//! It runs under the transition lock and the gate's lock, with a registry
//! session issued for the workflow's reserving principal and revoked before
//! returning. The desktop session is not consulted: the principal may have
//! logged out, been demoted or been deleted. A discard lease the principal
//! already holds is taken over under its own IDs; one that expired
//! unregistered is replaced by the registry under new IDs.
use std::time::Duration;

use scada_runtime::recording_operations::OperationsPhase;

use super::*;

/// The audit actor of the exit's discard: the host itself, not a user.
/// Banto usernames never contain `:`, so it names no account.
pub const SHUTDOWN_ACTOR: &str = "host:shutdown";

/// The longest discard lease the registry grants (`requestedBudgetMs`).
const MAX_LEASE_MS: u64 = 10_000;

/// What the exit's discard did.
#[derive(Debug)]
pub enum ShutdownDiscard {
    /// The installed root's owner is not a Candidate of the held workflow's
    /// preflight (no root, another phase, or no workflow): nothing to do.
    NotCandidate,
    /// The registry cannot decide yet (`Busy`: the preflight's completion is
    /// not visible yet). Nothing was registered; ask again.
    Pending,
    /// The discard was dispatched, or refused.
    Done(ShutdownDiscarded),
}

/// The result of the exit's discard, for its audit.
#[derive(Debug)]
pub struct ShutdownDiscarded {
    principal: RecordingPrincipal,
    /// The discard's admission ID, once a lease was taken.
    admission_id: Option<String>,
    /// The dispatch reply's outcome kind, or the registry's refusal.
    result: Result<String, LeaseError>,
}

impl ShutdownDiscarded {
    /// Whether the owner went back to `Idle` (`completedDiscard`).
    pub fn completed(&self) -> bool {
        matches!(&self.result, Ok(kind) if kind == "completedDiscard")
    }

    pub fn outcome(&self) -> Result<&str, &LeaseError> {
        self.result.as_deref()
    }

    /// The discard's admission ID, once a lease was taken.
    pub fn admission_id(&self) -> Option<&str> {
        self.admission_id.as_deref()
    }
}

/// What closing the window asks of the user first (design §6.1, the
/// confirmation dialog). Read without the transition lock: it is a snapshot
/// for the dialog, and the exit sequence decides again by itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseCheck {
    /// Nothing unsettled (no root, a quiescent root, or a Paused change the
    /// exit leaves to the next start): close at once.
    Close,
    /// A Candidate: the exit would discard it. Ask first.
    Candidate,
    /// Accepted work still running (a preflight, a pause/join or apply, a
    /// read) or not yet settled: the exit waits for it, within its limit.
    Waiting,
}

impl CloseCheck {
    /// By the owner phase and the root's quiescence, as the exit decides:
    /// it hands a quiescent root off, leaves a Paused change, discards a
    /// Candidate and waits for anything else.
    pub(crate) fn of(phase: Option<OperationsPhase>, quiescent: bool) -> Self {
        match phase {
            Some(OperationsPhase::Paused) => Self::Close,
            Some(OperationsPhase::Candidate) => Self::Candidate,
            _ if quiescent => Self::Close,
            _ => Self::Waiting,
        }
    }
}

impl RecordingGate {
    /// What closing the window asks of the user first (design §6.1).
    pub fn close_check(&self) -> CloseCheck {
        let state = self.lock();
        let Ok(installed) = state.installed.as_ref() else {
            return CloseCheck::Close;
        };
        CloseCheck::of(
            installed.root.owner_phase(),
            installed.root.quiescence().is_quiescent(),
        )
    }

    /// The installed root's native owner phase; `None` with no root.
    pub fn owner_phase(&self) -> Option<OperationsPhase> {
        self.lock()
            .installed
            .as_ref()
            .ok()
            .and_then(|root| root.root.owner_phase())
    }

    /// Discard the installed root's Candidate for the exit (design §6.1),
    /// under the transition lock `_phase`. `budget` is what is left of the
    /// exit's wait; a new discard lease asks no more than that.
    pub fn shutdown_discard(&self, _phase: &PhaseGuard<'_>, budget: Duration) -> ShutdownDiscard {
        let mut state = self.lock();
        let Ok(installed) = state.installed.as_mut() else {
            return ShutdownDiscard::NotCandidate;
        };
        if installed.root.owner_phase() != Some(OperationsPhase::Candidate) {
            return ShutdownDiscard::NotCandidate;
        }
        let RootState {
            root,
            issuer,
            workflow,
            scope,
            ..
        } = installed;
        let Some(held) = workflow.as_mut() else {
            return ShutdownDiscard::NotCandidate;
        };
        let Some(preflight) = held.preflight.clone() else {
            return ShutdownDiscard::NotCandidate;
        };
        let principal = held.principal.clone();
        #[cfg(test)]
        if self
            .refuse_shutdown_discard
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return ShutdownDiscard::Done(ShutdownDiscarded {
                principal,
                admission_id: None,
                result: Err(LeaseError::Forbidden),
            });
        }
        // Not entered in the session table: this session serves the discard
        // only and ends with it.
        let session = match issuer.issue(root, principal.clone(), LeaseRole::Mutation) {
            Ok(session) => session,
            Err(error) => {
                return ShutdownDiscard::Done(ShutdownDiscarded {
                    principal,
                    admission_id: None,
                    result: Err(error),
                })
            }
        };
        let mut admission_id = None;
        let budget_ms = u64::try_from(budget.as_millis())
            .unwrap_or(MAX_LEASE_MS)
            .clamp(1, MAX_LEASE_MS);
        let result = discard(
            root,
            &session,
            held,
            &preflight,
            scope,
            budget_ms,
            &mut admission_id,
        );
        // Only this root's session: it cannot fail.
        let _ = root.revoke_session(&session);
        match result {
            Err(LeaseError::Busy) => ShutdownDiscard::Pending,
            result => ShutdownDiscard::Done(ShutdownDiscarded {
                principal,
                admission_id,
                result,
            }),
        }
    }

    /// Test only: the next exit's discard of a Candidate is refused by the
    /// registry, before any lease is taken.
    #[cfg(test)]
    pub(crate) fn refuse_next_shutdown_discard(&self) {
        self.refuse_shutdown_discard
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Audit the exit's discard like the gate's other mutation
    /// registrations (`register`, `recording_admission`), with the host as
    /// the actor and the reserving principal in the detail (design §6.1).
    pub async fn audit_shutdown_discard(&self, done: &ShutdownDiscarded) {
        let actor = UserIdentity {
            id: 0,
            username: SHUTDOWN_ACTOR.to_owned(),
            display_name: String::new(),
            role: Role::Admin,
            auth_epoch: 0,
        };
        let mut detail = json!({
            "stage": "discard",
            "origin": "shutdown",
            "principal": done.principal.as_str(),
        });
        let outcome = match &done.result {
            Ok(kind) if kind == "completedDiscard" => "ok",
            // Dispatched, but the owner did not go back to `Idle`.
            Ok(kind) => {
                detail["outcome"] = json!(kind);
                "failed"
            }
            Err(error) => {
                detail["error"] = json!(format!("{error:?}"));
                audit_result(&Err(error))
            }
        };
        self.write_audit(
            &actor,
            "register",
            "recording_admission",
            done.admission_id.as_deref().unwrap_or_default(),
            Some(detail),
            outcome,
        )
        .await;
    }
}

/// Take a discard lease, register the discard and dispatch it; the outcome
/// kind of its reply.
fn discard(
    root: &mut RecordingRegistryRoot,
    session: &RecordingRegistrySession,
    held: &mut HeldWorkflow,
    preflight: &RecordingRegistryAdmissionTicket,
    scope: &Value,
    budget_ms: u64,
    admission_id: &mut Option<String>,
) -> Result<String, LeaseError> {
    let accepted = root
        .preflight_reply(session, preflight)?
        .ok_or(LeaseError::Busy)?;
    let change_ref = accepted.as_value()["outcome"]["handle"]["changeRef"].clone();
    if !change_ref.is_string() {
        return Err(LeaseError::Busy);
    }
    let taken = held.discard_lease.clone();
    let lease = match &taken {
        Some(lease) => lease.clone(),
        None => new_lease(scope, budget_ms)?,
    };
    let mut take = |lease: &RecordingWireLeaseRequest| {
        register(
            root,
            session,
            held,
            preflight,
            scope,
            &change_ref,
            lease,
            admission_id,
        )
    };
    let ticket = match take(&lease) {
        // The principal's lease expired unregistered: the registry replaces
        // it under new IDs in the same reserved slot.
        Err(LeaseError::Expired) if taken.is_some() => take(&new_lease(scope, budget_ms)?)?,
        other => other?,
    };
    let reply = root.dispatch_discard(session, &ticket)?;
    Ok(reply.as_value()["outcome"]["kind"]
        .as_str()
        .unwrap_or_default()
        .to_owned())
}

/// Issue (or re-fetch) the discard lease `lease` and register the discard
/// under it. A discard the principal already registered under the same
/// lease is the same request, so it is returned as it is.
#[allow(clippy::too_many_arguments)]
fn register(
    root: &mut RecordingRegistryRoot,
    session: &RecordingRegistrySession,
    held: &mut HeldWorkflow,
    preflight: &RecordingRegistryAdmissionTicket,
    scope: &Value,
    change_ref: &Value,
    lease: &RecordingWireLeaseRequest,
    admission_id: &mut Option<String>,
) -> Result<scada_runtime::recording_registry::RecordingRegistryDiscardTicket, LeaseError> {
    let reply = root.issue_discard_lease(session, &held.ticket, preflight, lease.clone())?;
    let ids = lease.as_value();
    if let Some(id) = ids["leaseRequestId"].as_str() {
        if held.discard_lease_ids.insert(id.to_owned()) {
            held.discard_lease = Some(lease.clone());
        }
    }
    *admission_id = ids["admissionId"].as_str().map(str::to_owned);
    let request = RecordingAdmissionRequest::from_value(json!({
        "version": 1, "kind": "recordingAdmissionRequest",
        "ownerRef": scope["ownerRef"], "admissionId": ids["admissionId"],
        "context": scope["context"],
        "deadlineLeaseRef": reply.as_value()["outcome"]["deadlineLeaseRef"],
        "action": {"kind": "discard", "changeRef": change_ref, "change": held.change.as_value()},
    }))
    .map_err(|_| LeaseError::InvalidInput)?;
    match root.register_discard(session, &held.ticket, preflight, request)? {
        DiscardRegistration::Registered(ticket) | DiscardRegistration::Existing(ticket) => {
            Ok(ticket)
        }
    }
}

/// A discard lease under new IDs of the host.
fn new_lease(scope: &Value, budget_ms: u64) -> Result<RecordingWireLeaseRequest, LeaseError> {
    let id = uuid::Uuid::new_v4().simple();
    RecordingWireLeaseRequest::from_value(json!({
        "version": 1, "kind": "recordingWireLeaseRequest", "scope": scope,
        "leaseRequestId": format!("shutdown-discard-lease:{id}"),
        "admissionId": format!("shutdown-discard:{id}"),
        "role": "mutation", "requestedBudgetMs": budget_ms,
    }))
    .map_err(|_| LeaseError::InvalidInput)
}
