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
//! The workflow ticket and each stage's registration ticket are held here for
//! the root's lifetime, bound to the principal that reserved the workflow
//! (§5). Mutation registrations, reservations and cancels are audited.
//!
//! Subscriptions are bound to the generation that attached them. Each frame
//! delivery re-validates the desktop session first: a new generation ends the
//! subscription (its frames never reach the new session), and an auth DB read
//! failure leaves the frame in the registry's latest-one slot until the next
//! delivery (§5).
//!
//! Auth changes that could strand a workflow (the move to operation, demoting
//! or deleting an Admin, lowering the auth-disabled role) are decided under
//! the transition lock against [`RecordingRegistryRoot::quiescence`] and
//! revoke the sessions they end before returning (§4, §6).
//!
//! Registry sessions, workflow tickets and principals never leave this type.
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard};

use banto_admin_services::settings::AuthSettings;
use banto_admin_services::users::UserSummary;
use banto_core::BantoError;
use scada_model::recording_admission::{
    RecordingAdmissionInspectionReply, RecordingAdmissionInspectionRequest,
    RecordingAdmissionReply, RecordingAdmissionRequest,
};
use scada_model::recording_operations::RecordingChangeRequest;
use scada_model::recording_wire::{
    RecordingWireAttachReply, RecordingWireAttachRequest, RecordingWireCallInspectionReply,
    RecordingWireCallInspectionRequest, RecordingWireCancelReply, RecordingWireCancelRequest,
    RecordingWireControlFrame, RecordingWireControlReply, RecordingWireControlRequest,
    RecordingWireLeaseReply, RecordingWireLeaseRequest, RecordingWireObservationReply,
    RecordingWireObservationRequest, RecordingWireStateFrame,
};
use scada_runtime::recording_registry::{
    ApplyRegistration, DiscardRegistration, LeaseError, LeaseRole, PauseRegistration,
    PreflightRegistration, ReconciliationRegistration, RecordingPrincipal,
    RecordingRegistryAdmissionTicket, RecordingRegistryApplyTicket, RecordingRegistryPauseTicket,
    RecordingRegistryRoot, RecordingRegistrySession, RecordingRegistryWorkflowTicket,
    RecordingSessionIssuer,
};
use serde_json::{json, Value};

use crate::auth::{
    CurrentSession, DesktopSession, LoginOutcome, Resolved, Role, UserIdentity, Verified,
};
use crate::auth_phase::{AuthHost, AuthPhase, PhaseGuard, TransitionError, Transitioned};

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

/// Why an auth-changing command refused or failed.
#[derive(Debug)]
pub enum AuthChangeError {
    /// No desktop session.
    Unauthorized,
    /// The session is not an Admin.
    Forbidden,
    /// The change is not offered here: auth-disabled mode is switched off
    /// only by the move to operation and never back on (design §6).
    NotAllowed,
    /// The registry holds unsettled work of the principal the change would
    /// end; nothing was changed. Discard or wait for completion (design §4).
    Busy,
    /// The auth DB failed, or Banto refused the change (validation, the
    /// last Admin, self-deletion, an unknown user).
    Auth(BantoError),
}

impl From<BantoError> for AuthChangeError {
    fn from(error: BantoError) -> Self {
        match error {
            BantoError::Unauthorized => Self::Unauthorized,
            BantoError::Forbidden => Self::Forbidden,
            other => Self::Auth(other),
        }
    }
}

/// The frames of one subscription taken at one delivery: at most the latest
/// state and the control slot (design §5).
#[derive(Debug, Clone, PartialEq)]
pub struct SubscriptionFrames {
    pub state: Option<RecordingWireStateFrame>,
    pub control: Option<RecordingWireControlFrame>,
}

/// The reply of `recording_workflow_reserve`: the reserved change only. The
/// workflow ticket stays in the gate (design §5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowReservation {
    pub change_id: String,
}

/// The stage `recording_workflow_lease` issues a lease for (design §5).
/// Pause/join and apply name the caller's operation ID of the native
/// operation their admission carries (`action.operation.operationId`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkflowStage {
    Preflight,
    PauseJoin { operation_id: String },
    Apply { operation_id: String },
    Discard,
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

