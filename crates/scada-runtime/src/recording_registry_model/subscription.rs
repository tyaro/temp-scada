//! Atomic logical attachment, immutable replies and latest-one simulated delivery.
use super::*;
#[derive(Debug)]
pub(super) struct SubscriptionRecord {
    pub active: bool,
    pub state: Option<SnapshotDescriptor>,
    pub control: bool,
}
#[derive(Debug)]
pub(super) struct AttachRecord {
    pub request: RecordingWireAttachRequest,
    pub reference: String,
    pub snapshot: SnapshotDescriptor,
}
#[derive(Debug)]
pub(super) struct ControlRecord {
    pub request: RecordingWireControlRequest,
    pub snapshot: Option<SnapshotDescriptor>,
}
impl RegistryModel {
    pub(super) fn attach_reply(
        &self,
        r: &AttachRecord,
    ) -> Result<RecordingWireAttachReply, ModelError> {
        let snapshot = self.snapshot_value(&r.snapshot, None)?;
        RecordingWireAttachReply::from_value(json!({"version":1,"kind":"recordingWireAttachReply","request":r.request.as_value(),"outcome":{"kind":"attached","subscriptionRef":r.reference,"snapshot":snapshot}})).map_err(|_|ModelError::InvalidInput)
    }
    pub(super) fn control_reply(
        &self,
        r: &ControlRecord,
    ) -> Result<RecordingWireControlReply, ModelError> {
        let outcome = if let Some(d) = &r.snapshot {
            json!({"kind":"snapshot","snapshot":self.snapshot_value(d,None)?})
        } else {
            json!({"kind":"detached"})
        };
        RecordingWireControlReply::from_value(json!({"version":1,"kind":"recordingWireControlReply","request":r.request.as_value(),"outcome":outcome})).map_err(|_|ModelError::InvalidInput)
    }
    pub fn attach(
        &mut self,
        session: &ModelSession,
        request: RecordingWireAttachRequest,
    ) -> Result<RecordingWireAttachReply, ModelError> {
        self.qualify(session)?;
        let q = request.as_value();
        require(self.scope_matches(&q["scope"]), ModelError::Forbidden)?;
        let id = q["attachId"].as_str().expect("validated ID");
        if let Some(old) = self.attaches.get(id) {
            require(
                same_recording_wire_request(old.request.as_document(), request.as_document()),
                ModelError::ProtocolViolation,
            )?;
            return self.attach_reply(old);
        }
        require(!self.closed, ModelError::Closed)?;
        require(
            q["afterRevision"].is_null()
                || q["afterRevision"]
                    .as_f64()
                    .is_some_and(|r| r <= self.projection.current.revision as f64),
            ModelError::ProtocolViolation,
        )?;
        require(
            self.attaches.len() < self.limits.attach_requests
                && self.subscriptions.values().filter(|s| s.active).count()
                    < self.limits.live_subscriptions,
            ModelError::Capacity,
        )?;
        let sequence = self
            .subscription_sequence
            .checked_add(1)
            .ok_or(ModelError::Capacity)?;
        let reference = format!("model-subscription:{sequence}");
        let cost = sum(bytes(q)?, 2 * DESCRIPTOR_BYTES)?;
        self.can_charge(Role::Read, cost)?;
        let id = id.to_owned();
        let record = AttachRecord {
            request,
            reference: reference.clone(),
            snapshot: self.projection.current.clone(),
        };
        let reply = self.attach_reply(&record)?;
        self.charge(Role::Read, cost);
        self.subscription_sequence = sequence;
        self.attaches.insert(id, record);
        self.subscriptions.insert(
            reference,
            SubscriptionRecord {
                active: true,
                state: None,
                control: false,
            },
        );
        Ok(reply)
    }
    pub fn control(
        &mut self,
        session: &ModelSession,
        request: RecordingWireControlRequest,
    ) -> Result<RecordingWireControlReply, ModelError> {
        self.qualify(session)?;
        let q = request.as_value();
        require(self.scope_matches(&q["scope"]), ModelError::Forbidden)?;
        let id = q["controlId"].as_str().expect("validated ID");
        if let Some(old) = self.controls.get(id) {
            require(
                same_recording_wire_request(old.request.as_document(), request.as_document()),
                ModelError::ProtocolViolation,
            )?;
            return self.control_reply(old);
        }
        require(
            self.controls.len() < self.limits.control_requests,
            ModelError::Capacity,
        )?;
        let reference = q["subscriptionRef"].as_str().expect("validated ID");
        let sub = self
            .subscriptions
            .get(reference)
            .ok_or(ModelError::InvalidInput)?;
        let detach = q["action"] == "detach";
        require(detach || sub.active, ModelError::InvalidInput)?;
        let refund = if detach && sub.active {
            DESCRIPTOR_BYTES
        } else {
            0
        };
        let cost = sum(bytes(q)?, DESCRIPTOR_BYTES)?;
        let used = self
            .read_bytes
            .checked_sub(refund)
            .and_then(|v| v.checked_add(cost))
            .ok_or(ModelError::Capacity)?;
        require(used <= self.limits.read_bytes, ModelError::Capacity)?;
        let id = id.to_owned();
        let reference = reference.to_owned();
        let record = ControlRecord {
            request,
            snapshot: (!detach).then(|| self.projection.current.clone()),
        };
        let reply = self.control_reply(&record)?;
        self.read_bytes = used;
        if detach {
            let sub = self
                .subscriptions
                .get_mut(&reference)
                .expect("existing subscription");
            sub.active = false;
            sub.state = None;
            sub.control = false;
        }
        self.controls.insert(id, record);
        Ok(reply)
    }
    pub fn take_state_frame(
        &mut self,
        session: &ModelSession,
        reference: &str,
    ) -> Result<Option<RecordingWireStateFrame>, ModelError> {
        self.qualify(session)?;
        require(types::valid_id(reference), ModelError::InvalidInput)?;
        let sub = self
            .subscriptions
            .get(reference)
            .filter(|s| s.active)
            .ok_or(ModelError::InvalidInput)?;
        let Some(d) = &sub.state else {
            return Ok(None);
        };
        let snapshot = self.snapshot_value(d, None)?;
        let frame=RecordingWireStateFrame::from_value(json!({"version":1,"kind":"recordingWireStateFrame","subscriptionRef":reference,"snapshot":snapshot})).map_err(|_|ModelError::InvalidInput)?;
        self.subscriptions
            .get_mut(reference)
            .expect("existing subscription")
            .state = None;
        Ok(Some(frame))
    }
    pub fn take_control_frame(
        &mut self,
        session: &ModelSession,
        reference: &str,
    ) -> Result<Option<RecordingWireControlFrame>, ModelError> {
        self.qualify(session)?;
        require(types::valid_id(reference), ModelError::InvalidInput)?;
        let sub = self
            .subscriptions
            .get(reference)
            .filter(|s| s.active)
            .ok_or(ModelError::InvalidInput)?;
        if !sub.control {
            return Ok(None);
        }
        let frame=RecordingWireControlFrame::from_value(json!({"version":1,"kind":"recordingWireControlFrame","scope":self.session.scope,"subscriptionRef":reference,"reason":"ownerClosed"})).map_err(|_|ModelError::InvalidInput)?;
        self.subscriptions
            .get_mut(reference)
            .expect("existing subscription")
            .control = false;
        Ok(Some(frame))
    }
}
