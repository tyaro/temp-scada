use super::*;
impl RegistryModel {
    pub fn issue_lease(
        &mut self,
        session: &ModelSession,
        request: RecordingWireLeaseRequest,
    ) -> Result<RecordingWireLeaseReply, ModelError> {
        self.qualify(session)?;
        let q = request.as_value();
        require(self.scope_matches(&q["scope"]), ModelError::Forbidden)?;
        let id = q["leaseRequestId"].as_str().expect("validated ID");
        if let Some(r) = self.leases.get(id) {
            require(
                same_recording_wire_request(r.request.as_document(), request.as_document()),
                ModelError::ProtocolViolation,
            )?;
            return Ok(r.reply.clone());
        }
        self.new_effect()?;
        require(
            !self
                .leases
                .values()
                .any(|r| r.request.as_value()["admissionId"] == q["admissionId"]),
            ModelError::ProtocolViolation,
        )?;
        let role = if q["role"] == "mutation" {
            Role::Mutation
        } else {
            Role::Read
        };
        let count = self.leases.values().filter(|r| r.role == role).count();
        let max = if role == Role::Mutation {
            self.limits.mutation_leases
        } else {
            self.limits.read_leases
        };
        require(count < max, ModelError::Capacity)?;
        require(
            self.leases
                .values()
                .filter(|r| r.role == role && !r.consumed && self.now.0 < r.deadline)
                .count()
                < self.limits.unconsumed_leases,
            ModelError::Capacity,
        )?;
        let budget = q["requestedBudgetMs"]
            .as_u64()
            .or_else(|| q["requestedBudgetMs"].as_f64().map(|v| v as u64))
            .expect("validated integer");
        let deadline = self
            .now
            .0
            .checked_add(budget)
            .ok_or(ModelError::InvalidInput)?;
        let sequence = self.sequence.checked_add(1).ok_or(ModelError::Capacity)?;
        let reply=RecordingWireLeaseReply::from_value(json!({"version":1,"kind":"recordingWireLeaseReply","request":q,"outcome":{"kind":"issued","deadlineLeaseRef":format!("model-lease:{sequence}"),"grantedBudgetMs":budget}})).map_err(|_|ModelError::InvalidInput)?;
        let cost = sum(bytes(q)?, bytes(reply.as_value())?)?;
        self.can_charge(role, cost)?;
        let id = id.to_owned();
        self.charge(role, cost);
        self.sequence = sequence;
        self.leases.insert(
            id,
            LeaseRecord {
                request,
                reply: reply.clone(),
                deadline,
                consumed: false,
                role,
            },
        );
        Ok(reply)
    }
}
