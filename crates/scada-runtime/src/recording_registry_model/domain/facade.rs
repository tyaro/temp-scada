//! Typed access only: no mutable model export or independent clock.
use super::*;
use scada_model::recording_operations::RecordingChangeRequest;
/// Borrowed model access cannot be replaced by a new model:
/// ```compile_fail
/// use scada_runtime::recording_registry_model::{DomainScope, RegistryModel};
/// fn replace(mut scope: DomainScope<'_>, replacement: RegistryModel) {
///     *scope = replacement;
/// }
/// ```
/// Time belongs to the domain, so a scope cannot advance its own clock:
/// ```compile_fail
/// use scada_runtime::recording_registry_model::{DomainScope, ModelInstant};
/// fn advance(mut scope: DomainScope<'_>) { scope.advance_to(ModelInstant(1)); }
/// ```
#[derive(Debug)]
pub struct DomainScope<'a> {
    pub(super) model: &'a mut RegistryModel,
}
impl<'a> DomainScope<'a> {
    #[cfg(test)]
    pub(in super::super) fn unpooled(model: &'a mut RegistryModel) -> Self {
        Self { model }
    }
    pub fn now(&self) -> ModelInstant {
        self.model.now()
    }
    pub fn close(&mut self) -> Result<(), ModelError> {
        self.model.close()
    }
    pub fn stats(&self) -> ModelStats {
        self.model.stats()
    }
    pub fn issue_lease(
        &mut self,
        session: &ModelSession,
        request: RecordingWireLeaseRequest,
    ) -> Result<RecordingWireLeaseReply, ModelError> {
        self.model.issue_lease(session, request)
    }
    pub fn begin_admission(
        &mut self,
        session: &ModelSession,
        request: RecordingAdmissionRequest,
    ) -> Result<AdmissionStart, ModelError> {
        self.model.begin_admission(session, request)
    }
    pub fn observe_native(
        &mut self,
        ticket: &SimulationTicket,
        decision: SimulatedDecision,
    ) -> Result<(), ModelError> {
        self.model.observe_native(ticket, decision)
    }
    pub fn finish_admission_call(
        &mut self,
        ticket: &SimulationTicket,
        reply: RecordingAdmissionReply,
    ) -> Result<(), ModelError> {
        self.model.finish_admission_call(ticket, reply)
    }
    pub fn accepted_handle(
        &self,
        admission: &SimulationTicket,
    ) -> Result<SimulatedHandleTicket, ModelError> {
        self.model.accepted_handle(admission)
    }
    pub fn complete_handle(
        &mut self,
        handle: &SimulatedHandleTicket,
        completion: SimulatedCompletion,
    ) -> Result<(), ModelError> {
        self.model.complete_handle(handle, completion)
    }
    pub fn observe_result(
        &mut self,
        session: &ModelSession,
        request: RecordingWireObservationRequest,
    ) -> Result<RecordingWireObservationReply, ModelError> {
        self.model.observe_result(session, request)
    }
    pub fn begin_cancel(
        &mut self,
        session: &ModelSession,
        request: RecordingWireCancelRequest,
    ) -> Result<CancelStart, ModelError> {
        self.model.begin_cancel(session, request)
    }
    pub fn notify_cancel(
        &mut self,
        ticket: &ModelCancelTicket,
    ) -> Result<RecordingWireCancelReply, ModelError> {
        self.model.notify_cancel(ticket)
    }
    pub fn finish_cancel_call(
        &mut self,
        ticket: &ModelCancelTicket,
    ) -> Result<RecordingWireCancelReply, ModelError> {
        self.model.finish_cancel_call(ticket)
    }
    pub fn inspect_admission(
        &mut self,
        session: &ModelSession,
        request: RecordingAdmissionInspectionRequest,
    ) -> Result<RecordingAdmissionInspectionReply, ModelError> {
        self.model.inspect_admission(session, request)
    }
    pub fn inspect_call(
        &mut self,
        session: &ModelSession,
        request: RecordingWireCallInspectionRequest,
    ) -> Result<RecordingWireCallInspectionReply, ModelError> {
        self.model.inspect_call(session, request)
    }
    pub fn attach(
        &mut self,
        session: &ModelSession,
        request: RecordingWireAttachRequest,
    ) -> Result<RecordingWireAttachReply, ModelError> {
        self.model.attach(session, request)
    }
    pub fn control(
        &mut self,
        session: &ModelSession,
        request: RecordingWireControlRequest,
    ) -> Result<RecordingWireControlReply, ModelError> {
        self.model.control(session, request)
    }
    pub fn take_state_frame(
        &mut self,
        session: &ModelSession,
        reference: &str,
    ) -> Result<Option<RecordingWireStateFrame>, ModelError> {
        self.model.take_state_frame(session, reference)
    }
    pub fn take_control_frame(
        &mut self,
        session: &ModelSession,
        reference: &str,
    ) -> Result<Option<RecordingWireControlFrame>, ModelError> {
        self.model.take_control_frame(session, reference)
    }
    pub fn owner_snapshot(&self, session: &ModelSession) -> Result<Value, ModelError> {
        self.model.owner_snapshot(session)
    }
    pub fn issue_workflow_lease(
        &mut self,
        t: &WorkflowTicket,
        stage: WorkflowAction,
        ids: WorkflowAttemptIds,
        request: RecordingWireLeaseRequest,
    ) -> Result<RecordingWireLeaseReply, ModelError> {
        self.model.issue_workflow_lease(t, stage, ids, request)
    }
    pub fn begin_workflow_admission(
        &mut self,
        t: &WorkflowTicket,
        request: RecordingAdmissionRequest,
    ) -> Result<AdmissionStart, ModelError> {
        self.model.begin_workflow_admission(t, request)
    }
    pub fn reserve_workflow(
        &mut self,
        session: &ModelSession,
        change: RecordingChangeRequest,
    ) -> Result<WorkflowTicket, ModelError> {
        self.model.reserve_workflow(session, change)
    }
    pub fn reserve_next_workflow(
        &mut self,
        session: &ModelSession,
        predecessor: &WorkflowTicket,
        qualification: SimulatedRunQualification,
        change: RecordingChangeRequest,
    ) -> Result<WorkflowTicket, ModelError> {
        self.model
            .reserve_next_workflow(session, predecessor, qualification, change)
    }
    pub fn workflow_phase(&self) -> Option<WorkflowPhase> {
        self.model.workflow_phase()
    }
}
