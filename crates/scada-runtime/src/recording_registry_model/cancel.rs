//! Original cancel call, one simulated notification per handle, immutable ack.
use super::*;
impl RegistryModel {
    pub fn begin_cancel(
        &mut self,
        session: &ModelSession,
        request: RecordingWireCancelRequest,
    ) -> Result<CancelStart, ModelError> {
        self.qualify(session)?;
        let q = request.as_value();
        require(self.scope_matches(&q["scope"]), ModelError::Forbidden)?;
        let id = q["cancelId"].as_str().expect("validated ID");
        if let Some(r) = self.cancels.get(id) {
            require(
                same_recording_wire_request(r.request.as_document(), request.as_document()),
                ModelError::ProtocolViolation,
            )?;
            return Ok(if r.terminal {
                CancelStart::Replay {
                    reply: r.decision.as_ref().expect("terminal decision").clone(),
                }
            } else {
                CancelStart::Pending {
                    ticket: self.cancel_ticket(id, r.sequence),
                }
            });
        }
        self.new_effect()?;
        require(
            self.cancels.len() < self.limits.cancel_requests,
            ModelError::Capacity,
        )?;
        require(self.limits.pending_cancel_calls > 0, ModelError::Capacity)?;
        require(
            self.cancels.values().filter(|c| !c.terminal).count()
                < self.limits.pending_cancel_calls,
            ModelError::Busy,
        )?;
        let cost = sum(
            bytes(q)?,
            recording_wire_reply_capacity(request.as_document())
                .map_err(|_| ModelError::InvalidInput)?
                .reply
                .bytes,
        )?;
        self.can_charge(Role::Read, cost)?;
        let sequence = self.sequence.checked_add(1).ok_or(ModelError::Capacity)?;
        let key = (
            if q["target"]["kind"] == "operation" {
                Role::Mutation
            } else {
                Role::Read
            },
            q["target"]["ref"]
                .as_str()
                .expect("validated ref")
                .to_owned(),
        );
        let target = self.handles.contains_key(&key).then_some(key);
        let id = id.to_owned();
        let ticket = self.cancel_ticket(&id, sequence);
        self.sequence = sequence;
        self.charge(Role::Read, cost);
        self.cancels.insert(
            id,
            CancelRecord {
                request,
                sequence,
                target,
                decision: None,
                terminal: false,
            },
        );
        Ok(CancelStart::Registered { ticket })
    }
    /// Records a simulation decision, not the original dispatcher terminal.
    pub fn notify_cancel(
        &mut self,
        ticket: &ModelCancelTicket,
    ) -> Result<RecordingWireCancelReply, ModelError> {
        let record = self.cancel_record(ticket)?;
        if let Some(reply) = &record.decision {
            return Ok(reply.clone());
        }
        let (outcome, notify) = match &record.target {
            None => (json!({"kind":"rejected","error":"ownerUnavailable"}), None),
            Some(key) => {
                let handle = self.handles.get(key).ok_or(ModelError::InvalidInput)?;
                if key.0 == Role::Mutation && self.handle_request(handle)["stage"] == "pauseJoin" {
                    (json!({"kind":"ack","disposition":"notSupported"}), None)
                } else if handle.completion.is_some() {
                    // Logical model delivery only; never physical quiescence evidence.
                    (json!({"kind":"ack","disposition":"alreadyCompleted"}), None)
                } else {
                    (
                        json!({"kind":"ack","disposition":"requested"}),
                        (!handle.cancel_notified).then(|| key.clone()),
                    )
                }
            }
        };
        let reply=RecordingWireCancelReply::from_value(json!({"version":1,"kind":"recordingWireCancelReply","request":record.request.as_value(),"outcome":outcome})).map_err(|_|ModelError::InvalidInput)?;
        if let Some(key) = notify {
            self.handles
                .get_mut(&key)
                .expect("bound handle")
                .cancel_notified = true;
        }
        self.cancels
            .get_mut(&ticket.cancel_id)
            .expect("existing ticket")
            .decision = Some(reply.clone());
        Ok(reply)
    }
    /// Persists the prior decision. Never implicitly calls notify_cancel.
    pub fn finish_cancel_call(
        &mut self,
        ticket: &ModelCancelTicket,
    ) -> Result<RecordingWireCancelReply, ModelError> {
        let reply = self
            .cancel_record(ticket)?
            .decision
            .as_ref()
            .ok_or(ModelError::InvalidInput)?
            .clone();
        self.cancels
            .get_mut(&ticket.cancel_id)
            .expect("existing ticket")
            .terminal = true;
        Ok(reply)
    }
    fn cancel_ticket(&self, id: &str, sequence: u64) -> ModelCancelTicket {
        ModelCancelTicket {
            identity: Arc::clone(&self.identity),
            sequence,
            cancel_id: id.to_owned(),
        }
    }
    fn cancel_record(&self, ticket: &ModelCancelTicket) -> Result<&CancelRecord, ModelError> {
        require(
            Arc::ptr_eq(&self.identity, &ticket.identity),
            ModelError::Forbidden,
        )?;
        self.cancels
            .get(&ticket.cancel_id)
            .filter(|r| r.sequence == ticket.sequence)
            .ok_or(ModelError::InvalidInput)
    }
}
