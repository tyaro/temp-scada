//! One shared administrative owner for explicit recording-plan operations.
//! No transport, new sessions, mapping registration, automatic resume or receipt polling.
mod driver;
mod projection;
mod registry;
mod types;
pub use registry::MAX_OWNER_IDS;
pub use types::*;

use super::{PreflightRun, RecordingSupervisor};
use crate::recording_host::{RecordingPlanTurnRun, RecordingRun};
use scada_historian::store::{
    query::{CancellationToken, QueryControl},
    recording_plan::{ApplyRecordingPlanRequest, RecordingPlanReceipt},
};
use scada_model::recording_operations::{
    same_recording_operations_context, RecordingChangeRequest, RecordingOperationRequest,
    RecordingOperationResult, RecordingOperationsContext,
};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use tokio::{runtime::Handle, sync::watch};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Preflight,
    Pause,
    Apply,
}
impl Stage {
    fn as_str(self) -> &'static str {
        match self {
            Self::Preflight => "preflight",
            Self::Pause => "pauseJoin",
            Self::Apply => "apply",
        }
    }
    fn index(self) -> usize {
        match self {
            Self::Preflight => 0,
            Self::Pause => 1,
            Self::Apply => 2,
        }
    }
}
struct Operation {
    request: RecordingOperationRequest,
    stage: Stage,
    cancel: CancellationToken,
    completion: watch::Sender<Option<Arc<RecordingOperationResult>>>,
}
impl Operation {
    fn handle(
        request: RecordingOperationRequest,
        stage: Stage,
        cancel: CancellationToken,
    ) -> RecordingOperationHandle {
        let (completion, _) = watch::channel(None);
        RecordingOperationHandle(Arc::new(Self {
            request,
            stage,
            cancel,
            completion,
        }))
    }
    fn finish(&self, result: Arc<RecordingOperationResult>) {
        self.completion.send_if_modified(|slot| {
            if slot.is_none() {
                *slot = Some(result.clone());
                true
            } else {
                false
            }
        });
    }
}
struct Workflow {
    change: RecordingChangeHandle,
    request: RecordingChangeRequest,
    apply: ApplyRecordingPlanRequest,
    preflight: Option<PreflightRun>,
    turn: Option<RecordingPlanTurnRun>,
    operations: [Option<RecordingOperationHandle>; 3],
    credits: usize,
}
struct Core {
    supervisor: Option<RecordingSupervisor>,
    registry: registry::Registry,
    workflow: Option<Workflow>,
    phase: OperationsPhase,
    in_flight: bool,
    recovery: bool,
    closed: bool,
    latest: Option<Arc<RecordingOperationResult>>,
    last_applied: Option<AppliedSuccess>,
    native_receipt: Option<NativeReceiptEvidence>,
}
struct Shared {
    #[cfg(test)]
    fault: Mutex<Option<driver::TestFault>>,
    core: Mutex<Core>,
    context: RecordingOperationsContext,
    run: RecordingRun,
    identity: Arc<()>,
    runtime: Handle,
    view: watch::Sender<Arc<RecordingOperationsState>>,
}
impl Shared {
    fn publish(&self, core: &Core) {
        let w = core.workflow.as_ref();
        let active = w.and_then(|w| w.operations.iter().rev().find_map(Clone::clone));
        self.view.send_replace(Arc::new(RecordingOperationsState {
            context: self.context.clone(),
            phase: core.phase,
            change: w.map(|w| w.change.clone()),
            request: w.map(|w| w.request.clone()),
            active,
            latest: core.latest.clone(),
            last_applied: core.last_applied.clone(),
            recovery_required: core.recovery,
            closed: core.closed,
        }));
    }
    fn rejection(&self, code: OperationErrorCode) -> OperationRejection {
        OperationRejection { code }
    }
    fn locked(&self) -> Result<MutexGuard<'_, Core>, OperationRejection> {
        let core = self.core.try_lock().map_err(|e| {
            self.rejection(match e {
                TryLockError::WouldBlock => OperationErrorCode::Busy,
                TryLockError::Poisoned(_) => OperationErrorCode::Internal,
            })
        })?;
        if core.closed {
            return Err(self.rejection(OperationErrorCode::WrongOwner));
        }
        if core.in_flight {
            return Err(self.rejection(OperationErrorCode::Busy));
        }
        if core.recovery {
            return Err(self.rejection(OperationErrorCode::PlanRecoveryRequired));
        }
        if core.supervisor.is_none() {
            return Err(self.rejection(OperationErrorCode::Internal));
        }
        Ok(core)
    }
}
/// Retain this administrative root beyond every UI/client and keep its runtimes alive.
/// Dropping a client does nothing to the source. Dropping this root ends the service.
pub struct RecordingOperationsOwner {
    shared: Arc<Shared>,
}
#[derive(Clone)]
pub struct RecordingOperationsClient {
    shared: Arc<Shared>,
}
impl RecordingOperationsOwner {
    pub fn try_new(
        supervisor: RecordingSupervisor,
        context: RecordingOperationsContext,
        recording_run: RecordingRun,
    ) -> Result<Self, Box<RecordingOperationsInitError>> {
        let error = match supervisor.recording_operations_context() {
            Ok((run, session))
                if run == recording_run
                    && context.as_value()["sessionId"].as_str() == Some(&session) =>
            {
                None
            }
            Ok(_) => Some(OwnerError::InvalidContext),
            Err(_) => Some(OwnerError::RecoveryRequired),
        };
        let runtime = Handle::try_current();
        if let Some(error) = error.or_else(|| runtime.as_ref().err().map(|_| OwnerError::NoRuntime))
        {
            return Err(Box::new(RecordingOperationsInitError { error, supervisor }));
        }
        let initial = Arc::new(RecordingOperationsState {
            context: context.clone(),
            phase: OperationsPhase::Idle,
            change: None,
            request: None,
            active: None,
            latest: None,
            last_applied: None,
            recovery_required: false,
            closed: false,
        });
        let (view, _) = watch::channel(initial);
        Ok(Self {
            shared: Arc::new(Shared {
                #[cfg(test)]
                fault: Mutex::new(None),
                core: Mutex::new(Core {
                    supervisor: Some(supervisor),
                    registry: registry::Registry::default(),
                    workflow: None,
                    phase: OperationsPhase::Idle,
                    in_flight: false,
                    recovery: false,
                    closed: false,
                    latest: None,
                    last_applied: None,
                    native_receipt: None,
                }),
                context,
                run: recording_run,
                identity: Arc::new(()),
                runtime: runtime.expect("checked runtime"),
                view,
            }),
        })
    }
    pub fn client(&self) -> RecordingOperationsClient {
        RecordingOperationsClient {
            shared: self.shared.clone(),
        }
    }
    pub fn try_handoff(&mut self) -> Result<RecordingOperationsHandoff, OwnerError> {
        let mut core = self.shared.core.try_lock().map_err(|e| match e {
            TryLockError::WouldBlock => OwnerError::Busy,
            TryLockError::Poisoned(_) => OwnerError::Internal,
        })?;
        if core.closed {
            return Err(OwnerError::Closed);
        }
        if core.in_flight
            || matches!(
                core.phase,
                OperationsPhase::Candidate | OperationsPhase::Paused
            )
        {
            return Err(OwnerError::Busy);
        }
        if core
            .latest
            .as_ref()
            .is_some_and(|r| r.as_value()["quiescence"] != "confirmed")
        {
            return Err(OwnerError::Busy);
        }
        let mut supervisor = core.supervisor.take().ok_or(OwnerError::Unavailable)?;
        if core.recovery {
            supervisor.latch_recording_operations_recovery();
        }
        let evidence = RecordingOperationsRecoveryEvidence {
            context: self.shared.context.clone(),
            request: core
                .workflow
                .as_ref()
                .and_then(|w| w.operations.iter().rev().find_map(Clone::clone))
                .map(|h| h.request().clone()),
            latest: core.latest.clone(),
            last_applied: core.last_applied.clone(),
            native_receipt: core.native_receipt.clone(),
            owner_recovery_required: core.recovery,
        };
        core.closed = true;
        self.shared.publish(&core);
        Ok(RecordingOperationsHandoff {
            supervisor,
            evidence,
        })
    }
}
impl Drop for RecordingOperationsOwner {
    fn drop(&mut self) {
        let mut core = self.shared.core.lock().unwrap_or_else(|e| e.into_inner());
        if core.closed {
            return;
        }
        core.closed = true;
        if let Some(w) = &core.workflow {
            for h in w.operations.iter().flatten() {
                h.request_cancel();
            }
        }
        self.shared.publish(&core);
        // Drop idle native ownership outside the state lock. In-flight tasks retain it.
        let supervisor = core.supervisor.take();
        drop(core);
        drop(supervisor);
    }
}
impl RecordingOperationsClient {
    pub fn state(&self) -> Arc<RecordingOperationsState> {
        self.shared.view.borrow().clone()
    }
    /// Clone a frame and release watch::Ref before calling owner methods or awaiting.
    pub fn watch(&self) -> watch::Receiver<Arc<RecordingOperationsState>> {
        self.shared.view.subscribe()
    }
    pub fn preflight(
        &self,
        request: RecordingChangeRequest,
        control: QueryControl,
    ) -> Result<AcceptedRecordingChange, OperationRejection> {
        let fail = |code| self.shared.rejection(code);
        if !same_recording_operations_context(
            &self.shared.context,
            &RecordingOperationsContext::from_value(request.as_value()["context"].clone())
                .map_err(|_| fail(OperationErrorCode::InvalidRequest))?,
        ) {
            return Err(fail(OperationErrorCode::WrongOwner));
        }
        let apply = projection::apply(&request).map_err(fail)?;
        projection::control(&control).map_err(fail)?;
        let mut core = self.shared.locked()?;
        if !matches!(
            core.phase,
            OperationsPhase::Idle | OperationsPhase::Completed
        ) {
            return Err(fail(OperationErrorCode::Busy));
        }
        let change_id = request.as_value()["changeId"]
            .as_str()
            .expect("validated ID");
        let (id, counter) = core.registry.prepare(change_id).map_err(fail)?;
        let op = projection::request(&request, &id, Stage::Preflight).map_err(fail)?;
        projection::control(&control).map_err(fail)?;
        let operation = Operation::handle(op, Stage::Preflight, control.cancellation.clone());
        let change = RecordingChangeHandle {
            owner: self.shared.identity.clone(),
            token: Arc::new(()),
        };
        core.registry.begin(change_id, &id, counter);
        core.workflow = Some(Workflow {
            change: change.clone(),
            request,
            apply,
            preflight: None,
            turn: None,
            operations: [Some(operation.clone()), None, None],
            credits: 2,
        });
        core.phase = OperationsPhase::Preflighting;
        core.in_flight = true;
        core.latest = None;
        core.native_receipt = None;
        let supervisor = core.supervisor.take().expect("available native owner");
        self.shared.publish(&core);
        drop(core);
        driver::dispatch(self.shared.clone(), supervisor, operation.clone(), control);
        Ok(AcceptedRecordingChange { change, operation })
    }
    pub fn pause_join(
        &self,
        change: &RecordingChangeHandle,
        operation_id: &str,
        control: QueryControl,
    ) -> Result<RecordingOperationHandle, OperationRejection> {
        self.next(change, operation_id, control, Stage::Pause)
    }
    pub fn apply(
        &self,
        change: &RecordingChangeHandle,
        operation_id: &str,
        control: QueryControl,
    ) -> Result<RecordingOperationHandle, OperationRejection> {
        self.next(change, operation_id, control, Stage::Apply)
    }
    fn next(
        &self,
        change: &RecordingChangeHandle,
        id: &str,
        control: QueryControl,
        stage: Stage,
    ) -> Result<RecordingOperationHandle, OperationRejection> {
        let fail = |code| self.shared.rejection(code);
        projection::control(&control).map_err(fail)?;
        let mut core = self.shared.locked()?;
        let w = core
            .workflow
            .as_ref()
            .ok_or_else(|| fail(OperationErrorCode::NoCandidate))?;
        if !Arc::ptr_eq(&change.owner, &self.shared.identity)
            || !Arc::ptr_eq(&change.token, &w.change.token)
        {
            return Err(fail(OperationErrorCode::WrongOwner));
        }
        if core.phase
            != if stage == Stage::Pause {
                OperationsPhase::Candidate
            } else {
                OperationsPhase::Paused
            }
        {
            return Err(fail(if stage == Stage::Pause {
                OperationErrorCode::NoCandidate
            } else {
                OperationErrorCode::PauseRequired
            }));
        }
        let request = projection::request(&w.request, id, stage).map_err(fail)?;
        core.registry.check_stage(id).map_err(fail)?;
        projection::control(&control).map_err(fail)?;
        let operation = Operation::handle(request, stage, control.cancellation.clone());
        core.registry.stage(id).map_err(fail)?;
        let w = core.workflow.as_mut().expect("checked workflow");
        w.credits -= 1;
        w.operations[stage.index()] = Some(operation.clone());
        core.phase = if stage == Stage::Pause {
            OperationsPhase::Pausing
        } else {
            OperationsPhase::Applying
        };
        core.in_flight = true;
        let supervisor = core.supervisor.take().expect("available native owner");
        self.shared.publish(&core);
        drop(core);
        driver::dispatch(self.shared.clone(), supervisor, operation.clone(), control);
        Ok(operation)
    }
    pub fn discard(&self, change: &RecordingChangeHandle) -> Result<(), OperationRejection> {
        let fail = |code| self.shared.rejection(code);
        let mut core = self.shared.locked()?;
        let w = core
            .workflow
            .as_ref()
            .ok_or_else(|| fail(OperationErrorCode::NoCandidate))?;
        if !Arc::ptr_eq(&change.owner, &self.shared.identity)
            || !Arc::ptr_eq(&change.token, &w.change.token)
        {
            return Err(fail(OperationErrorCode::WrongOwner));
        }
        if !matches!(
            core.phase,
            OperationsPhase::Candidate | OperationsPhase::Paused
        ) {
            return Err(fail(OperationErrorCode::NoCandidate));
        }
        let run = w
            .preflight
            .clone()
            .ok_or_else(|| fail(OperationErrorCode::NoCandidate))?;
        core.supervisor
            .as_mut()
            .expect("available native owner")
            .discard_candidate(&run)
            .map_err(|e| fail(projection::supervisor_error(&e)))?;
        let credits = core.workflow.take().expect("checked workflow").credits;
        core.registry.release(credits);
        core.phase = OperationsPhase::Idle;
        core.latest = None;
        core.native_receipt = None;
        self.shared.publish(&core);
        Ok(())
    }
}

#[cfg(test)]
mod tests;
