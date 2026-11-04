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
        let max = "r".repeat(64);
        let operation = json!({"version":1,"kind":"recordingOperationRequest","operationId":max,"stage":stage.name(),"change":change.as_value()});
        let action = match stage {
            WorkflowAction::Preflight => json!({"kind":"preflight","change":change.as_value()}),
            WorkflowAction::Discard => {
                json!({"kind":"discard","changeRef":max,"change":change.as_value()})
            }
            _ => json!({"kind":stage.name(),"changeRef":max,"operation":operation}),
        };
        // Budget templates only. These strings never become authoritative handles or issued leases.
        let q=RecordingAdmissionRequest::from_value(json!({"version":1,"kind":"recordingAdmissionRequest","ownerRef":self.session.scope["ownerRef"],"admissionId":max,"context":self.session.context.as_value(),"deadlineLeaseRef":max,"action":action})).map_err(|_|ModelError::Capacity)?;
        let lease = json!({"version":1,"kind":"recordingWireLeaseRequest","scope":self.session.scope,"leaseRequestId":max,"admissionId":max,"role":"mutation","requestedBudgetMs":1});
        let issued = json!({"version":1,"kind":"recordingWireLeaseReply","request":lease,"outcome":{"kind":"issued","deadlineLeaseRef":max,"grantedBudgetMs":1}});
        let lease_bytes = sum(bytes(&lease)?, bytes(&issued)?)?;
        Ok((
            StageReservation {
                storage: LifetimeBudget::for_request(&q)?,
                lease_bytes,
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
