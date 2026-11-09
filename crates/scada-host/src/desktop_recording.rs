//! The desktop webview's recording registry commands and subscription events
//! (host-gate design §5; implementation order §9 step 4-3-2).
//! Tauri-independent: each command of `apps/banto-scada/src-tauri` calls one
//! method here and returns its result unchanged, and the frame pump only
//! needs an `emit` callback, so the behavior is tested with plain
//! `cargo test`.
//!
//! - **Arguments**: the wire request JSON alone. No principal, role or
//!   session ID is taken; the gate re-validates the desktop session and
//!   chooses the role from the command and the request (§5 table).
//!   `recording_workflow_lease` also takes the stage and, for pause/join and
//!   apply, the operation ID the stage's admission carries.
//! - **Results**: `{"seq": <generation>, "reply": <wire reply>}`. The UI
//!   drops a reply of a generation other than its current one.
//! - **Errors**: `{"kind": ...}` ([`RecordingCommandError`]).
//! - **Subscriptions**: a subscription of `recording_attach` gets one
//!   [`FramePump`] for the page that attached it. It polls the gate (the registry folds native evidence
//!   into its latest-one slots only when asked) and re-validates the desktop
//!   session at every delivery, so a revocation is found without waiting for
//!   the next command. An auth DB read failure holds the frame in the
//!   registry's slot until the next delivery; any other refusal ends the
//!   subscription with a [`RecordingEvent::Ended`]. When the page ends
//!   ([`DesktopRecording::end_page`], or the pump's `stop`), its
//!   subscriptions are ended in the registry too, freeing their live slots.
//! - **Without a recording owner** (the product host until C5), every
//!   command answers `{"kind": "recordingUnavailable", "reason": ...}`.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use scada_model::recording_admission::{
    RecordingAdmissionInspectionRequest, RecordingAdmissionRequest,
};
use scada_model::recording_operations::RecordingChangeRequest;
use scada_model::recording_wire::{
    RecordingWireAttachRequest, RecordingWireCallInspectionRequest, RecordingWireCancelRequest,
    RecordingWireControlRequest, RecordingWireLeaseRequest, RecordingWireObservationRequest,
};
use scada_runtime::recording_registry::LeaseError;
use serde::{Serialize, Serializer};
use serde_json::{json, Value};

use crate::recording_gate::{Bound, GateError, RecordingGate, WorkflowStage};

/// The Tauri event the frame pumps emit.
pub const RECORDING_EVENT: &str = "scada:recording";

/// How often a pump asks the gate for frames. Each delivery re-validates the
/// desktop session against the auth DB.
pub const FRAME_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// The reason of [`RecordingCommandError::Unavailable`] on a host with no
/// recording owner (until C5).
pub const NO_RECORDING_OWNER: &str = "no_recording_owner";

/// An error of a recording command, serialized as `{"kind": ...}`.
#[derive(Debug)]
pub enum RecordingCommandError {
    /// No recording registry on this host:
    /// `{"kind": "recordingUnavailable", "reason": ...}`.
    Unavailable(&'static str),
    /// The argument is not a valid wire request (or stage):
    /// `{"kind": "invalidRequest"}`.
    InvalidRequest,
    /// The gate's refusal: `phase` (with `"phase"`), `unauthorized`,
    /// `forbidden`, `authUnavailable`, or the registry's own kind
    /// (`invalidInput`, `protocolViolation`, `capacity`, `busy`, `expired`,
    /// `closed`).
    Gate(GateError),
}

impl From<GateError> for RecordingCommandError {
    fn from(error: GateError) -> Self {
        Self::Gate(error)
    }
}

/// The wire kind of a registry refusal.
fn registry_kind(error: &LeaseError) -> &'static str {
    match error {
        LeaseError::InvalidInput => "invalidInput",
        LeaseError::Forbidden => "forbidden",
        LeaseError::ProtocolViolation => "protocolViolation",
        LeaseError::Capacity => "capacity",
        LeaseError::Busy => "busy",
        LeaseError::Expired => "expired",
        LeaseError::Closed => "closed",
        LeaseError::Unauthorized => "unauthorized",
    }
}

/// The wire kind of a gate refusal.
fn gate_kind(error: &GateError) -> &'static str {
    match error {
        GateError::Phase(_) => "phase",
        GateError::Unauthorized => "unauthorized",
        GateError::Forbidden => "forbidden",
        GateError::AuthUnavailable(_) => "authUnavailable",
        GateError::Registry(error) => registry_kind(error),
    }
}