/// The root's one workflow: its ticket and the registration tickets the
/// later stages build on, bound to the principal that reserved it. A discard
/// or a reconcile starts no later stage, and re-registering the same request
/// returns its ticket, so their tickets are not kept.
struct HeldWorkflow {
    principal: RecordingPrincipal,
    ticket: RecordingRegistryWorkflowTicket,
    preflight: Option<RecordingRegistryAdmissionTicket>,
    pause: Option<RecordingRegistryPauseTicket>,
    apply: Option<RecordingRegistryApplyTicket>,
}

/// The tickets of the held workflow, for `principal` only.
fn workflow_of<'w>(
    workflow: &'w mut Option<HeldWorkflow>,
    principal: &RecordingPrincipal,
) -> Result<&'w mut HeldWorkflow, LeaseError> {
    // No workflow is the registry's own answer for a missing reservation.
    let held = workflow.as_mut().ok_or(LeaseError::InvalidInput)?;
    if held.principal != *principal {
        return Err(LeaseError::Forbidden);
    }
    Ok(held)
}

/// A ticket of an earlier stage that was never registered through the gate.
fn earlier<T: Clone>(ticket: &Option<T>) -> Result<T, LeaseError> {
    ticket.clone().ok_or(LeaseError::InvalidInput)
}

/// A subscription attached through the gate, bound to the generation that
/// attached it. An ended one stays recorded, so a replayed attach never binds
/// it to a later generation.
struct SubscriptionBinding {
    seq: u64,
    ended: bool,
}

/// What one registry call sees: the root, the held session, its principal and
/// generation, the held workflow and the subscription bindings.
struct Registry<'a> {
    root: &'a mut RecordingRegistryRoot,
    session: &'a RecordingRegistrySession,
    principal: &'a RecordingPrincipal,
    seq: u64,
    workflow: &'a mut Option<HeldWorkflow>,
    subscriptions: &'a mut BTreeMap<String, SubscriptionBinding>,
}

/// An admission call: whether it registered a new admission (audited once),
/// and the dispatch reply. A replay of the same request registers nothing.
struct Admitted {
    registered: bool,
    reply: Result<RecordingAdmissionReply, LeaseError>,
}

/// Register an admission with the held tickets and dispatch it once. Both run
/// under the gate's lock without an await, so a dropped command future never
/// splits registration from dispatch (design §5).
fn admit(r: Registry<'_>, request: RecordingAdmissionRequest) -> Result<Admitted, LeaseError> {
    let Registry {
        root,
        session,
        principal,
        workflow,
        ..
    } = r;
    let held = workflow_of(workflow, principal)?;
    let kind = request.as_value()["action"]["kind"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    match kind.as_str() {
        "preflight" => {
            let (ticket, registered) =
                match root.register_preflight(session, &held.ticket, request)? {
                    PreflightRegistration::Registered(ticket) => (ticket, true),
                    PreflightRegistration::Existing(ticket) => (ticket, false),
                };
            held.preflight = Some(ticket.clone());
            let reply = root.dispatch_preflight(session, &ticket);
            Ok(Admitted { registered, reply })
        }
        "pauseJoin" => {
            let preflight = earlier(&held.preflight)?;
            let (ticket, registered) =
                match root.register_pause_join(session, &held.ticket, &preflight, request)? {
                    PauseRegistration::Registered(ticket) => (ticket, true),
                    PauseRegistration::Existing(ticket) => (ticket, false),
                };
            held.pause = Some(ticket.clone());
            let reply = root.dispatch_pause_join(session, &ticket);
            Ok(Admitted { registered, reply })
        }
        "apply" => {
            let pause = earlier(&held.pause)?;
            let (ticket, registered) =
                match root.register_apply(session, &held.ticket, &pause, request)? {
                    ApplyRegistration::Registered(ticket) => (ticket, true),
                    ApplyRegistration::Existing(ticket) => (ticket, false),
                };
            held.apply = Some(ticket.clone());
            let reply = root.dispatch_apply(session, &ticket);
            Ok(Admitted { registered, reply })
        }
        "discard" => {
            let preflight = earlier(&held.preflight)?;
            let (ticket, registered) =
                match root.register_discard(session, &held.ticket, &preflight, request)? {
                    DiscardRegistration::Registered(ticket) => (ticket, true),
                    DiscardRegistration::Existing(ticket) => (ticket, false),
                };
            let reply = root.dispatch_discard(session, &ticket);
            Ok(Admitted { registered, reply })
        }
        "reconcile" => {
            let apply = earlier(&held.apply)?;
            let (ticket, registered) =
                match root.register_reconciliation(session, &held.ticket, &apply, request)? {
                    ReconciliationRegistration::Registered(ticket) => (ticket, true),
                    ReconciliationRegistration::Existing(ticket) => (ticket, false),
                };
            let reply = root.dispatch_reconciliation(session, &ticket);
            Ok(Admitted { registered, reply })
        }
        _ => Err(LeaseError::InvalidInput),
    }
}

/// The audit `result` of a registry answer.
fn audit_result(result: &Result<(), &LeaseError>) -> &'static str {
    match result {
        Ok(()) => "ok",
        Err(LeaseError::Forbidden | LeaseError::Unauthorized) => "denied",
        Err(_) => "failed",
    }
}

