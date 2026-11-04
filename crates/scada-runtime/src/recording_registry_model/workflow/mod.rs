//! Explicit simulation-only workflow. No dispatch, reset or mode switching.
use super::*;
mod escrow;
mod renewal;
mod state;
use projection::ProjectionBudget;
use scada_model::recording_operations::RecordingChangeRequest;
use std::collections::BTreeSet;
#[derive(Debug)]
pub(super) struct WorkflowMode {
    pub qualification: SimulatedRunQualification,
    pub records: BTreeMap<String, WorkflowRecord>,
    pub current: Option<String>,
    pub ever_clean_joined: bool,
}
#[derive(Debug)]
pub(super) struct WorkflowRecord {
    sequence: u64,
    change: RecordingChangeRequest,
    slots: [Option<StageReservation>; 4],
    attempts: BTreeMap<String, Attempt>,
    current_attempt: Option<String>,
    creation: Creation,
    qualification: SimulatedRunQualification,
    native: BTreeSet<(bool, String)>,
    native_reserved: usize,
    released: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Creation {
    Initial,
    Renewal { predecessor: u64 },
}
impl WorkflowMode {
    fn current_record(&self) -> Option<&WorkflowRecord> {
        self.current.as_ref().and_then(|id| self.records.get(id))
    }
    fn current_record_mut(&mut self) -> Option<&mut WorkflowRecord> {
        self.current
            .as_ref()
            .and_then(|id| self.records.get_mut(id))
    }
    fn owner(&self, id: &str) -> Option<&WorkflowRecord> {
        self.records.values().find(|r| r.attempts.contains_key(id))
    }
    fn owner_mut(&mut self, id: &str) -> Option<&mut WorkflowRecord> {
        self.records
            .values_mut()
            .find(|r| r.attempts.contains_key(id))
    }
}
#[derive(Clone, Copy, Debug)]
struct StageReservation {
    storage: LifetimeBudget,
    lease_bytes: usize,
    stage: WorkflowAction,
}
impl StageReservation {
    fn bytes(self) -> Result<usize, ModelError> {
        sum(self.storage.bytes()?, self.lease_bytes)
    }
}
#[derive(Debug)]
struct Attempt {
    stage: WorkflowAction,
    operation_id: Option<String>,
    lease_id: String,
    prior: WorkflowPhase,
    reservation: StageReservation,
}
impl RegistryModel {
    pub fn new_workflow(
        session: ModelSession,
        limits: ModelLimits,
        qualification: SimulatedRunQualification,
    ) -> Result<Self, ModelError> {
        let mut model = Self::new(session, limits)?;
        model.workflow = Some(WorkflowMode {
            qualification,
            records: BTreeMap::new(),
            current: None,
            ever_clean_joined: qualification == SimulatedRunQualification::CleanJoined,
        });
        Ok(model)
    }
    pub fn issue_workflow_lease(
        &mut self,
        t: &WorkflowTicket,
        stage: WorkflowAction,
        ids: WorkflowAttemptIds,
        request: RecordingWireLeaseRequest,
    ) -> Result<RecordingWireLeaseReply, ModelError> {
        let w = self.workflow_record(t)?;
        let q = request.as_value();
        require(self.scope_matches(&q["scope"]), ModelError::Forbidden)?;
        require(q["role"] == "mutation", ModelError::Forbidden)?;
        require(
            ids.operation_id.as_deref().is_none_or(types::valid_id)
                && ids.operation_id.is_some() == stage.caller(),
            ModelError::InvalidInput,
        )?;
        let lease_id = q["leaseRequestId"].as_str().expect("validated lease ID");
        let id = q["admissionId"].as_str().expect("validated admission ID");
        if let Some(a) = w.attempts.get(id) {
            require(
                a.stage == stage && a.operation_id == ids.operation_id && a.lease_id == lease_id,
                ModelError::ProtocolViolation,
            )?;
            let s = self.session.clone();
            return self.issue_lease_inner(&s, request, true);
        }
        require(
            self.workflow.as_ref().and_then(|m| m.current.as_deref()) == Some(t.change_id.as_str()),
            ModelError::Busy,
        )?;
        self.workflow_gate()?;
        let prior = self.workflow_phase().ok_or(ModelError::InvalidInput)?;
        require(state::allows(prior, stage), ModelError::Busy)?;
        if let Some(current) = w.current_attempt.as_ref().and_then(|id| w.attempts.get(id)) {
            if !self
                .admissions
                .contains_key(w.current_attempt.as_ref().expect("current"))
            {
                let lease = &self.leases[&current.lease_id];
                require(self.now.0 >= lease.deadline, ModelError::Busy)?;
            }
        }
        require(
            !self.leases.contains_key(lease_id) && !self.admissions.contains_key(id),
            ModelError::ProtocolViolation,
        )?;
        if let Some(op) = &ids.operation_id {
            require(
                !self
                    .workflow
                    .as_ref()
                    .expect("workflow mode")
                    .records
                    .values()
                    .any(|r| {
                        r.attempts
                            .values()
                            .any(|a| a.operation_id.as_ref() == Some(op))
                    }),
                ModelError::ProtocolViolation,
            )?;
        }
        let first = w.slots[stage.index()];
        let reservation = if let Some(r) = first {
            r
        } else {
            self.workflow_stage_reservation(&w.change, stage)?.0
        };
        if first.is_none() {
            require(
                self.workflow_used_ids() + self.workflow_reserved_ids()
                    < self.limits.mutation_admissions
                    && self
                        .leases
                        .values()
                        .filter(|l| l.role == Role::Mutation)
                        .count()
                        + self.workflow_reserved_ids()
                        < self.limits.mutation_leases,
                ModelError::Capacity,
            )?;
            if stage.caller() {
                require(
                    self.workflow_caller_ids() + self.workflow_reserved_caller_ids()
                        < self.limits.caller_operation_ids,
                    ModelError::Capacity,
                )?;
            }
            self.can_charge(Role::Mutation, reservation.bytes()?)?;
            self.can_reserve_revisions(stage.credits() as u64)?;
        }
        let id = id.to_owned();
        let lease_id = lease_id.to_owned();
        let s = self.session.clone();
        // The ordinary lease plan validates every failure before mutating. Its payload is prepaid.
        let reply = self.issue_lease_inner(&s, request, true)?;
        if first.is_none() {
            self.charge(Role::Mutation, reservation.bytes()?);
            self.projection.reserved += stage.credits() as u64;
        }
        let w = self
            .workflow
            .as_mut()
            .and_then(WorkflowMode::current_record_mut)
            .expect("qualified workflow");
        w.slots[stage.index()] = None;
        w.attempts.insert(
            id.clone(),
            Attempt {
                stage,
                operation_id: ids.operation_id,
                lease_id,
                prior,
                reservation,
            },
        );
        w.current_attempt = Some(id);
        Ok(reply)
    }
    pub fn begin_workflow_admission(
        &mut self,
        t: &WorkflowTicket,
        request: RecordingAdmissionRequest,
    ) -> Result<AdmissionStart, ModelError> {
        let w = self.workflow_record(t)?;
        let id = request.as_value()["admissionId"]
            .as_str()
            .expect("validated admission ID");
        if !self.admissions.contains_key(id) {
            require(
                self.workflow.as_ref().and_then(|m| m.current.as_deref())
                    == Some(t.change_id.as_str()),
                ModelError::Busy,
            )?;
        }
        require(w.attempts.contains_key(id), ModelError::ProtocolViolation)?;
        let s = self.session.clone();
        self.begin_admission_inner(&s, request, true)
    }
    pub(super) fn workflow_admission_plan(
        &self,
        q: &RecordingAdmissionRequest,
    ) -> Result<(LifetimeBudget, u8), ModelError> {
        let v = q.as_value();
        let w = self
            .workflow
            .as_ref()
            .and_then(WorkflowMode::current_record)
            .ok_or(ModelError::InvalidInput)?;
        let id = v["admissionId"].as_str().expect("validated ID");
        let a = w.attempts.get(id).ok_or(ModelError::InvalidInput)?;
        self.workflow_gate()?;
        require(
            w.current_attempt.as_deref() == Some(id)
                && state::allows(self.workflow_phase().expect("mode"), a.stage),
            ModelError::Busy,
        )?;
        require(
            WorkflowAction::from_value(&v["action"]["kind"])? == a.stage,
            ModelError::ProtocolViolation,
        )?;
        let action = &v["action"];
        let change = if a.stage.caller() {
            &action["operation"]["change"]
        } else {
            &action["change"]
        };
        require(
            same_value(change, w.change.as_value()),
            ModelError::ProtocolViolation,
        )?;
        if a.stage.caller() {
            require(
                action["operation"]["operationId"].as_str() == a.operation_id.as_deref(),
                ModelError::ProtocolViolation,
            )?;
        }
        if a.stage != WorkflowAction::Preflight {
            require(
                self.workflow_change_ref().as_ref()
                    == action["changeRef"].as_str().map(|s| s.to_owned()).as_ref(),
                ModelError::ProtocolViolation,
            )?;
        }
        a.reservation.storage.check_request(v)?;
        Ok((a.reservation.storage, a.stage.credits()))
    }
    pub(super) fn workflow_proof_plan(
        &self,
        t: &SimulationTicket,
        reply: &RecordingAdmissionReply,
    ) -> Result<Vec<(bool, String)>, ModelError> {
        if admission_role(&reply.as_value()["request"]) == Role::Read {
            self.workflow_read_plan(&self.record(t)?.request)?;
            return Ok(vec![]);
        }
        let Some(w) = self
            .workflow
            .as_ref()
            .and_then(|m| m.owner(&t.admission_id))
        else {
            return Ok(vec![]);
        };
        let Some(a) = w.attempts.get(&t.admission_id) else {
            return Ok(vec![]);
        };
        if reply.as_value()["outcome"]["kind"] != "accepted" {
            return Ok(vec![]);
        }
        let handle = &reply.as_value()["outcome"]["handle"];
        if a.stage != WorkflowAction::Preflight {
            require(
                self.workflow_record_change_ref(w).as_ref()
                    == handle["changeRef"].as_str().map(|s| s.to_owned()).as_ref(),
                ModelError::ProtocolViolation,
            )?;
        }
        let mut keys = vec![(
            true,
            handle["request"]["operationId"]
                .as_str()
                .expect("operation ID")
                .to_owned(),
        )];
        if a.stage == WorkflowAction::Preflight {
            let reference = &handle["changeRef"];
            require(
                !self.admissions.values().any(|r| {
                    r.request.as_value()["action"]["kind"] == "preflight"
                        && r.proof.as_ref().is_some_and(|p| {
                            p.as_value()["outcome"]["kind"] == "accepted"
                                && p.as_value()["outcome"]["handle"]["changeRef"] == *reference
                        })
                }),
                ModelError::ProtocolViolation,
            )?;
            keys.push((false, t.change_id(self)?.to_owned()));
        }
        require(
            w.native_reserved >= keys.len()
                && self.workflow_native_ids() + keys.len()
                    <= self.limits.simulated_native_identities,
            ModelError::Capacity,
        )?;
        let operation_id = &keys[0].1;
        require(
            !self
                .workflow
                .as_ref()
                .expect("mode")
                .records
                .values()
                .any(|r| {
                    r.attempts.iter().any(|(id, a)| {
                        id != &t.admission_id && a.operation_id.as_ref() == Some(operation_id)
                    })
                }),
            ModelError::ProtocolViolation,
        )?;
        require(
            keys.iter().all(|k| {
                !self
                    .workflow
                    .as_ref()
                    .expect("mode")
                    .records
                    .values()
                    .any(|r| r.native.contains(k))
            }),
            ModelError::ProtocolViolation,
        )?;
        Ok(keys)
    }
    pub(super) fn workflow_completion_plan(&self, id: &str, v: &Value) -> Result<(), ModelError> {
        let Some(a) = self
            .workflow
            .as_ref()
            .and_then(|m| m.owner(id))
            .and_then(|w| w.attempts.get(id))
        else {
            return Ok(());
        };
        let outcome = &v["outcome"];
        if a.stage == WorkflowAction::PauseJoin && outcome["kind"] == "paused" {
            require(
                outcome["sessionId"] == self.session.context.as_value()["sessionId"],
                ModelError::ProtocolViolation,
            )?;
        }
        if a.stage == WorkflowAction::Preflight
            && outcome["kind"] == "candidate"
            && !outcome["activeSessionId"].is_null()
        {
            require(
                outcome["activeSessionId"] == self.session.context.as_value()["sessionId"],
                ModelError::ProtocolViolation,
            )?;
        }
        Ok(())
    }
    pub(super) fn commit_workflow_proof(
        &mut self,
        ticket: &SimulationTicket,
        keys: Vec<(bool, String)>,
    ) {
        if keys.is_empty() {
            return;
        }
        let w = self
            .workflow
            .as_mut()
            .and_then(|m| m.owner_mut(&ticket.admission_id))
            .expect("planned workflow");
        w.native_reserved -= keys.len();
        w.native.extend(keys);
    }
}
impl SimulationTicket {
    fn change_id<'a>(&self, m: &'a RegistryModel) -> Result<&'a str, ModelError> {
        Ok(
            m.record(self)?.request.as_value()["action"]["change"]["changeId"]
                .as_str()
                .expect("preflight change"),
        )
    }
}
