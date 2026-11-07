//! OwnerSnapshot projection and race-free subscriptions over saved native evidence.
//!
//! A descriptor only names immutable records (finished original replies, set-once preflight
//! knowledge and set-once native completions), so a reply fixed at revision R renders the same
//! JSON later. Native completions are folded in lazily: every subscription call first publishes
//! the evidence observed so far as at most one new revision. Intermediate states coalesce, which
//! complete-state frames allow; no native task or wait is added per subscriber.
use super::{
    apply::ApplyDispatchState,
    discard::DiscardLease,
    kernel::budget::{fits_bound, measured},
    lease::same_scope,
    observation::ObservedHandle,
    pause::PauseDispatchState,
    workflow::PreflightDispatchState,
    LeaseError, LeaseRole, RecordingRegistryRoot, RecordingRegistrySession,
};
use scada_model::recording_admission::{RecordingAdmissionReply, RecordingAdmissionRequest};
use scada_model::recording_wire::{
    same_recording_wire_request, RecordingWireAttachReply, RecordingWireAttachRequest,
    RecordingWireControlFrame, RecordingWireControlReply, RecordingWireControlRequest,
    RecordingWireStateFrame, WIRE_SNAPSHOT_LIMIT,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc};

/// Retained cost of one descriptor: a few record keys and scalars, never snapshot JSON.
pub(super) const DESCRIPTOR_BYTES: usize = 1024;
const MAX_REVISION: u64 = 9_007_199_254_740_991;
const MAX_LIVE_SUBSCRIPTIONS: usize = 4;
const MAX_ATTACHES: usize = 4096;
const MAX_CONTROLS: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AdmissionStage {
    Preflight,
    Pause,
    Apply,
    Discard,
    Reconciliation,
}

/// One registered original admission, borrowed for projection only.
pub(super) struct AdmissionEntry<'a> {
    pub stage: AdmissionStage,
    pub sequence: u64,
    pub request: &'a RecordingAdmissionRequest,
    pub reply: Option<&'a RecordingAdmissionReply>,
    pub knowledge: Option<&'a RecordingAdmissionReply>,
}

