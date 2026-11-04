use super::*;
pub(super) fn allows(p: WorkflowPhase, a: WorkflowAction) -> bool {
    matches!(
        (p, a),
        (WorkflowPhase::Reserved, WorkflowAction::Preflight)
            | (
                WorkflowPhase::Candidate,
                WorkflowAction::PauseJoin | WorkflowAction::Discard
            )
            | (
                WorkflowPhase::Paused,
                WorkflowAction::Apply | WorkflowAction::Discard
            )
    )
}
fn progress(a: WorkflowAction) -> WorkflowPhase {
    match a {
        WorkflowAction::Preflight => WorkflowPhase::Preflighting,
        WorkflowAction::PauseJoin => WorkflowPhase::Pausing,
        WorkflowAction::Apply => WorkflowPhase::Applying,
        WorkflowAction::Discard => WorkflowPhase::Discarding,
    }
}
impl RegistryModel {
    pub fn workflow_phase(&self) -> Option<WorkflowPhase> {
        let mode = self.workflow.as_ref()?;
        let Some(w) = mode.current_record() else {
            return Some(WorkflowPhase::Reserved);
        };
        let attempt = w.current_attempt.as_ref().and_then(|id| w.attempts.get(id));
        let record = w
            .current_attempt
            .as_ref()
            .and_then(|id| self.admissions.get(id));
        let completion = record
            .and_then(|r| r.proof.as_ref())
            .filter(|p| p.as_value()["outcome"]["kind"] == "accepted")
            .and_then(|p| {
                self.handles
                    .get(&handle::ref_key(&p.as_value()["outcome"]["handle"]))
            })
            .and_then(|h| h.completion.as_ref())
            .map(|c| match c {
                SimulatedCompletion::Operation(v) => v.as_value(),
                SimulatedCompletion::Reconciliation(v) => v.as_value(),
            });
        if self.closed || self.clock_fault {
            return Some(WorkflowPhase::Blocked);
        }
        if self.recovery_required {
            return Some(
                if record.is_some_and(|r| r.terminal.is_some())
                    && completion.is_some_and(|v| v["quiescence"] == "unknown")
                {
                    WorkflowPhase::Uncertain
                } else {
                    WorkflowPhase::Blocked
                },
            );
        }
        let Some(a) = attempt else {
            return Some(WorkflowPhase::Reserved);
        };
        let Some(r) = record else {
            return Some(a.prior);
        };
        if r.terminal.is_none() {
            return Some(progress(a.stage));
        }
        let Some(p) = &r.proof else {
            return Some(WorkflowPhase::Uncertain);
        };
        match p.as_value()["outcome"]["kind"]
            .as_str()
            .expect("validated outcome")
        {
            "rejected" => Some(a.prior),
            "completedDiscard" => Some(WorkflowPhase::Discarded),
            "accepted" => Some(if let Some(v) = completion {
                match v["outcome"]["kind"].as_str() {
                    Some("candidate") => WorkflowPhase::Candidate,
                    Some("paused") => WorkflowPhase::Paused,
                    _ => WorkflowPhase::Completed,
                }
            } else {
                progress(a.stage)
            }),
            _ => unreachable!("proof kind"),
        }
    }
    pub(in super::super) fn workflow_gate(&self) -> Result<(), ModelError> {
        self.new_effect()?;
        require(!self.recovery_required, ModelError::Busy)?;
        require(
            !self.admissions.values().any(|r| r.terminal.is_none()),
            ModelError::Busy,
        )?;
        for r in self.admissions.values().filter(|r| r.role == Role::Read) {
            let Some(p) = &r.proof else {
                return Err(ModelError::Busy);
            };
            if p.as_value()["outcome"]["kind"] == "accepted" {
                let key = handle::ref_key(&p.as_value()["outcome"]["handle"]);
                require(
                    self.handles
                        .get(&key)
                        .is_some_and(|h| h.completion.is_some()),
                    ModelError::Busy,
                )?;
            }
        }
        require(
            !self
                .observations
                .values()
                .any(|o| o.role == Role::Read && o.pending),
            ModelError::Busy,
        )
    }
    pub(in super::super) fn workflow_change_ref(&self) -> Option<String> {
        let w = self.workflow.as_ref()?.current_record()?;
        self.workflow_record_change_ref(w)
    }
    pub(super) fn workflow_record_change_ref(&self, w: &WorkflowRecord) -> Option<String> {
        w.attempts
            .iter()
            .filter(|(_, a)| a.stage == WorkflowAction::Preflight)
            .find_map(|(id, _)| {
                self.admissions
                    .get(id)
                    .and_then(|r| r.proof.as_ref())
                    .filter(|p| p.as_value()["outcome"]["kind"] == "accepted")
                    .and_then(|p| {
                        p.as_value()["outcome"]["handle"]["changeRef"]
                            .as_str()
                            .map(str::to_owned)
                    })
            })
    }
    pub(in super::super) fn workflow_used_ids(&self) -> usize {
        self.workflow.as_ref().map_or_else(
            || {
                self.admissions
                    .values()
                    .filter(|r| r.role == Role::Mutation)
                    .count()
            },
            |m| m.records.values().map(|w| w.attempts.len()).sum(),
        )
    }
    pub(in super::super) fn workflow_reserved_ids(&self) -> usize {
        self.workflow.as_ref().map_or(0, |m| {
            m.records
                .values()
                .map(|w| w.slots.iter().flatten().count())
                .sum()
        })
    }
    pub(in super::super) fn workflow_caller_ids(&self) -> usize {
        self.workflow.as_ref().map_or(0, |m| {
            m.records
                .values()
                .map(|w| {
                    w.attempts
                        .values()
                        .filter(|a| a.operation_id.is_some())
                        .count()
                })
                .sum()
        })
    }
    pub(in super::super) fn workflow_reserved_caller_ids(&self) -> usize {
        self.workflow.as_ref().map_or(0, |m| {
            m.records
                .values()
                .map(|w| {
                    w.slots
                        .iter()
                        .flatten()
                        .filter(|r| r.stage.caller())
                        .count()
                })
                .sum()
        })
    }
    pub(in super::super) fn workflow_native_ids(&self) -> usize {
        self.workflow
            .as_ref()
            .map_or(0, |m| m.records.values().map(|w| w.native.len()).sum())
    }
    pub(in super::super) fn workflow_reserved_native_ids(&self) -> usize {
        self.workflow
            .as_ref()
            .map_or(0, |m| m.records.values().map(|w| w.native_reserved).sum())
    }
}
