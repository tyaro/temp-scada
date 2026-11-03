//! Same-store diagnostic reader and explicit, caller-resolved managed resume.
use super::*;
use banto_tagclient::GenerationSnapshot;
use scada_historian::{
    recorder::{RecorderConfig, SystemRecorderClock},
    store::{
        query::{CancellationToken, HistoryReader, QueryError},
        recording_plan::RecordingResumeState,
        SessionSpec, StoreResult,
    },
};
use std::fmt;
use tokio::task::JoinHandle;

#[derive(Clone)]
pub struct ResumeInspectionRun(Arc<()>);
impl PartialEq for ResumeInspectionRun {
    fn eq(&self, o: &Self) -> bool {
        Arc::ptr_eq(&self.0, &o.0)
    }
}
impl Eq for ResumeInspectionRun {}
impl fmt::Debug for ResumeInspectionRun {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ResumeInspectionRun(..)")
    }
}
#[derive(Clone)]
pub struct ResumeTicket(Arc<()>);
impl PartialEq for ResumeTicket {
    fn eq(&self, o: &Self) -> bool {
        Arc::ptr_eq(&self.0, &o.0)
    }
}
impl Eq for ResumeTicket {}
impl fmt::Debug for ResumeTicket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ResumeTicket(..)")
    }
}
#[derive(Debug)]
pub struct ResumeInspectionCompletion {
    pub run: ResumeInspectionRun,
    pub recording_run: Option<RecordingRun>,
    pub outcome: StoreResult<RecordingResumeState>,
}
pub struct ResumeResolution {
    pub sdk_snapshot: Arc<GenerationSnapshot>,
    pub session_id: String,
    pub clock_epoch: String,
    pub activation_id: String,
    pub slot_count: Option<u64>,
    pub max_clock_skew_ms: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResumeInspectionPhase {
    Idle,
    InFlight,
    Completed,
}
pub(super) struct InspectionRunning {
    run: ResumeInspectionRun,
    cancel: CancellationToken,
    task: JoinHandle<InspectionResult>,
}
struct InspectionResult {
    reader: HistoryReader,
    completion: ResumeInspectionCompletion,
}
#[derive(Default)]
pub(super) struct ResumeOwner {
    pub running: Option<InspectionRunning>,
    pub completion: Option<Arc<ResumeInspectionCompletion>>,
    prepared: Option<PreparedResume>,
}
struct PreparedResume {
    ticket: ResumeTicket,
    context: Option<RecordingRun>,
    inspection: ResumeInspectionRun,
    plan: SdkRecorderPlan,
    options: RecordingOptions,
    binding: ManagedRecorderStart,
    consumed: bool,
}
impl ResumeOwner {
    pub fn pending(&self) -> bool {
        self.prepared.as_ref().is_some_and(|p| !p.consumed)
    }
    pub fn clear(&mut self) {
        self.completion = None;
        self.prepared = None;
    }
    pub fn phase(&self) -> ResumeInspectionPhase {
        if self.running.is_some() {
            ResumeInspectionPhase::InFlight
        } else if self.completion.is_some() {
            ResumeInspectionPhase::Completed
        } else {
            ResumeInspectionPhase::Idle
        }
    }
    pub fn run(&self) -> Option<ResumeInspectionRun> {
        self.running
            .as_ref()
            .map(|r| r.run.clone())
            .or_else(|| self.completion.as_ref().map(|r| r.run.clone()))
    }
}
impl Drop for ResumeOwner {
    fn drop(&mut self) {
        if let Some(r) = &self.running {
            r.cancel.cancel();
        }
    }
}

impl RecordingSupervisor {
    /// Diagnostics do not clear a latch, change a session, or authorize a restart.
    pub fn start_resume_inspection(
        &mut self,
        control: QueryControl,
    ) -> Result<ResumeInspectionRun, SupervisorError> {
        self.start_inspection_with(control, |reader, c| reader.recording_resume_state(c))
    }
    fn start_inspection_with(
        &mut self,
        control: QueryControl,
        inspect: impl FnOnce(&mut HistoryReader, &QueryControl) -> StoreResult<RecordingResumeState>
            + Send
            + 'static,
    ) -> Result<ResumeInspectionRun, SupervisorError> {
        if self.resume.running.is_some()
            || self.resume.pending()
            || self.preflight.pending_candidate()
            || self.host.plan_turn.running.is_some()
            || self.host.retention.running.is_some()
        {
            return Err(SupervisorError::Busy);
        }
        self.preflight.require_idle()?;
        tokio::runtime::Handle::try_current().map_err(|_| SupervisorError::NoRuntime)?;
        let run = ResumeInspectionRun(Arc::new(()));
        let worker_run = run.clone();
        let recording_run = self.host.state().run.clone();
        let cancel = control.cancellation.clone();
        let mut reader = self.preflight.reader.take().expect("idle shared reader");
        self.resume.clear();
        let task = tokio::task::spawn_blocking(move || {
            let outcome = inspect(&mut reader, &control);
            InspectionResult {
                reader,
                completion: ResumeInspectionCompletion {
                    run: worker_run,
                    recording_run,
                    outcome,
                },
            }
        });
        self.resume.running = Some(InspectionRunning {
            run: run.clone(),
            cancel,
            task,
        });
        Ok(run)
    }
    pub fn cancel_resume_inspection(
        &mut self,
        run: &ResumeInspectionRun,
    ) -> Result<(), SupervisorError> {
        if let Some(r) = &self.resume.running {
            if &r.run != run {
                return Err(SupervisorError::WrongInspection);
            }
            r.cancel.cancel();
            return Ok(());
        }
        self.inspection(run).map(|_| ())
    }
    fn inspection(
        &self,
        run: &ResumeInspectionRun,
    ) -> Result<Arc<ResumeInspectionCompletion>, SupervisorError> {
        self.resume
            .completion
            .as_ref()
            .filter(|c| &c.run == run)
            .cloned()
            .ok_or(SupervisorError::WrongInspection)
    }
    pub async fn join_resume_inspection(
        &mut self,
        run: &ResumeInspectionRun,
    ) -> Result<Arc<ResumeInspectionCompletion>, SupervisorError> {
        let Some(r) = self.resume.running.as_mut() else {
            return self.inspection(run);
        };
        if &r.run != run {
            return Err(SupervisorError::WrongInspection);
        }
        let result = (&mut r.task).await;
        self.resume.running.take();
        match result {
            Ok(result) => {
                self.preflight.reader = Some(result.reader);
                let completion = Arc::new(result.completion);
                self.preflight.unusable |= matches!(
                    &completion.outcome,
                    Err(scada_historian::store::StoreError::Control(
                        QueryError::ReaderUnusable
                    ))
                );
                self.resume.completion = Some(completion.clone());
                Ok(completion)
            }
            Err(_) => {
                self.preflight.faulted = true;
                Err(SupervisorError::ReaderFailed)
            }
        }
    }
    fn require_resume_context(
        &self,
        context: &Option<RecordingRun>,
    ) -> Result<(), SupervisorError> {
        if self.resume.running.is_some() {
            return Err(SupervisorError::Busy);
        }
        self.preflight.require_idle()?;
        if self.preflight.pending_candidate() {
            return Err(SupervisorError::Busy);
        }
        let state = self.host.state();
        if &state.run != context {
            return Err(SupervisorError::ContextMismatch);
        }
        if self.host.writer_busy() {
            return Err(SupervisorError::Host(RecordingHostError::Busy));
        }
        match state.phase {
            RecordingPhase::Idle if context.is_none() => {}
            RecordingPhase::Joined => self.host.require_paused_store()?,
            _ => {
                return Err(SupervisorError::ResumeBlocked(
                    "recording is not idle or cleanly joined",
                ))
            }
        }
        if self.host.plan_turn.recovery_required {
            return Err(RecordingHostError::PlanRecoveryRequired.into());
        }
        if self.host.retention.job_pending {
            return Err(RecordingHostError::RetentionPending.into());
        }
        if self.host.retention.rearm_required {
            return Err(RecordingHostError::RetentionRearmRequired.into());
        }
        Ok(())
    }
    /// Caller confirms current SDK evidence. No SQL/network or inferred Hub identity.
    pub fn prepare_resume(
        &mut self,
        run: &ResumeInspectionRun,
        resolution: ResumeResolution,
    ) -> Result<ResumeTicket, SupervisorError> {
        let inspection = self.inspection(run)?;
        if self.resume.pending() {
            return Err(SupervisorError::Busy);
        }
        self.require_resume_context(&inspection.recording_run)?;
        let view = inspection
            .outcome
            .as_ref()
            .map_err(|_| SupervisorError::ResumeBlocked("inspection failed"))?;
        if view.recovery.active_session_id.is_some() || view.recovery.active_job.is_some() {
            return Err(SupervisorError::ResumeBlocked(
                "active recording or retention job",
            ));
        }
        let applied = view
            .plan
            .applied
            .as_ref()
            .filter(|p| p.receipt.enabled)
            .ok_or(SupervisorError::ResumeBlocked(
                "no enabled applied recording plan",
            ))?;
        let mapping = view
            .plan
            .mapping
            .as_ref()
            .ok_or(SupervisorError::ResumeBlocked("mapping missing"))?;
        let retention = view
            .recovery
            .applied_retention_policy
            .as_ref()
            .ok_or(SupervisorError::ResumeBlocked("retention policy missing"))?;
        if applied.receipt.mapping_revision != Some(mapping.receipt.mapping_revision)
            || applied.receipt.retention_applied_revision != Some(retention.applied_revision)
        {
            return Err(SupervisorError::ResumeBlocked(
                "applied references are not current",
            ));
        }
        let saved = applied
            .resolution
            .as_ref()
            .ok_or(SupervisorError::ResumeBlocked("applied resolution missing"))?;
        let session = SessionSpec {
            session_id: resolution.session_id,
            members: saved.members.iter().map(|m| m.identity.clone()).collect(),
        };
        let plan = SdkRecorderPlan::from_generation(session, &resolution.sdk_snapshot)
            .map_err(SupervisorError::Resolution)?;
        let options = RecordingOptions {
            plan: applied.receipt.plan.clone(),
            slot_count: resolution.slot_count,
            max_clock_skew_ms: resolution.max_clock_skew_ms,
            clock_epoch: resolution.clock_epoch,
        };
        let binding = ManagedRecorderStart {
            activation_id: resolution.activation_id,
            expected_applied_revision: applied.receipt.applied_revision,
            expected_mapping_revision: mapping.receipt.mapping_revision,
            expected_retention_applied_revision: retention.applied_revision,
        };
        binding
            .validate()
            .map_err(|e| SupervisorError::Host(RecordingHostError::Config(e)))?;
        RecorderConfig {
            session: plan.session().clone(),
            plan: options.plan.clone(),
            period_ms: plan.session().members[0].period_ms,
            slot_count: options.slot_count,
            max_clock_skew_ms: options.max_clock_skew_ms,
        }
        .validate()
        .map_err(|e| SupervisorError::Host(RecordingHostError::Config(e)))?;
        SystemRecorderClock::new(options.clock_epoch.clone())
            .map_err(|e| SupervisorError::Host(RecordingHostError::Clock(e)))?;
        if self.host.completion.is_some()
            && self.host.state().session_id.as_deref() == Some(plan.session().session_id.as_str())
        {
            return Err(RecordingHostError::SessionReuse.into());
        }
        if self.host.last_clock_epoch.as_ref() == Some(&options.clock_epoch) {
            return Err(RecordingHostError::ClockEpochReuse.into());
        }
        let ticket = ResumeTicket(Arc::new(()));
        self.resume.prepared = Some(PreparedResume {
            ticket: ticket.clone(),
            context: inspection.recording_run.clone(),
            inspection: run.clone(),
            plan,
            options,
            binding,
            consumed: false,
        });
        Ok(ticket)
    }
    pub fn resume(
        &mut self,
        ticket: &ResumeTicket,
        control: QueryControl,
        client: RestClient,
    ) -> Result<RecordingRun, SupervisorError> {
        let prepared = self
            .resume
            .prepared
            .as_ref()
            .filter(|p| &p.ticket == ticket)
            .ok_or(SupervisorError::WrongResume)?;
        if prepared.consumed {
            return Err(SupervisorError::ResumeConsumed);
        }
        self.inspection(&prepared.inspection)?;
        self.require_resume_context(&prepared.context)?;
        let run = self.host.start_managed(
            prepared.plan.clone(),
            prepared.options.clone(),
            prepared.binding.clone(),
            control,
            client,
        )?;
        self.resume
            .prepared
            .as_mut()
            .expect("prepared ticket")
            .consumed = true;
        self.resume.completion = None;
        self.preflight.clear_result();
        Ok(run)
    }
    pub fn discard_resume(&mut self, ticket: &ResumeTicket) -> Result<(), SupervisorError> {
        let prepared = self
            .resume
            .prepared
            .as_ref()
            .filter(|p| &p.ticket == ticket)
            .ok_or(SupervisorError::WrongResume)?;
        if prepared.consumed {
            return Err(SupervisorError::ResumeConsumed);
        }
        self.resume.prepared = None;
        Ok(())
    }
}
#[cfg(test)]
mod tests;
