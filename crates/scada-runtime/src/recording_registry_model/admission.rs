use super::*;
impl RegistryModel {
    pub fn begin_admission(
        &mut self,
        session: &ModelSession,
        request: RecordingAdmissionRequest,
    ) -> Result<AdmissionStart, ModelError> {
        self.begin_admission_inner(session, request, false)
    }
    pub(super) fn begin_admission_inner(
        &mut self,
        session: &ModelSession,
        request: RecordingAdmissionRequest,
        prepaid: bool,
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
        let reserved = if role == Role::Mutation && self.workflow.is_some() {
            require(prepaid, ModelError::Forbidden)?;
            Some(self.workflow_admission_plan(&request)?)
        } else {
            None
        };
        if role == Role::Mutation && reserved.is_none() {
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
        let read_id = if role == Role::Read {
            let rid = q["action"]["reconciliation"]["reconciliationId"]
                .as_str()
                .expect("validated reconciliation ID");
            require(
                !self.reconciliation_ids.contains_key(rid),
                ModelError::ProtocolViolation,
            )?;
            require(
                self.reconciliation_ids.len() < self.limits.reconciliation_ids,
                ModelError::Capacity,
            )?;
            Some(rid.to_owned())
        } else {
            None
        };
        let (storage, credits) = if let Some(r) = reserved {
            r
        } else {
            (LifetimeBudget::for_request(&request)?, 3)
        };
        let cost = if reserved.is_some() {
            0
        } else {
            sum(
                storage.bytes()?,
                if role == Role::Read { READ_ID_BYTES } else { 0 },
            )?
        };
        self.can_charge(role, cost)?;
        let sequence = self.sequence.checked_add(1).ok_or(ModelError::Capacity)?;
        let projection = if reserved.is_some() {
            self.projection_for(&request, self.projection.budget)?
        } else {
            self.admission_projection(&request)?
        };
        let publication = self.prepare_publication(
            &ProjectionEvent::Admission {
                id,
                sequence,
                request: &request,
            },
            projection,
        )?;
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
                projection_credits: credits,
                storage,
            },
        );
        self.projection.budget = projection;
        if reserved.is_none() {
            self.projection.reserved += credits as u64;
        }
        if let Some(rid) = read_id {
            self.reconciliation_ids
                .insert(rid, ticket.admission_id.clone());
        }
        self.commit_publication(publication, Some(&ticket.admission_id));
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
        r.storage.check_reply(reply.as_value())?;
        let native_keys = self.workflow_proof_plan(ticket, &reply)?;
        let handle = if kind == "accepted" {
            Some(self.plan_handle(ticket, &reply)?)
        } else {
            None
        };
        let publication = self.prepare_publication(
            &ProjectionEvent::Knowledge {
                id: &ticket.admission_id,
                sequence: ticket.sequence,
                reply: &reply,
            },
            self.projection.budget,
        )?;
        if let Some((key, record)) = handle {
            self.handles.insert(key, record);
        }
        self.admissions
            .get_mut(&ticket.admission_id)
            .expect("existing ticket")
            .proof = Some(reply);
        self.commit_workflow_proof(native_keys);
        self.commit_publication(publication, Some(&ticket.admission_id));
        self.refresh_workflow();
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
        r.storage.check_reply(reply.as_value())?;
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
        self.refresh_workflow();
        Ok(())
    }
}