impl Serialize for RecordingCommandError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Unavailable(reason) => {
                json!({"kind": "recordingUnavailable", "reason": reason}).serialize(serializer)
            }
            Self::InvalidRequest => json!({"kind": "invalidRequest"}).serialize(serializer),
            Self::Gate(GateError::Phase(phase)) => {
                json!({"kind": "phase", "phase": phase.as_str()}).serialize(serializer)
            }
            Self::Gate(error) => json!({ "kind": gate_kind(error) }).serialize(serializer),
        }
    }
}

/// A reply and the desktop-session generation it was produced under.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecordingResult {
    pub seq: u64,
    pub reply: Value,
}

impl RecordingResult {
    fn of<T>(bound: Bound<T>, value: impl FnOnce(T) -> Value) -> Self {
        Self {
            seq: bound.seq,
            reply: value(bound.reply),
        }
    }
}

/// One event of a subscription, emitted as [`RECORDING_EVENT`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RecordingEvent {
    /// The frames of one delivery, bound to the generation that attached the
    /// subscription. The UI drops events of another generation.
    Frames {
        subscription_ref: String,
        seq: u64,
        state: Option<Value>,
        control: Option<Value>,
    },
    /// The subscription will deliver nothing more: `unauthorized` (another
    /// generation, its frames never reach the new session), `phase`, or the
    /// registry's kind (`invalidInput` after a detach, `forbidden`, ...).
    Ended {
        subscription_ref: String,
        reason: &'static str,
    },
}

/// The recording commands of one host.
pub struct DesktopRecording {
    host: Result<Host, &'static str>,
}

struct Host {
    gate: Arc<RecordingGate>,
    pumps: Arc<tokio::sync::Mutex<Pumps>>,
    /// The pages open now: begun ([`DesktopRecording::begin_page`]) and
    /// not ended ([`DesktopRecording::end_page`]). Read by a claim, so an
    /// attach of an ended page never takes a live page's subscription and a
    /// subscription of an ended page is ended even if its pump has not
    /// noticed yet, and by each emit, so an ended page receives nothing.
    /// Holds only the open pages (one per webview).
    live_pages: Arc<Mutex<BTreeSet<u64>>>,
    interval: Duration,
}

/// Which pump delivers each subscription. A replayed attach from the same
/// page starts no second pump. One from another open page takes the claim
/// over at once, so it never waits on the old page's pump to notice
/// anything: if the old page ended, the subscription is ended and the new
/// pump says so; if the old page is still open (another webview), delivery
/// moves to the new page. An attach whose own page ended meanwhile takes
/// nothing from an open page; with no open page holding the subscription it
/// ends it. Every delivery checks its claim under this lock, so a pump taken
/// over delivers nothing more.
#[derive(Default)]
struct Pumps {
    next: u64,
    claims: BTreeMap<String, Claim>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Claim {
    page: u64,
    token: u64,
}

fn parse<T, E>(
    value: Value,
    from: impl FnOnce(Value) -> Result<T, E>,
) -> Result<T, RecordingCommandError> {
    from(value).map_err(|_| RecordingCommandError::InvalidRequest)
}

impl DesktopRecording {
    /// The commands over `gate`, the same gate the desktop auth commands use
    /// ([`crate::desktop_auth::DesktopAuth::with_gate`]).
    pub fn new(gate: Arc<RecordingGate>) -> Self {
        Self::with_interval(gate, FRAME_POLL_INTERVAL)
    }

    /// As [`Self::new`], with the pumps polling every `interval`.
    pub fn with_interval(gate: Arc<RecordingGate>, interval: Duration) -> Self {
        Self {
            host: Ok(Host {
                gate,
                pumps: Arc::default(),
                live_pages: Arc::default(),
                interval,
            }),
        }
    }

    /// A host with no recording registry: every command answers
    /// `recordingUnavailable` with `reason`.
    pub fn unavailable(reason: &'static str) -> Self {
        Self { host: Err(reason) }
    }

    fn host(&self) -> Result<&Host, RecordingCommandError> {
        self.host
            .as_ref()
            .map_err(|reason| RecordingCommandError::Unavailable(reason))
    }