struct GateState {
    root: RecordingRegistryRoot,
    issuer: RecordingSessionIssuer,
    held: Option<HeldSessions>,
    workflow: Option<HeldWorkflow>,
    subscriptions: BTreeMap<String, SubscriptionBinding>,
}

impl GateState {
    /// Revoke the held sessions, and end the subscriptions, of generations
    /// not newer than `through` other than the still-valid generation `keep`.
    /// A check only knows the generations up to the one it read: sessions
    /// issued for a later one (a login racing the check) are left for the
    /// next check.
    fn revoke_through(&mut self, through: u64, keep: Option<u64>) {
        let stale = |seq: u64| seq <= through && Some(seq) != keep;
        if self.held.as_ref().is_some_and(|held| stale(held.seq)) {
            self.revoke_held_sessions();
        }
        for (reference, binding) in &mut self.subscriptions {
            if !binding.ended && stale(binding.seq) {
                binding.ended = true;
                self.root.end_subscription(reference);
            }
        }
    }

    /// Revoke the held registry sessions of every generation, leaving the
    /// subscription bindings as they are.
    fn revoke_held_sessions(&mut self) {
        if let Some(held) = self.held.take() {
            for session in [held.read, held.mutation].into_iter().flatten() {
                // Only this root's sessions are held, so this cannot fail.
                let _ = self.root.revoke_session(&session);
            }
        }
    }

