use super::*;
impl RegistryModel {
    pub fn begin_admission(
        &mut self,
        session: &ModelSession,
        request: RecordingAdmissionRequest,
    ) -> Result<AdmissionStart, ModelError> {
        self.qualify(session)?;
        let q = request.as_value();
        require(self.admission_matches_scope(q), ModelError::Forbidden)?;
        let id = q["admissionId"].as_str().expect("validated ID");
        if let Some(r) = self.admissions.get(id) {
            require(
                same_recording_admission_request(&r.request, &request),
                ModelError::ProtocolViolation,
            )?;
            return Ok(if let Some(reply) = &r.terminal {
                AdmissionStart::Replay {
                    reply: reply.clone(),
                }
            } else {
                AdmissionStart::Pending {
                    ticket: self.ticket(id, r.sequence),
                }
            });
        }
        self.new_effect()?;
        let role = admission_role(q);
        let (lease_id, lease) = self
            .leases
            .iter()
            .find(|(_, r)| {
                r.reply.as_value()["outcome"]["deadlineLeaseRef"] == q["deadlineLeaseRef"]
            })
            .ok_or(ModelError::InvalidInput)?;
        require(
            lease.request.as_value()["admissionId"] == q["admissionId"],
            ModelError::ProtocolViolation,
        )?;
        require(lease.role == role, ModelError::Forbidden)?;
        require(!lease.consumed, ModelError::ProtocolViolation)?;
        require(self.now.0 < lease.deadline, ModelError::Expired)?;
        require(
            !self.admissions.values().any(|r| r.terminal.is_none()),
            ModelError::Busy,
        )?;
        if role == Role::Mutation {
            require(
                !self.admissions.values().any(|r| {
                    r.proof
                        .as_ref()
                        .is_none_or(|p| p.as_value()["outcome"]["kind"] == "accepted")
                }),
                ModelError::Busy,
            )?;
        }
        let count = self.admissions.values().filter(|r| r.role == role).count();
        let max = if role == Role::Mutation {
            self.limits.mutation_admissions
        } else {
            self.limits.read_admissions
        };
        require(count < max, ModelError::Capacity)?;
        // Independent current knowledge + immutable original reply, no early release.
        let cost = sum(
            bytes(q)?,
            2 * scada_model::recording_admission::MAX_RECORDING_ADMISSION_JSON_BYTES,
        )?;
        let cost = sum(cost, completion_reservation(role))?;
        self.can_charge(role, cost)?;
        let sequence = self.sequence.checked_add(1).ok_or(ModelError::Capacity)?;
        let id = id.to_owned();
        let lease_id = lease_id.clone();
        self.sequence = sequence;
        self.charge(role, cost);
        self.leases
            .get_mut(&lease_id)
            .expect("existing lease")
            .consumed = true;
        let ticket = self.ticket(&id, sequence);
        self.admissions.insert(
            id,
            AdmissionRecord {
                request,
                role,
                sequence,
                proof: None,
                terminal: None,
            },
        );
        Ok(AdmissionStart::Registered { ticket })
    }
    /// Explicit simulation input, not a native opaque proof or a wire decoder.
    pub fn observe_native(
        &mut self,
        ticket: &SimulationTicket,
        decision: SimulatedDecision,
    ) -> Result<(), ModelError> {
        let (reply, kind) = match decision {
            SimulatedDecision::Accepted(v) => (v, "accepted"),
            SimulatedDecision::Rejected(v) => (v, "rejected"),
            SimulatedDecision::CompletedDiscard(v) => (v, "completedDiscard"),
        };
        let r = self.record(ticket)?;
        require(
            reply.as_value()["outcome"]["kind"] == kind
                && recording_admission_reply_matches_request(&reply, &r.request),
            ModelError::ProtocolViolation,
        )?;
        if let Some(old) = &r.proof {
            return require(
                same_value(old.as_value(), reply.as_value()),
                ModelError::ProtocolViolation,
            );
        }
        if kind == "accepted" {
            self.register_handle(ticket, &reply)?;
        }
        self.admissions
            .get_mut(&ticket.admission_id)
            .expect("existing ticket")
            .proof = Some(reply);
        Ok(())
    }
    pub fn finish_admission_call(
        &mut self,
        ticket: &SimulationTicket,
        reply: RecordingAdmissionReply,
    ) -> Result<(), ModelError> {
        let r = self.record(ticket)?;
        require(
            recording_admission_reply_matches_request(&reply, &r.request),
            ModelError::ProtocolViolation,
        )?;
        if let Some(old) = &r.terminal {
            return require(
                same_value(old.as_value(), reply.as_value()),
                ModelError::ProtocolViolation,
            );
        }
        if reply.as_value()["outcome"]["kind"] != "unknown" {
            require(
                r.proof
                    .as_ref()
                    .is_some_and(|p| same_value(p.as_value(), reply.as_value())),
                ModelError::ProtocolViolation,
            )?;
        }
        self.admissions
            .get_mut(&ticket.admission_id)
            .expect("existing ticket")
            .terminal = Some(reply);
        Ok(())
    }
}
