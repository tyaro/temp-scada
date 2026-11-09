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
//! - **Subscriptions**: a new subscription of `recording_attach` gets one
//!   [`FramePump`]. It polls the gate (the registry folds native evidence
//!   into its latest-one slots only when asked) and re-validates the desktop
//!   session at every delivery, so a revocation is found without waiting for
//!   the next command. An auth DB read failure holds the frame in the
//!   registry's slot until the next delivery; any other refusal ends the
//!   subscription with a [`RecordingEvent::Ended`].
//! - **Without a recording owner** (the product host until C5), every
//!   command answers `{"kind": "recordingUnavailable", "reason": ...}`.
use std::collections::BTreeSet;
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
    /// The subscriptions with a running pump, so a replayed attach does not
    /// start a second one.
    pumped: Arc<Mutex<BTreeSet<String>>>,
    interval: Duration,
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
                pumped: Arc::default(),
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

    /// `recording_attach` (read). A subscription with no running pump gets
    /// one: the caller runs it ([`FramePump::run`]) to deliver its events. A
    /// replayed attach of a subscription whose pump runs gets none.
    pub async fn attach(
        &self,
        request: Value,
    ) -> Result<(RecordingResult, Option<FramePump>), RecordingCommandError> {
        let host = self.host()?;
        let request = parse(request, RecordingWireAttachRequest::from_value)?;
        let bound = host.gate.attach(request).await?;
        let pump = bound.reply.as_value()["outcome"]["subscriptionRef"]
            .as_str()
            .and_then(|reference| FramePump::claim(host, reference));
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

/// The delivery loop of one subscription. Dropping it (or the future of
/// [`Self::run`]) releases the subscription, so a later replayed attach
/// starts a new pump.
pub struct FramePump {
    gate: Arc<RecordingGate>,
    pumped: Arc<Mutex<BTreeSet<String>>>,
    reference: String,
    interval: Duration,
}

/// What one delivery did.
enum Delivery {
    /// Delivered (or nothing new); keep polling.
    Continue,
    /// Held: the auth DB could not be read, or the phase refuses the
    /// registry for now. The frame stays in the registry's slot.
    Hold,
    /// Nothing more will be delivered.
    Stop,
}

impl FramePump {
    fn claim(host: &Host, reference: &str) -> Option<Self> {
        let mut pumped = host.pumped.lock().expect("pump set mutex poisoned");
        pumped.insert(reference.to_owned()).then(|| Self {
            gate: host.gate.clone(),
            pumped: host.pumped.clone(),
            reference: reference.to_owned(),
            interval: host.interval,
        })
    }

    pub fn subscription_ref(&self) -> &str {
        &self.reference
    }

    /// Deliver until the subscription ends or `emit` reports the webview
    /// gone (`false`). Each delivery re-validates the desktop session in the
    /// gate before it takes a frame (design §5).
    pub async fn run(self, mut emit: impl FnMut(RecordingEvent) -> bool + Send) {
        loop {
            match self.deliver(&mut emit).await {
                Delivery::Continue | Delivery::Hold => {}
                Delivery::Stop => return,
            }
            tokio::time::sleep(self.interval).await;
        }
    }

    async fn deliver(&self, emit: &mut (impl FnMut(RecordingEvent) -> bool + Send)) -> Delivery {
        let error = match self.gate.frames(&self.reference).await {
            Ok(Bound { seq, reply }) => {
                if reply.state.is_none() && reply.control.is_none() {
                    return Delivery::Continue;
                }
                // `ownerClosed` is the only control frame: the closed
                // snapshot came with it, and nothing follows.
                let closed = reply.control.is_some();
                let delivered = emit(RecordingEvent::Frames {
                    subscription_ref: self.reference.clone(),
                    seq,
                    state: reply.state.map(|frame| frame.as_value().clone()),
                    control: reply.control.map(|frame| frame.as_value().clone()),
                });
                return if delivered && !closed {
                    Delivery::Continue
                } else {
                    Delivery::Stop
                };
            }
            Err(error) => error,
        };
        match error {
            GateError::AuthUnavailable(_) | GateError::Phase(_) => Delivery::Hold,
            error => {
                emit(RecordingEvent::Ended {
                    subscription_ref: self.reference.clone(),
                    reason: gate_kind(&error),
                });
                Delivery::Stop
            }
        }
    }
}

impl Drop for FramePump {
    fn drop(&mut self) {
        if let Ok(mut pumped) = self.pumped.lock() {
            pumped.remove(&self.reference);
        }
    }
}

#[cfg(test)]
mod tests;