    /// The page `page` was opened (a webview's page load). The host gives
    /// each page load its own ID and calls this before the page can attach.
    pub fn begin_page(&self, page: u64) {
        if let Ok(host) = &self.host {
            host.live_pages
                .lock()
                .expect("live pages mutex poisoned")
                .insert(page);
        }
    }

    /// The page `page` ended (its webview loaded another page or was
    /// destroyed). Called synchronously from the host's page hooks, before
    /// the next page can attach, so its subscriptions are ended whichever of
    /// its pump, the next page's replayed attach, or its own attach still in
    /// flight comes first.
    pub fn end_page(&self, page: u64) {
        if let Ok(host) = &self.host {
            host.live_pages
                .lock()
                .expect("live pages mutex poisoned")
                .remove(&page);
        }
    }

    /// Test only: how many pages are open.
    #[cfg(test)]
    fn live_page_count(&self) -> usize {
        self.host
            .as_ref()
            .map_or(0, |host| host.live_pages.lock().unwrap().len())
    }

    fn gate(&self) -> Result<&RecordingGate, RecordingCommandError> {
        Ok(&self.host()?.gate)
    }

    /// `recording_workflow_reserve` (mutation): the full change request. The
    /// reply is the reserved `changeId` only; the ticket stays in the gate.
    pub async fn workflow_reserve(
        &self,
        request: Value,
    ) -> Result<RecordingResult, RecordingCommandError> {
        let gate = self.gate()?;
        let change = parse(request, RecordingChangeRequest::from_value)?;
        let bound = gate.workflow_reserve(change).await?;
        Ok(RecordingResult::of(
            bound,
            |reply| json!({ "changeId": reply.change_id }),
        ))
    }

    /// `recording_workflow_lease` (mutation): `stage` is `preflight`,
    /// `pauseJoin`, `apply` or `discard`. Pause/join and apply need the
    /// `operation_id` of the native operation their admission carries; the
    /// others take none.
    pub async fn workflow_lease(
        &self,
        stage: &str,
        operation_id: Option<String>,
        request: Value,
    ) -> Result<RecordingResult, RecordingCommandError> {
        let gate = self.gate()?;
        let stage = match (stage, operation_id) {
            ("preflight", None) => WorkflowStage::Preflight,
            ("pauseJoin", Some(operation_id)) => WorkflowStage::PauseJoin { operation_id },
            ("apply", Some(operation_id)) => WorkflowStage::Apply { operation_id },
            ("discard", None) => WorkflowStage::Discard,
            _ => return Err(RecordingCommandError::InvalidRequest),
        };
        let request = parse(request, RecordingWireLeaseRequest::from_value)?;
        let bound = gate.workflow_lease(stage, request).await?;
        Ok(RecordingResult::of(bound, |reply| reply.as_value().clone()))
    }

    /// `recording_lease`: a reconciliation lease only (a mutation one is
    /// `forbidden`).
    pub async fn lease(&self, request: Value) -> Result<RecordingResult, RecordingCommandError> {
        let gate = self.gate()?;
        let request = parse(request, RecordingWireLeaseRequest::from_value)?;
        let bound = gate.lease(request).await?;
        Ok(RecordingResult::of(bound, |reply| reply.as_value().clone()))
    }

    /// `recording_admission`: the stage comes from the request's action.
    pub async fn admission(
        &self,
        request: Value,
    ) -> Result<RecordingResult, RecordingCommandError> {
        let gate = self.gate()?;
        let request = parse(request, RecordingAdmissionRequest::from_value)?;
        let bound = gate.admission(request).await?;
        Ok(RecordingResult::of(bound, |reply| reply.as_value().clone()))
    }

    /// `recording_admission_inspection` (read).
    pub async fn admission_inspection(
        &self,
        request: Value,
    ) -> Result<RecordingResult, RecordingCommandError> {
        let gate = self.gate()?;
        let request = parse(request, RecordingAdmissionInspectionRequest::from_value)?;
        let bound = gate.admission_inspection(request).await?;
        Ok(RecordingResult::of(bound, |reply| reply.as_value().clone()))
    }

    /// `recording_observation` (read).
    pub async fn observation(
        &self,
        request: Value,
    ) -> Result<RecordingResult, RecordingCommandError> {
        let gate = self.gate()?;
        let request = parse(request, RecordingWireObservationRequest::from_value)?;
        let bound = gate.observation(request).await?;
        Ok(RecordingResult::of(bound, |reply| reply.as_value().clone()))
    }

