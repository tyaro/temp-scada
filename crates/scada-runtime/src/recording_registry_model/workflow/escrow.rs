use super::*;
impl RegistryModel {
    pub(in super::super) fn can_reserve_revisions(&self, n: u64) -> Result<(), ModelError> {
        require(
            self.projection
                .reserved
                .checked_add(n)
                .and_then(|r| r.checked_add(self.projection.current.revision))
                .is_some_and(|r| r <= self.limits.revision_ceiling),
            ModelError::Capacity,
        )
    }
    pub(super) fn workflow_reservations(
        &self,
        change: &RecordingChangeRequest,
    ) -> Result<([StageReservation; 4], ProjectionBudget), ModelError> {
        let mut budget = self.projection.budget;
        let mut all = Vec::new();
        for stage in [
            WorkflowAction::Preflight,
            WorkflowAction::PauseJoin,
            WorkflowAction::Apply,
            WorkflowAction::Discard,
        ] {
            let (r, q) = self.workflow_stage_reservation(change, stage)?;
            budget = self.projection_for(&q, budget)?;
            all.push(r);
        }
        Ok((all.try_into().expect("four stages"), budget))
    }
    pub(super) fn workflow_stage_reservation(
        &self,
        change: &RecordingChangeRequest,
        stage: WorkflowAction,
    ) -> Result<(StageReservation, RecordingAdmissionRequest), ModelError> {
        // Shared pure templates; neither the IDs nor the bounds are native authority.
        let (budget, q) = crate::recording_registry::kernel::workflow::stage(
            change,
            &self.session.scope,
            stage.name(),
        )?;
        Ok((
            StageReservation {
                storage: budget.storage,
                lease_bytes: budget.lease_bytes,
                stage,
            },
            q,
        ))
    }
    pub(in super::super) fn refresh_workflow(&mut self) {
        if !matches!(
            self.workflow_phase(),
            Some(WorkflowPhase::Completed | WorkflowPhase::Discarded)
        ) {
            return;
        }
        let Some(w) = self
            .workflow
            .as_mut()
            .and_then(WorkflowMode::current_record_mut)
        else {
            return;
        };
        if w.released {
            return;
        }
        let mut refund = 0;
        let mut revisions = 0;
        for slot in &mut w.slots {
            if let Some(r) = slot.take() {
                refund += r.bytes().expect("previously checked reservation");
                revisions += r.stage.credits() as u64;
            }
        }
        w.native_reserved = 0;
        w.released = true;
        self.mutation_bytes -= refund;
        self.projection.reserved -= revisions;
    }
}