    /// Whether changing `principal` now could strand unsettled work (§4).
    fn holds(&self, principal: &RecordingPrincipal) -> bool {
        self.root.quiescence().holds(principal)
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
        // `current` was validated before this lock was taken. Sessions of an
        // older generation are stale; a newer one means `current` itself is
        // stale, and it must neither use nor end the newer generation.
        if self
            .held
            .as_ref()
            .is_some_and(|held| held.seq > current.seq)
        {
            return Err(LeaseError::Unauthorized);
        }
        // Older generations end here whether or not their sessions are still
        // held: a refresh that failed after an auth change revokes the held
        // sessions but leaves the subscriptions to this settlement.
        self.revoke_through(current.seq, Some(current.seq));
        let Self {
            root, issuer, held, ..
        } = self;
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

impl<'a, T> Entered<'a, T> {
    fn map<U>(
        self,
        f: impl FnOnce(Result<T, LeaseError>) -> Result<U, LeaseError>,
    ) -> Entered<'a, U> {
        Entered {
            _phase: self._phase,
            current: self.current,
            result: f(self.result),
        }
    }
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
                workflow: None,
                subscriptions: BTreeMap::new(),
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

    /// After an auth change was saved: [`Self::refresh`], and if the auth DB
    /// cannot be read, revoke every held registry session anyway, since the
    /// change may have ended them. That costs only a re-issue for the same
    /// principal at its next command. Subscriptions are not ended here: a
    /// change that ended nothing must not cut them for good, and each
    /// delivery re-validates before it sends a frame.
    async fn refresh_after_change(&self) {
        if self.refresh().await.is_err() {
            self.lock().revoke_held_sessions();
        }
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
            .enter(need, "recording_lease", |r| {
                r.root.issue_lease(r.session, request)
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
            .enter(Need::Read, "recording_observation", |r| {
                r.root.observe_result(r.session, request)
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
            .enter(Need::Read, "recording_call_inspection", |r| {
                r.root.inspect_call(r.session, request)
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
        let cancel_id = request.as_value()["cancelId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let detail = json!({"target": request.as_value()["target"]["kind"]});
        let entered = self
            .enter(need, "recording_cancel", |r| {
                r.root.request_cancel(r.session, request)
            })
            .await?;
        self.audit(
            &entered.current,
            "cancel",
            "recording_cancel",
            &cancel_id,
            detail,
            entered.result.as_ref().map(|_| ()),
        )
        .await;
        self.bind(entered).await
    }

    /// `recording_workflow_reserve` (mutation): reserve the root's workflow
    /// for the full change request, before any mutation lease. The same
    /// request again returns the same reservation (design §5).
    pub async fn workflow_reserve(
        &self,
        change: RecordingChangeRequest,
    ) -> Result<Bound<WorkflowReservation>, GateError> {
        let change_id = change.as_value()["changeId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let entered = self
            .enter(Need::Mutation, "recording_workflow_reserve", |r| {
                let ticket = r.root.reserve_workflow(r.session, change)?;
                // The gate holds every ticket of this root, so an existing
                // reservation is the held one.
                let reserved = r.workflow.is_none();
                if reserved {
                    *r.workflow = Some(HeldWorkflow {
                        principal: r.principal.clone(),
                        ticket: ticket.clone(),
                        preflight: None,
                        pause: None,
                        apply: None,
                    });
                }
                Ok((
                    WorkflowReservation {
                        change_id: ticket.change_id().to_owned(),
                    },
                    reserved,
                ))
            })
            .await?;
        if !matches!(entered.result, Ok((_, false))) {
            self.audit(
                &entered.current,
                "reserve",
                "recording_workflow",
                &change_id,
                Value::Null,
                entered.result.as_ref().map(|_| ()),
            )
            .await;
        }
        self.bind(entered.map(|result| result.map(|(reply, _)| reply)))
            .await
    }

    /// `recording_workflow_lease` (mutation): the prepaid lease of one stage,
    /// issued with the held workflow ticket and the earlier stage's ticket.
    pub async fn workflow_lease(
        &self,
        stage: WorkflowStage,
        request: RecordingWireLeaseRequest,
    ) -> Result<Bound<RecordingWireLeaseReply>, GateError> {
        let entered = self
            .enter(Need::Mutation, "recording_workflow_lease", |r| {
                let held = workflow_of(r.workflow, r.principal)?;
                let (root, session, workflow) = (r.root, r.session, &held.ticket);
                match &stage {
                    WorkflowStage::Preflight => {
                        root.issue_preflight_lease(session, workflow, request)
                    }
                    WorkflowStage::PauseJoin { operation_id } => root.issue_pause_join_lease(
                        session,
                        workflow,
                        &earlier(&held.preflight)?,
                        operation_id,
                        request,
                    ),
                    WorkflowStage::Apply { operation_id } => root.issue_apply_lease(
                        session,
                        workflow,
                        &earlier(&held.pause)?,
                        operation_id,
                        request,
                    ),
                    WorkflowStage::Discard => root.issue_discard_lease(
                        session,
                        workflow,
                        &earlier(&held.preflight)?,
                        request,
                    ),
                }
            })
            .await?;
        self.bind(entered).await
    }

    /// `recording_admission`: preflight, pause/join, apply and discard need
    /// mutation (Admin), a reconcile of the original apply needs read. The
    /// stage comes from the request's action, and the held tickets are used.
    pub async fn admission(
        &self,
        request: RecordingAdmissionRequest,
    ) -> Result<Bound<RecordingAdmissionReply>, GateError> {
        let action = request.as_value()["action"]["kind"].clone();
        let need = if action == "reconcile" {
            Need::Read
        } else {
            Need::Mutation
        };
        let admission_id = request.as_value()["admissionId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        let entered = self
            .enter(need, "recording_admission", |r| admit(r, request))
            .await?;
        // Mutation registrations are audited once; a replay registers nothing.
        if need == Need::Mutation
            && !matches!(
                entered.result,
                Ok(Admitted {
                    registered: false,
                    ..
                })
            )
        {
            self.audit(
                &entered.current,
                "register",
                "recording_admission",
                &admission_id,
                json!({"stage": action}),
                entered.result.as_ref().map(|_| ()),
            )
            .await;
        }
        self.bind(entered.map(|result| result.and_then(|admitted| admitted.reply)))
            .await
    }

    /// `recording_admission_inspection` (read): an inspection of the held
    /// workflow's preflight admission, for its principal only.
    pub async fn admission_inspection(
        &self,
        request: RecordingAdmissionInspectionRequest,
    ) -> Result<Bound<RecordingAdmissionInspectionReply>, GateError> {
        let entered = self
            .enter(Need::Read, "recording_admission_inspection", |r| {
                let held = workflow_of(r.workflow, r.principal)?;
                r.root
                    .inspect_preflight_admission(r.session, &held.ticket, request)
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
            .enter(Need::Read, "recording_attach", |r| {
                let reply = r.root.attach(r.session, request)?;
                if let Some(reference) = reply.as_value()["outcome"]["subscriptionRef"].as_str() {
                    // A replay keeps the generation of the first attach.
                    r.subscriptions
                        .entry(reference.to_owned())
                        .or_insert(SubscriptionBinding {
                            seq: r.seq,
                            ended: false,
                        });
                }
                Ok(reply)
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
            .enter(Need::Read, "recording_control", |r| {
                r.root.control(r.session, request)
            })
            .await?;
        self.bind(entered).await
    }

    /// Deliver the frames of the subscription `reference` (design §5). Each
    /// delivery first re-validates the desktop session, so a revocation is
    /// found without waiting for the next command:
    ///
    /// - an auth DB read failure is [`GateError::AuthUnavailable`]; nothing
    ///   is taken, and the frame stays in the registry's latest-one slot for
    ///   the next delivery;
    /// - a subscription of another generation (logout, another user, a role
    ///   change, a re-login) is ended and refused as `Unauthorized`; its
    ///   frames are never sent to the new session;
    /// - a phase that refuses the registry takes nothing.
    ///
    /// A generation change racing the take withholds the taken frames.
    pub async fn frames(&self, reference: &str) -> Result<Bound<SubscriptionFrames>, GateError> {
        let phase = self.auth.gate().await;
        if !phase.phase().admits_registry() {
            return Err(GateError::Phase(phase.phase()));
        }
        let seen = self.auth.auth().seq();
        let current = self
            .auth
            .auth()
            .current()
            .await
            .map_err(GateError::AuthUnavailable)?;
        #[cfg(test)]
        self.run_hook().await;
        let mut state = self.lock();
        state.settle(seen, current.as_ref());
        let binding = state
            .subscriptions
            .get(reference)
            .ok_or(GateError::Registry(LeaseError::InvalidInput))?;
        let current = match current {
            Some(current) if !binding.ended && binding.seq == current.seq => current,
            _ => return Err(GateError::Unauthorized),
        };
        // The check above ran before the lock: a re-bind since then ends
        // this generation (`seq` advances only when authorization changes),
        // so it is ended now rather than left to a delivery that may never
        // come. Its frames are not taken.
        if self.auth.auth().seq() != current.seq {
            state.revoke_through(current.seq, None);
            return Err(GateError::Unauthorized);
        }
        let session = state
            .session_for(&current, LeaseRole::Reconciliation)
            .map_err(GateError::Registry)?;
        let frames = (|| {
            Ok(SubscriptionFrames {
                state: state.root.take_state_frame(&session, reference)?,
                control: state.root.take_control_frame(&session, reference)?,
            })
        })()
        .map_err(GateError::Registry)?;
        if self.auth.auth().seq() != current.seq {
            state.revoke_through(current.seq, None);
            return Err(GateError::Unauthorized);
        }
        Ok(Bound {
            seq: current.seq,
            reply: frames,
        })
    }

    /// `auth_login`: verify the credentials, then install the account under
    /// the transition lock and, in the same call, end the registry sessions
    /// and subscriptions of the generations before it (a user switch, §5).
    /// The password is checked outside the lock, so a slow check does not
    /// hold the registry; a command that validated the previous user
    /// finishes before the switch, as for [`Self::logout`].
    pub async fn login(&self, username: &str, password: &str) -> Result<LoginOutcome, BantoError> {
        let (identity, seq_at_entry) =
            match self.auth.auth().verify_login(username, password).await? {
                Verified::Account {
                    identity,
                    seq_at_entry,
                } => (identity, seq_at_entry),
                Verified::Refused(outcome) => return Ok(outcome),
            };
        self.install_account(seq_at_entry, identity).await
    }

    /// Install an account verified or created outside the lock (a login or
    /// the first-account setup) as [`Self::login`] does.
    pub(crate) async fn install_account(
        &self,
        seq_at_entry: u64,
        identity: UserIdentity,
    ) -> Result<LoginOutcome, BantoError> {
        let phase = self.auth.gate().await;
        let outcome = self.auth.auth().install_login(seq_at_entry, identity).await;
        // Whatever the outcome (a superseded install, or a re-validation
        // that failed after writing the slot), every generation before the
        // slot's has ended; no second auth DB read is needed.
        self.end_generations_before(self.auth.auth().seq());
        drop(phase);
        outcome
    }

    /// `auth_change_password`: the own password change, then [`Self::refresh`]
    /// so the registry sessions of the generation it re-bound away from end
    /// in the same call (§5). The principal does not change, so the next
    /// command re-issues for the same user.
    pub async fn change_own_password(
        &self,
        current_password: &str,
        new_password: &str,
    ) -> Result<u64, BantoError> {
        // Under the transition lock, like a logout: a registry command that
        // validated the old generation finishes before it ends.
        let phase = self.auth.gate().await;
        let result = self
            .auth
            .auth()
            .change_own_password(current_password, new_password)
            .await;
        let changed = !matches!(
            result,
            Err(BantoError::Forbidden | BantoError::Validation { .. })
        );
        // Whatever the result: the re-bind, or the initial check (which can
        // clear a revoked session or follow a role change even when the
        // password is then refused), has ended every generation before the
        // slot's, whatever the refresh below can read.
        self.end_generations_before(self.auth.auth().seq());
        drop(phase);
        if changed {
            self.refresh_after_change().await;
        }
        result
    }

    /// `auth_resolve`: [`HostAuth::resolve`] under the transition lock, then
    /// the end of every generation before the `current` it reports. A
    /// session it clears or re-binds ends its registry sessions and
    /// subscriptions in the same call, after any registry command that
    /// validated it has finished, without a second auth DB read.
    pub async fn resolve(&self) -> Result<Resolved, BantoError> {
        let _phase = self.auth.gate().await;
        let resolved = self.auth.auth().resolve().await?;
        self.end_generations_before(resolved.current);
        Ok(resolved)
    }

    /// End the subscription `reference` attached through the gate, as a
    /// revocation does: its live slot and descriptor are freed, and later
    /// deliveries are `Unauthorized`. For a desktop page that is gone (its
    /// webview reloaded or closed): nothing is disclosed and native work is
    /// untouched. Unknown or already ended references are a no-op.
    pub(crate) fn end_subscription(&self, reference: &str) {
        let state = &mut *self.lock();
        if let Some(binding) = state.subscriptions.get_mut(reference) {
            if !binding.ended {
                binding.ended = true;
                state.root.end_subscription(reference);
            }
        }
    }

    /// End the registry sessions and subscriptions of every generation
    /// before `seq`, a generation the slot has reached. The slot holds one
    /// session and `seq` only grows, so those generations are over; this
    /// needs no re-validation, and a newer generation is kept.
    pub(crate) fn end_generations_before(&self, seq: u64) {
        if let Some(through) = seq.checked_sub(1) {
            self.lock().revoke_through(through, None);
        }
    }

    /// `auth_logout`: end the account session and, in the same call, the
    /// registry sessions and subscriptions of the generations before it.
    /// Returns the slot generation after the logout.
    ///
    /// Taken under the transition lock, like every registry entry: a command
    /// that validated the session before the logout finishes first, so none
    /// runs its registry call with a session the logout has already ended.
    pub async fn logout(&self) -> u64 {
        let _phase = self.auth.gate().await;
        let seq = self.auth.auth().logout().await;
        // Every generation before the one the logout set has ended. A no-op
        // logout (auth-disabled mode) keeps `seq` and revokes nothing current;
        // at generation 0 there is no earlier one to revoke.
        if let Some(before) = seq.checked_sub(1) {
            self.lock().revoke_through(before, None);
        }
        seq
    }

    /// `auth_transition_to_operational` (design §6): the move to operation,
    /// with the registry's quiescence asked under the transition lock. The
    /// synthetic session's registry sessions and subscriptions are revoked
    /// before returning (step 5), whatever the outcome: a failure after
    /// auth-disabled mode was turned off has ended that session too.
    pub async fn transition_to_operational(
        &self,
        username: &str,
        password: &str,
        display_name: &str,
    ) -> Result<Transitioned, TransitionError> {
        let result = self
            .auth
            .transition_to_operational(username, password, display_name, || {
                self.lock().root.quiescence().is_quiescent()
            })
            .await;
        // The administrator's session took the single slot: every earlier
        // generation (the synthetic one included) has ended, whatever a
        // re-validation can read now.
        if let Ok(Transitioned {
            session: Some(admin),
        }) = &result
        {
            self.lock().revoke_through(admin.seq - 1, None);
        }
        // Test only: the auth DB failing before the refresh below.
        #[cfg(test)]
        self.run_hook().await;
        self.refresh_after_change().await;
        result
    }

    /// `users_update` (Admin): change an account's display name and role.
    /// Demoting an Admin is refused as `Busy` while the registry holds
    /// unsettled work of that user's principal (design §4); once applied,
    /// the sessions it ends are revoked before returning.
    pub async fn update_user(
        &self,
        id: i64,
        display_name: &str,
        role: Role,
    ) -> Result<UserSummary, AuthChangeError> {
        let _phase = self.auth.gate().await;
        let actor = self.auth.auth().require_role(Role::Admin, "users").await?;
        let users = self.auth.auth().users();
        let target = users
            .list_users()
            .await?
            .into_iter()
            .find(|user| user.id == id);
        let demotes = target.is_some_and(|user| user.role == Role::Admin && role != Role::Admin);
        if demotes && self.lock().holds(&RecordingPrincipal::banto_user(id)) {
            return Err(AuthChangeError::Busy);
        }
        let updated = users.update_user(id, display_name, role).await?;
        self.auth
            .auth()
            .record_ok(
                actor.session.identity(),
                "update",
                "users",
                Some(&id.to_string()),
                Some(json!({"role": role.as_str()})),
            )
            .await;
        self.refresh_after_change().await;
        Ok(updated)
    }

    /// `users_delete` (Admin): delete an account. Refused as `Busy` while
    /// the registry holds unsettled work of that user's principal (design
    /// §4); once applied, the sessions it ends are revoked before returning.
    pub async fn delete_user(&self, id: i64) -> Result<(), AuthChangeError> {
        let _phase = self.auth.gate().await;
        let actor = self.auth.auth().require_role(Role::Admin, "users").await?;
        if self.lock().holds(&RecordingPrincipal::banto_user(id)) {
            return Err(AuthChangeError::Busy);
        }
        // The synthetic session has no row of its own (Banto's `None`).
        let acting = match &actor.session {
            DesktopSession::Account(identity) => Some(identity.id),
            DesktopSession::AuthDisabledLocal(_) => None,
        };
        self.auth.auth().users().delete_user(id, acting).await?;
        self.auth
            .auth()
            .record_ok(
                actor.session.identity(),
                "delete",
                "users",
                Some(&id.to_string()),
                None,
            )
            .await;
        self.refresh_after_change().await;
        Ok(())
    }

    /// `auth_config_set` (Admin): save the auth-mode settings. The mode
    /// itself is not switched here (`NotAllowed`): it goes off only through
    /// the move to operation and never back on (design §6). Lowering the
    /// auth-disabled role below Admin is refused as `Busy` while the registry
    /// holds unsettled work of the synthetic principal (design §4).
    pub async fn set_auth_config(&self, config: &AuthSettings) -> Result<(), AuthChangeError> {
        let _phase = self.auth.gate().await;
        let actor = self
            .auth
            .auth()
            .require_role(Role::Admin, "settings")
            .await?;
        let saved = self.auth.auth().settings().auth_config().await?;
        if config.disabled != saved.disabled {
            return Err(AuthChangeError::NotAllowed);
        }
        let demotes = saved.disabled
            && saved.disabled_role == Role::Admin
            && config.disabled_role != Role::Admin;
        if demotes
            && self
                .lock()
                .holds(&RecordingPrincipal::auth_disabled_local())
        {
            return Err(AuthChangeError::Busy);
        }
        self.auth.auth().settings().set_auth_config(config).await?;
        self.auth
            .auth()
            .record_ok(
                actor.session.identity(),
                "update",
                "auth_config",
                None,
                Some(json!({"disabledRole": config.disabled_role.as_str()})),
            )
            .await;
        // Settle the slot to the saved mode and revoke what it ended now.
        self.refresh_after_change().await;
        Ok(())
    }

    /// Steps 1-3: the phase, the session and role, then the registry call
    /// with the held session of the current generation.
    async fn enter<T>(
        &self,
        need: Need,
        resource: &str,
        call: impl FnOnce(Registry<'_>) -> Result<T, LeaseError>,
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
            let principal = current.session.principal();
            state
                .session_for(&current, need.lease_role())
                .and_then(|session| {
                    let GateState {
                        root,
                        workflow,
                        subscriptions,
                        ..
                    } = &mut *state;
                    call(Registry {
                        root,
                        session: &session,
                        principal: &principal,
                        seq: current.seq,
                        workflow,
                        subscriptions,
                    })
                })
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

    /// Audit a mutation registration or a cancel (best effort: a failed
    /// write never fails the command, design §5). The write runs in its own
    /// task, started before the first await after the registry call: if the
    /// command's future is dropped, the operation stays registered and its
    /// replay registers nothing, so only this task can still record it.
    async fn audit(
        &self,
        current: &CurrentSession,
        action: &'static str,
        resource: &'static str,
        entity_id: &str,
        detail: Value,
        result: Result<(), &LeaseError>,
    ) {
        let mut detail = detail;
        if let Err(error) = result {
            let entry = json!(format!("{error:?}"));
            match &mut detail {
                Value::Object(map) => {
                    map.insert("error".into(), entry);
                }
                _ => detail = json!({ "error": entry }),
            }
        }
        let detail = (!detail.is_null()).then_some(detail);
        let outcome = audit_result(&result);
        let auth = self.auth.clone();
        let actor = current.session.identity().clone();
        let entity_id = entity_id.to_owned();
        let task = tokio::spawn(async move {
            auth.auth()
                .record(&actor, action, resource, Some(&entity_id), detail, outcome)
                .await;
        });
        // Test only: a command dropped while its audit is being written.
        #[cfg(test)]
        self.run_hook().await;
        // A panic in the write is the audit's own failure, never the command's.
        let _ = task.await;
    }

    fn lock(&self) -> MutexGuard<'_, GateState> {
        self.state.lock().expect("recording gate mutex poisoned")
    }

    /// Test only: run `hook` after the next registry call, before its
    /// generation check (a logout or user switch racing the command; for an
    /// audited command, while its audit is being written), or
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

    /// Test support (feature `test-support`): make the root's next native
    /// apply commit and then lose its response, the case a reconcile of the
    /// original apply reads. For the desktop host's command tests, which
    /// cannot reach the root.
    #[cfg(any(test, feature = "test-support"))]
    pub fn test_lose_next_apply_response(&self) {
        scada_runtime::recording_host::test_support::lose_next_apply_response(&self.lock().root);
    }

    /// Test only: direct access to the root.
    #[cfg(test)]
    fn with_root<T>(&self, f: impl FnOnce(&mut RecordingRegistryRoot) -> T) -> T {
        f(&mut self.lock().root)
    }
}

#[cfg(test)]
mod tests;