    /// `recording_cancel`: an operation needs mutation, a reconciliation
    /// read needs read.
    pub async fn cancel(&self, request: Value) -> Result<RecordingResult, RecordingCommandError> {
        let gate = self.gate()?;
        let request = parse(request, RecordingWireCancelRequest::from_value)?;
        let bound = gate.cancel(request).await?;
        Ok(RecordingResult::of(bound, |reply| reply.as_value().clone()))
    }

    /// `recording_call_inspection` (read, whatever the original call's kind).
    pub async fn call_inspection(
        &self,
        request: Value,
    ) -> Result<RecordingResult, RecordingCommandError> {
        let gate = self.gate()?;
        let request = parse(request, RecordingWireCallInspectionRequest::from_value)?;
        let bound = gate.call_inspection(request).await?;
        Ok(RecordingResult::of(bound, |reply| reply.as_value().clone()))
    }

    /// `recording_attach` (read) from the page `page` of a webview (an ID the
    /// host gives each page load). The page gets a pump for the
    /// subscription unless one of its own already runs: the caller runs it
    /// ([`FramePump::run`]) to deliver its events. A replay from another
    /// page takes the subscription over from the earlier page's pump.
    pub async fn attach(
        &self,
        request: Value,
        page: u64,
    ) -> Result<(RecordingResult, Option<FramePump>), RecordingCommandError> {
        let host = self.host()?;
        let request = parse(request, RecordingWireAttachRequest::from_value)?;
        let bound = host.gate.attach(request).await?;
        let pump = match bound.reply.as_value()["outcome"]["subscriptionRef"].as_str() {
            Some(reference) => FramePump::claim(host, reference, page).await,
            None => None,
        };
        Ok((
            RecordingResult::of(bound, |reply| reply.as_value().clone()),
            pump,
        ))
    }

    /// `recording_control` (read): a snapshot or a detach. A detached
    /// subscription's pump ends at its next delivery.
    pub async fn control(&self, request: Value) -> Result<RecordingResult, RecordingCommandError> {
        let gate = self.gate()?;
        let request = parse(request, RecordingWireControlRequest::from_value)?;
        let bound = gate.control(request).await?;
        Ok(RecordingResult::of(bound, |reply| reply.as_value().clone()))
    }
}

/// The delivery loop of one subscription for one page. When the page ends
/// ([`Self::run`]'s `stop`) or its webview is gone, the subscription is
/// ended in the registry as well, freeing its live slot. Dropping a pump
/// that never ran only releases its claim.
pub struct FramePump {
    gate: Arc<RecordingGate>,
    pumps: Arc<tokio::sync::Mutex<Pumps>>,
    live_pages: Arc<Mutex<BTreeSet<u64>>>,
    reference: String,
    claim: Claim,
    interval: Duration,
}

/// What one delivery did.
enum Delivery {
    /// Delivered (or nothing new); keep polling.
    Continue,
    /// Held: the auth DB could not be read, or the phase refuses the
    /// registry for now. The frame stays in the registry's slot.
    Hold,
    /// The subscription is over (ended, detached, closed).
    Done,
    /// The page cannot receive events any more.
    Gone,
    /// Another page took the subscription over.
    TakenOver,
}

impl FramePump {
    async fn claim(host: &Host, reference: &str, page: u64) -> Option<Self> {
        let mut pumps = host.pumps.lock().await;
        let live = host.live_pages.lock().expect("live pages mutex poisoned");
        let existing = pumps.claims.get(reference).copied();
        if !live.contains(&page) {
            // An attach whose page ended while it ran: it never takes the
            // subscription from an open page. With no open page holding it,
            // nothing will deliver it, so it is ended (its live slot freed).
            if !existing.is_some_and(|claim| live.contains(&claim.page)) {
                pumps.claims.remove(reference);
                host.gate.end_subscription(reference);
            }
            return None;
        }
        if let Some(existing) = existing {
            if existing.page == page {
                return None;
            }
            // The subscription of an ended page is over, even if its pump
            // has not stopped yet; the new pump reports it ended.
            if !live.contains(&existing.page) {
                host.gate.end_subscription(reference);
            }
        }
        drop(live);
        pumps.next += 1;
        let claim = Claim {
            page,
            token: pumps.next,
        };
        pumps.claims.insert(reference.to_owned(), claim);
        Some(Self {
            gate: host.gate.clone(),
            pumps: host.pumps.clone(),
            live_pages: host.live_pages.clone(),
            reference: reference.to_owned(),
            claim,
            interval: host.interval,
        })
    }