/// Which immutable record a published admission head renders.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Proof {
    /// Rendered as the original request with `unknown`/`workerFailure`, never upgraded later.
    Unknown,
    /// The fixed, definite original reply.
    Reply,
    /// The first Accepted AdmissionInspection knowledge for an `unknown` original call.
    Knowledge,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AdmissionView {
    stage: AdmissionStage,
    sequence: u64,
    proof: Proof,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct SnapshotDescriptor {
    revision: u64,
    closed: bool,
    blocked: bool,
    admission: Option<AdmissionView>,
    /// Present only when the head operation handle had completed at publication.
    operation: Option<ObservedHandle>,
    /// Present only when the head read handle had completed at publication.
    read: Option<ObservedHandle>,
}

struct SubscriptionRecord {
    principal: String,
    active: bool,
    state: Option<SnapshotDescriptor>,
    control: bool,
}

struct AttachRecord {
    request: RecordingWireAttachRequest,
    principal: String,
    reference: String,
    snapshot: SnapshotDescriptor,
}

struct ControlRecord {
    request: RecordingWireControlRequest,
    principal: String,
    snapshot: Option<SnapshotDescriptor>,
}

pub(super) struct SubscriptionState {
    current: SnapshotDescriptor,
    sequence: u64,
    subscriptions: BTreeMap<String, SubscriptionRecord>,
    attaches: BTreeMap<String, AttachRecord>,
    controls: BTreeMap<String, ControlRecord>,
}

impl SubscriptionState {
    pub(super) fn new() -> Self {
        Self {
            current: SnapshotDescriptor {
                revision: 1,
                closed: false,
                blocked: false,
                admission: None,
                operation: None,
                read: None,
            },
            sequence: 0,
            subscriptions: BTreeMap::new(),
            attaches: BTreeMap::new(),
            controls: BTreeMap::new(),
        }
    }

    fn live(&self) -> usize {
        self.subscriptions.values().filter(|s| s.active).count()
    }
}

fn proof_of(entry: &AdmissionEntry<'_>) -> Proof {
    match entry.reply {
        Some(reply) if reply.as_value()["outcome"]["kind"] != "unknown" => Proof::Reply,
        _ if entry.knowledge.is_some() => Proof::Knowledge,
        _ => Proof::Unknown,
    }
}

impl RecordingRegistryRoot {
    /// Read-role capability of this root and scope. Closed roots still serve existing
    /// subscriptions, original replies and explicit detach.
    fn qualify_subscriber(
        &self,
        session: &RecordingRegistrySession,
        scope: Option<&Value>,
    ) -> Result<(), LeaseError> {
        if !Arc::ptr_eq(&self.identity, &session.root_identity)
            || session.scope != self.scope
            || session.role != LeaseRole::Reconciliation
            || scope.is_some_and(|scope| !same_scope(&self.scope, scope))
        {
            return Err(LeaseError::Forbidden);
        }
        Ok(())
    }

    /// A snapshot carries the workflow's original admissions and results, so it is disclosed
    /// only to the workflow's principal, like Observation and AdmissionInspection.
    fn qualify_disclosure(&self, session: &RecordingRegistrySession) -> Result<(), LeaseError> {
        if self
            .workflow
            .as_ref()
            .is_some_and(|workflow| workflow.principal != session.principal)
        {
            return Err(LeaseError::Forbidden);
        }
        Ok(())
    }

    fn admission_entries(&self) -> Vec<AdmissionEntry<'_>> {
        let mut entries = Vec::new();
        if let Some(workflow) = &self.workflow {
            if let Some(record) = &workflow.registered {
                entries.push(AdmissionEntry {
                    stage: AdmissionStage::Preflight,
                    sequence: record.ticket.sequence(),
                    request: &record.request,
                    reply: match &record.state {
                        PreflightDispatchState::Finished(reply) => Some(reply),
                        _ => None,
                    },
                    knowledge: record.knowledge.as_ref(),
                });
            }
            if let Some(record) = workflow
                .pause_lease
                .as_ref()
                .and_then(|pause| pause.registered.as_ref())
            {
                entries.push(AdmissionEntry {
                    stage: AdmissionStage::Pause,
                    sequence: record.ticket.sequence(),
                    request: &record.request,
                    reply: match &record.state {
                        PauseDispatchState::Finished(reply) => Some(reply),
                        _ => None,
                    },
                    knowledge: None,
                });
            }
            if let Some(record) = workflow
                .apply_lease
                .as_ref()
                .and_then(|apply| apply.registered.as_ref())
            {
                entries.push(AdmissionEntry {
                    stage: AdmissionStage::Apply,
                    sequence: record.ticket.sequence,
                    request: &record.request,
                    reply: match &record.state {
                        ApplyDispatchState::Finished(reply) => Some(reply),
                        _ => None,
                    },
                    knowledge: None,
                });
            }
            if let Some(entry) = workflow
                .discard_lease
                .as_ref()
                .and_then(DiscardLease::admission_entry)
            {
                entries.push(entry);
            }
        }
        entries.extend(
            self.reconciliations
                .iter()
                .map(|read| read.admission_entry()),
        );
        entries
    }

    /// Accepted (handle-bearing) mutation handles; the largest sequence is the operation head.
    fn operation_head(&self) -> Option<ObservedHandle> {
        let workflow = self.workflow.as_ref()?;
        let mut heads = Vec::new();
        if let Some(record) = workflow.registered.as_ref().filter(|r| r.binding.is_some()) {
            heads.push(ObservedHandle::Preflight(record.ticket.sequence()));
        }
        if let Some(record) = workflow
            .pause_lease
            .as_ref()
            .and_then(|pause| pause.registered.as_ref())
            .filter(|r| r.binding.is_some())
        {
            heads.push(ObservedHandle::Pause(record.ticket.sequence()));
        }
        if let Some(record) = workflow
            .apply_lease
            .as_ref()
            .and_then(|apply| apply.registered.as_ref())
            .filter(|r| r.binding.is_some())
        {
            heads.push(ObservedHandle::Apply(record.ticket.sequence));
        }
        heads.into_iter().max_by_key(|handle| match handle {
            ObservedHandle::Preflight(s)
            | ObservedHandle::Pause(s)
            | ObservedHandle::Apply(s)
            | ObservedHandle::Reconciliation(s) => *s,
        })
    }

    fn read_head(&self) -> Option<ObservedHandle> {
        self.reconciliations
            .iter()
            .filter(|read| read.binding.is_some())
            .map(|read| read.ticket_sequence())
            .max()
            .map(ObservedHandle::Reconciliation)
    }

    /// The descriptor of the evidence observable now, at the current revision.
    fn observed_descriptor(&self) -> Result<SnapshotDescriptor, LeaseError> {
        let admission = self
            .admission_entries()
            .iter()
            .max_by_key(|entry| entry.sequence)
            .map(|entry| AdmissionView {
                stage: entry.stage,
                sequence: entry.sequence,
                proof: proof_of(entry),
            });
        let completed = |head: Option<ObservedHandle>| -> Result<_, LeaseError> {
            Ok(match head {
                Some(handle) if self.handle_completion(handle)?.is_some() => Some(handle),
                _ => None,
            })
        };
        Ok(SnapshotDescriptor {
            revision: self.subscriptions.current.revision,
            closed: self.closed,
            blocked: self.seed.recovery_required(),
            admission,
            operation: completed(self.operation_head())?,
            read: completed(self.read_head())?,
        })
    }

    /// Renders and validates a descriptor; a failure changes nothing.
    fn snapshot_value(&self, d: &SnapshotDescriptor) -> Result<Value, LeaseError> {
        let admission = match d.admission {
            None => Value::Null,
            Some(view) => {
                let entries = self.admission_entries();
                let entry = entries
                    .iter()
                    .find(|e| e.stage == view.stage && e.sequence == view.sequence)
                    .ok_or(LeaseError::ProtocolViolation)?;
                match view.proof {
                    Proof::Reply => entry
                        .reply
                        .ok_or(LeaseError::ProtocolViolation)?
                        .as_value()
                        .clone(),
                    Proof::Knowledge => entry
                        .knowledge
                        .ok_or(LeaseError::ProtocolViolation)?
                        .as_value()
                        .clone(),
                    Proof::Unknown => json!({
                        "version":1, "kind":"recordingAdmissionReply",
                        "request":entry.request.as_value(),
                        "outcome":{"kind":"unknown","error":"workerFailure"}
                    }),
                }
            }
        };
        let operation = match d.operation {
            None => Value::Null,
            Some(handle) => {
                let result = self
                    .handle_completion(handle)?
                    .ok_or(LeaseError::ProtocolViolation)?;
                json!({"operationRef":result["request"]["operationId"], "result":result})
            }
        };
        let read = match d.read {
            None => Value::Null,
            Some(handle) => self
                .handle_completion(handle)?
                .ok_or(LeaseError::ProtocolViolation)?,
        };
        let value = json!({
            "scope":self.scope, "revision":d.revision, "closed":d.closed,
            "ownerBlocked":d.blocked, "admission":admission, "operation":operation,
            "reconciliation":read
        });
        let bound = measured(&value).map_err(|_| LeaseError::Capacity)?;
        if !fits_bound(bound, WIRE_SNAPSHOT_LIMIT) {
            return Err(LeaseError::Capacity);
        }
        RecordingWireStateFrame::from_value(json!({
            "version":1, "kind":"recordingWireStateFrame",
            "subscriptionRef":"validation", "snapshot":value
        }))
        .map_err(|_| LeaseError::ProtocolViolation)?;
        Ok(value)
    }

    /// Publishes observed evidence as one new revision when the snapshot content changed.
    /// Equal content never increments; a close also queues one `ownerClosed` control frame.
    fn refresh_snapshot(&mut self) -> Result<(), LeaseError> {
        let current = self.subscriptions.current;
        let mut next = self.observed_descriptor()?;
        if next == current {
            return Ok(());
        }
        next.revision = current
            .revision
            .checked_add(1)
            .filter(|revision| *revision <= MAX_REVISION)
            .ok_or(LeaseError::Capacity)?;
        self.snapshot_value(&next)?;
        let closing = next.closed && !current.closed;
        self.subscriptions.current = next;
        for subscription in self
            .subscriptions
            .subscriptions
            .values_mut()
            .filter(|s| s.active)
        {
            subscription.state = Some(next);
            if closing {
                subscription.control = true;
            }
        }
        Ok(())
    }

    /// The latest complete snapshot, after folding in evidence observed so far.
    pub fn owner_snapshot(
        &mut self,
        session: &RecordingRegistrySession,
    ) -> Result<Value, LeaseError> {
        self.qualify_subscriber(session, None)?;
        self.qualify_disclosure(session)?;
        self.refresh_snapshot()?;
        self.snapshot_value(&self.subscriptions.current)
    }

    fn attach_reply(&self, record: &AttachRecord) -> Result<RecordingWireAttachReply, LeaseError> {
        RecordingWireAttachReply::from_value(json!({
            "version":1, "kind":"recordingWireAttachReply", "request":record.request.as_value(),
            "outcome":{"kind":"attached", "subscriptionRef":record.reference,
                "snapshot":self.snapshot_value(&record.snapshot)?}
        }))
        .map_err(|_| LeaseError::ProtocolViolation)
    }

    fn control_reply(
        &self,
        record: &ControlRecord,
    ) -> Result<RecordingWireControlReply, LeaseError> {
        let outcome = match &record.snapshot {
            Some(d) => json!({"kind":"snapshot", "snapshot":self.snapshot_value(d)?}),
            None => json!({"kind":"detached"}),
        };
        RecordingWireControlReply::from_value(json!({
            "version":1, "kind":"recordingWireControlReply",
            "request":record.request.as_value(), "outcome":outcome
        }))
        .map_err(|_| LeaseError::ProtocolViolation)
    }

    /// Registers a subscriber and fixes snapshot R in one step; later revisions go to its slot.
    /// The same ID and body returns the original reply even after close, never a newer snapshot.
    pub fn attach(
        &mut self,
        session: &RecordingRegistrySession,
        request: RecordingWireAttachRequest,
    ) -> Result<RecordingWireAttachReply, LeaseError> {
        let value = request.as_value();
        self.qualify_subscriber(session, Some(&value["scope"]))?;
        self.qualify_disclosure(session)?;
        let id = value["attachId"].as_str().expect("validated ID").to_owned();
        if let Some(old) = self.subscriptions.attaches.get(&id) {
            if old.principal != session.principal {
                return Err(LeaseError::Forbidden);
            }
            if !same_recording_wire_request(old.request.as_document(), request.as_document()) {
                return Err(LeaseError::ProtocolViolation);
            }
            return self.attach_reply(old);
        }
        if self.closed {
            return Err(LeaseError::Closed);
        }
        self.refresh_snapshot()?;
        let current = self.subscriptions.current;
        let after = &value["afterRevision"];
        if !after.is_null()
            && !after
                .as_f64()
                .is_some_and(|revision| revision <= current.revision as f64)
        {
            return Err(LeaseError::ProtocolViolation);
        }
        if self.subscriptions.attaches.len() >= MAX_ATTACHES
            || self.subscriptions.live() >= MAX_LIVE_SUBSCRIPTIONS
        {
            return Err(LeaseError::Capacity);
        }
        let sequence = self
            .subscriptions
            .sequence
            .checked_add(1)
            .ok_or(LeaseError::Capacity)?;
        // Request, the fixed reply descriptor and the live state slot are reserved up front.
        let cost = measured(request.as_value())
            .map_err(|_| LeaseError::Capacity)?
            .bytes
            .checked_add(2 * DESCRIPTOR_BYTES)
            .ok_or(LeaseError::Capacity)?;
        let next_bytes = self
            .read_bytes
            .checked_add(cost)
            .filter(|bytes| *bytes <= self.read_byte_limit)
            .ok_or(LeaseError::Capacity)?;
        let reference = format!("native-subscription:{sequence}");
        let record = AttachRecord {
            request,
            principal: session.principal.clone(),
            reference: reference.clone(),
            snapshot: current,
        };
        let reply = self.attach_reply(&record)?;
        self.read_bytes = next_bytes;
        self.subscriptions.sequence = sequence;
        self.subscriptions.attaches.insert(id, record);
        self.subscriptions.subscriptions.insert(
            reference,
            SubscriptionRecord {
                principal: session.principal.clone(),
                active: true,
                state: None,
                control: false,
            },
        );
        Ok(reply)
    }

    /// Explicit snapshot or detach. Detach frees only the live slot and never stops native work.
    pub fn control(
        &mut self,
        session: &RecordingRegistrySession,
        request: RecordingWireControlRequest,
    ) -> Result<RecordingWireControlReply, LeaseError> {
        let value = request.as_value();
        self.qualify_subscriber(session, Some(&value["scope"]))?;
        let id = value["controlId"]
            .as_str()
            .expect("validated ID")
            .to_owned();
        if let Some(old) = self.subscriptions.controls.get(&id) {
            if old.principal != session.principal {
                return Err(LeaseError::Forbidden);
            }
            if !same_recording_wire_request(old.request.as_document(), request.as_document()) {
                return Err(LeaseError::ProtocolViolation);
            }
            if old.snapshot.is_some() {
                self.qualify_disclosure(session)?;
            }
            return self.control_reply(old);
        }
        if self.subscriptions.controls.len() >= MAX_CONTROLS {
            return Err(LeaseError::Capacity);
        }
        let reference = value["subscriptionRef"]
            .as_str()
            .expect("validated ID")
            .to_owned();
        let subscription = self
            .subscriptions
            .subscriptions
            .get(&reference)
            .ok_or(LeaseError::InvalidInput)?;
        if subscription.principal != session.principal {
            return Err(LeaseError::Forbidden);
        }
        let detach = value["action"] == "detach";
        if !detach && !subscription.active {
            return Err(LeaseError::InvalidInput);
        }
        let refund = if detach && subscription.active {
            DESCRIPTOR_BYTES
        } else {
            0
        };
        if !detach {
            self.qualify_disclosure(session)?;
            self.refresh_snapshot()?;
        }
        let cost = measured(request.as_value())
            .map_err(|_| LeaseError::Capacity)?
            .bytes
            .checked_add(DESCRIPTOR_BYTES)
            .ok_or(LeaseError::Capacity)?;
        let used = self
            .read_bytes
            .checked_sub(refund)
            .and_then(|bytes| bytes.checked_add(cost))
            .filter(|bytes| *bytes <= self.read_byte_limit)
            .ok_or(LeaseError::Capacity)?;
        let record = ControlRecord {
            request,
            principal: session.principal.clone(),
            snapshot: (!detach).then_some(self.subscriptions.current),
        };
        let reply = self.control_reply(&record)?;
        self.read_bytes = used;
        if detach {
            let subscription = self
                .subscriptions
                .subscriptions
                .get_mut(&reference)
                .expect("existing subscription");
            subscription.active = false;
            subscription.state = None;
            subscription.control = false;
        }
        self.subscriptions.controls.insert(id, record);
        Ok(reply)
    }

    fn live_subscription(
        &self,
        session: &RecordingRegistrySession,
        reference: &str,
    ) -> Result<(), LeaseError> {
        self.qualify_subscriber(session, None)?;
        let subscription = self
            .subscriptions
            .subscriptions
            .get(reference)
            .filter(|s| s.active)
            .ok_or(LeaseError::InvalidInput)?;
        if subscription.principal != session.principal {
            return Err(LeaseError::Forbidden);
        }
        Ok(())
    }

    /// Takes the latest-one state slot. The slot empties only after the frame is built.
    pub fn take_state_frame(
        &mut self,
        session: &RecordingRegistrySession,
        reference: &str,
    ) -> Result<Option<RecordingWireStateFrame>, LeaseError> {
        self.live_subscription(session, reference)?;
        self.qualify_disclosure(session)?;
        self.refresh_snapshot()?;
        let Some(d) = self.subscriptions.subscriptions[reference].state else {
            return Ok(None);
        };
        let frame = RecordingWireStateFrame::from_value(json!({
            "version":1, "kind":"recordingWireStateFrame", "subscriptionRef":reference,
            "snapshot":self.snapshot_value(&d)?
        }))
        .map_err(|_| LeaseError::ProtocolViolation)?;
        self.subscriptions
            .subscriptions
            .get_mut(reference)
            .expect("existing subscription")
            .state = None;
        Ok(Some(frame))
    }

    /// Takes the one control slot. Only `ownerClosed` exists until auth and transport do.
    pub fn take_control_frame(
        &mut self,
        session: &RecordingRegistrySession,
        reference: &str,
    ) -> Result<Option<RecordingWireControlFrame>, LeaseError> {
        self.live_subscription(session, reference)?;
        self.refresh_snapshot()?;
        if !self.subscriptions.subscriptions[reference].control {
            return Ok(None);
        }
        let frame = RecordingWireControlFrame::from_value(json!({
            "version":1, "kind":"recordingWireControlFrame", "scope":self.scope,
            "subscriptionRef":reference, "reason":"ownerClosed"
        }))
        .map_err(|_| LeaseError::ProtocolViolation)?;
        self.subscriptions
            .subscriptions
            .get_mut(reference)
            .expect("existing subscription")
            .control = false;
        Ok(Some(frame))
    }

    #[cfg(test)]
    pub(crate) fn test_live_subscriptions(&self) -> usize {
        self.subscriptions.live()
    }
}
