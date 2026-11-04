//! Explicit next-workflow admission; historical records and all quotas are retained.
use super::*;
pub(super) const METADATA_BYTES: usize = 1024;
impl RegistryModel {
    pub(super) fn workflow_record(
        &self,
        t: &WorkflowTicket,
    ) -> Result<&WorkflowRecord, ModelError> {
        require(
            Arc::ptr_eq(&t.identity, &self.identity),
            ModelError::Forbidden,
        )?;
        self.workflow
            .as_ref()
            .and_then(|m| m.records.get(&t.change_id))
            .filter(|w| w.sequence == t.sequence)
            .ok_or(ModelError::InvalidInput)
    }
    fn workflow_ticket(&self, w: &WorkflowRecord) -> WorkflowTicket {
        WorkflowTicket {
            identity: self.identity.clone(),
            sequence: w.sequence,
            change_id: w.change.as_value()["changeId"]
                .as_str()
                .expect("validated change ID")
                .to_owned(),
        }
    }
    pub fn reserve_workflow(
        &mut self,
        session: &ModelSession,
        change: RecordingChangeRequest,
    ) -> Result<WorkflowTicket, ModelError> {
        self.qualify(session)?;
        require(
            self.context_matches(&change.as_value()["context"]),
            ModelError::Forbidden,
        )?;
        let mode = self.workflow.as_ref().ok_or(ModelError::InvalidInput)?;
        let id = change.as_value()["changeId"]
            .as_str()
            .expect("validated change ID");
        if let Some(w) = mode.records.get(id) {
            require(
                w.creation == Creation::Initial
                    && same_value(w.change.as_value(), change.as_value()),
                ModelError::ProtocolViolation,
            )?;
            return Ok(self.workflow_ticket(w));
        }
        require(mode.current.is_none(), ModelError::Busy)?;
        let qualification = mode.qualification;
        self.workflow_gate()?;
        self.prepare_and_commit_workflow(change, Creation::Initial, qualification)
    }
    pub fn reserve_next_workflow(
        &mut self,
        session: &ModelSession,
        predecessor: &WorkflowTicket,
        qualification: SimulatedRunQualification,
        change: RecordingChangeRequest,
    ) -> Result<WorkflowTicket, ModelError> {
        self.qualify(session)?;
        require(
            self.context_matches(&change.as_value()["context"]),
            ModelError::Forbidden,
        )?;
        self.workflow_record(predecessor)?;
        let mode = self.workflow.as_ref().expect("qualified workflow mode");
        let creation = Creation::Renewal {
            predecessor: predecessor.sequence,
        };
        let id = change.as_value()["changeId"]
            .as_str()
            .expect("validated change ID");
        if let Some(w) = mode.records.get(id) {
            require(
                w.creation == creation
                    && w.qualification == qualification
                    && same_value(w.change.as_value(), change.as_value()),
                ModelError::ProtocolViolation,
            )?;
            return Ok(self.workflow_ticket(w));
        }
        require(
            mode.current.as_deref() == Some(predecessor.change_id.as_str()),
            ModelError::Busy,
        )?;
        self.renewal_gate()?;
        self.prepare_and_commit_workflow(change, creation, qualification)
    }
    fn prepare_and_commit_workflow(
        &mut self,
        change: RecordingChangeRequest,
        creation: Creation,
        qualification: SimulatedRunQualification,
    ) -> Result<WorkflowTicket, ModelError> {
        let mode = self.workflow.as_ref().ok_or(ModelError::InvalidInput)?;
        require(
            qualification != SimulatedRunQualification::Unqualified
                && (!mode.ever_clean_joined
                    || qualification == SimulatedRunQualification::CleanJoined),
            ModelError::Forbidden,
        )?;
        require(
            mode.records.len() < self.limits.workflow_changes
                && self.workflow_used_ids() + self.workflow_reserved_ids() + 4
                    <= self.limits.mutation_admissions
                && self
                    .leases
                    .values()
                    .filter(|l| l.role == Role::Mutation)
                    .count()
                    + self.workflow_reserved_ids()
                    + 4
                    <= self.limits.mutation_leases
                && self.workflow_caller_ids() + self.workflow_reserved_caller_ids() + 2
                    <= self.limits.caller_operation_ids
                && self.workflow_native_ids() + self.workflow_reserved_native_ids() + 4
                    <= self.limits.simulated_native_identities,
            ModelError::Capacity,
        )?;
        let (slots, projection) = self.workflow_reservations(&change)?;
        let cost = slots
            .iter()
            .try_fold(sum(bytes(change.as_value())?, METADATA_BYTES)?, |n, s| {
                sum(n, s.bytes()?)
            })?;
        self.can_charge(Role::Mutation, cost)?;
        self.can_reserve_revisions(11)?;
        let sequence = self.sequence.checked_add(1).ok_or(ModelError::Capacity)?;
        let id = change.as_value()["changeId"]
            .as_str()
            .expect("validated change ID")
            .to_owned();
        let ticket = WorkflowTicket {
            identity: self.identity.clone(),
            sequence,
            change_id: id.clone(),
        };
        let record = WorkflowRecord {
            sequence,
            change,
            slots: slots.map(Some),
            attempts: BTreeMap::new(),
            current_attempt: None,
            creation,
            qualification,
            native: BTreeSet::new(),
            native_reserved: 4,
            released: false,
        };
        // All fallible checks precede this commit. Renewal does not publish a snapshot.
        self.sequence = sequence;
        self.charge(Role::Mutation, cost);
        self.projection.reserved += 11;
        self.projection.budget = projection;
        let mode = self.workflow.as_mut().expect("planned mode");
        mode.ever_clean_joined |= qualification == SimulatedRunQualification::CleanJoined;
        mode.records.insert(id.clone(), record);
        mode.current = Some(id);
        Ok(ticket)
    }
    fn renewal_gate(&self) -> Result<(), ModelError> {
        self.workflow_gate()?;
        require(
            matches!(
                self.workflow_phase(),
                Some(WorkflowPhase::Completed | WorkflowPhase::Discarded)
            ),
            ModelError::Busy,
        )?;
        require(
            self.admissions.values().all(|r| r.proof.is_some()),
            ModelError::Busy,
        )?;
        for h in self.handles.values() {
            match &h.completion {
                Some(SimulatedCompletion::Operation(r)) => require(
                    r.as_value()["quiescence"] == "confirmed"
                        && r.as_value()["recoveryRequired"] == false,
                    ModelError::Busy,
                )?,
                Some(SimulatedCompletion::Reconciliation(d)) => require(
                    d.as_value()["outcome"]["kind"] == "result",
                    ModelError::Busy,
                )?,
                None => return Err(ModelError::Busy),
            }
        }
        require(
            !self.observations.values().any(|o| o.pending)
                && self.cancels.values().all(|c| c.terminal),
            ModelError::Busy,
        )
    }
    pub(in super::super) fn workflow_read_plan(
        &self,
        q: &RecordingAdmissionRequest,
    ) -> Result<(), ModelError> {
        let Some(mode) = &self.workflow else {
            return Ok(());
        };
        let w = mode.current_record().ok_or(ModelError::ProtocolViolation)?;
        let a = &q.as_value()["action"];
        let reference = a["operationRef"]
            .as_str()
            .ok_or(ModelError::ProtocolViolation)?;
        let h = self
            .handles
            .get(&(Role::Mutation, reference.to_owned()))
            .ok_or(ModelError::ProtocolViolation)?;
        require(
            w.attempts
                .get(&h.admission_id)
                .is_some_and(|a| a.stage == WorkflowAction::Apply)
                && same_value(self.handle_request(h), &a["reconciliation"]["operation"])
                && self.workflow_record_change_ref(w).as_ref()
                    == a["changeRef"].as_str().map(str::to_owned).as_ref(),
            ModelError::ProtocolViolation,
        )
    }
}