    pub fn subscription_ref(&self) -> &str {
        &self.reference
    }

    fn page_ended(&self) -> bool {
        !self
            .live_pages
            .lock()
            .expect("live pages mutex poisoned")
            .contains(&self.claim.page)
    }

    fn owns(&self, pumps: &Pumps) -> bool {
        pumps.claims.get(&self.reference) == Some(&self.claim)
    }

    /// Deliver until the subscription ends, the page ends (`stop`
    /// completes), `emit` fails (`false`), or another page takes the
    /// subscription over. Each delivery re-validates the desktop session in
    /// the gate before it takes a frame (design §5).
    ///
    /// `stop` is the end of the page that attached: an event emitted with no
    /// listener still succeeds, so `emit` alone cannot tell a reloaded or
    /// closed webview. A page that ends, or whose events cannot be sent,
    /// ends its subscription in the registry too, unless another page has
    /// taken it over (a frame taken meanwhile was for the page that is gone).
    pub async fn run(
        self,
        mut emit: impl FnMut(RecordingEvent) -> bool + Send,
        stop: impl std::future::Future<Output = ()> + Send,
    ) {
        let deliver = async {
            loop {
                match self.deliver(&mut emit).await {
                    Delivery::Continue | Delivery::Hold => {}
                    other => return other,
                }
                tokio::time::sleep(self.interval).await;
            }
        };
        // `stop` first: a page that ended before the pump started delivers
        // nothing.
        let outcome = tokio::select! {
            biased;
            () = stop => Delivery::Gone,
            outcome = deliver => outcome,
        };
        let mut pumps = self.pumps.lock().await;
        if self.owns(&pumps) {
            pumps.claims.remove(&self.reference);
            if matches!(outcome, Delivery::Gone) {
                self.gate.end_subscription(&self.reference);
            }
        }
    }

    async fn deliver(&self, emit: &mut (impl FnMut(RecordingEvent) -> bool + Send)) -> Delivery {
        // Held across the take and the emit, so a takeover waits for this
        // delivery and every event reaches only the page that owns it.
        let pumps = self.pumps.lock().await;
        if !self.owns(&pumps) {
            return Delivery::TakenOver;
        }
        if self.page_ended() {
            return Delivery::Gone;
        }
        let event = match self.gate.frames(&self.reference).await {
            Ok(Bound { seq, reply }) => {
                if reply.state.is_none() && reply.control.is_none() {
                    return Delivery::Continue;
                }
                RecordingEvent::Frames {
                    subscription_ref: self.reference.clone(),
                    seq,
                    state: reply.state.map(|frame| frame.as_value().clone()),
                    control: reply.control.map(|frame| frame.as_value().clone()),
                }
            }
            Err(GateError::AuthUnavailable(_) | GateError::Phase(_)) => return Delivery::Hold,
            Err(error) => RecordingEvent::Ended {
                subscription_ref: self.reference.clone(),
                reason: gate_kind(&error),
            },
        };
        // The page may have ended while the frames were taken. The check and
        // the emit hold the live-pages lock, which `end_page` takes from the
        // page hook before the next page loads: an event of an ended page is
        // never emitted (to the next page of the same webview).
        let live = self.live_pages.lock().expect("live pages mutex poisoned");
        if !live.contains(&self.claim.page) {
            return Delivery::Gone;
        }
        let done = match &event {
            // `ownerClosed` is the only control frame: the closed snapshot
            // came with it, and nothing follows.
            RecordingEvent::Frames { control, .. } => control.is_some(),
            RecordingEvent::Ended { .. } => true,
        };
        let delivered = emit(event);
        drop(live);
        drop(pumps);
        match (delivered, done) {
            (false, _) => Delivery::Gone,
            (true, true) => Delivery::Done,
            (true, false) => Delivery::Continue,
        }
    }
}

impl Drop for FramePump {
    /// A pump dropped before [`Self::run`] finished (it never ran, or its
    /// task was aborted) releases its claim if it can without waiting; the
    /// subscription stays for a replayed attach.
    fn drop(&mut self) {
        if let Ok(mut pumps) = self.pumps.try_lock() {
            if self.owns(&pumps) {
                pumps.claims.remove(&self.reference);
            }
        }
    }
}

#[cfg(test)]
mod tests;
