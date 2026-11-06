//! Explicit, bounded receipt reads for the current original apply handle.
pub(super) mod driver;
mod types;
use super::*;
use scada_model::recording_operations::{
    RecordingReconciliationRequest, RecordingReconciliationResult,
};
use serde_json::json;
use std::collections::HashSet;
pub use types::*;

pub const MAX_RECONCILIATION_IDS: usize = 4096;
struct Read {
    request: RecordingReconciliationRequest,
    cancel: CancellationToken,
    completion: watch::Sender<Option<RecordingReconciliationCompletion>>,
}
impl Read {
    fn finish(&self, result: RecordingReconciliationCompletion) {
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
pub(super) struct ReadState {
    used: HashSet<String>,
    pub phase: ReconciliationPhase,
    pub handle: Option<RecordingReconciliationHandle>,
    pub last: Option<Arc<RecordingReconciliationResult>>,
    pub failure: Option<OwnerError>,
}
impl Default for ReadState {
    fn default() -> Self {
        Self {
            used: HashSet::new(),
            phase: ReconciliationPhase::Idle,
            handle: None,
            last: None,
            failure: None,
        }
    }
}
impl ReadState {
    pub(super) fn is_pristine(&self) -> bool {
        self.used.is_empty()
            && self.phase == ReconciliationPhase::Idle
            && self.handle.is_none()
            && self.last.is_none()
            && self.failure.is_none()
    }
}
impl RecordingOperationsClient {
    /// Read-only qualification for the registry before it consumes a read admission.
    pub(crate) fn registry_reconciliation_eligible(
        &self,
        original: &RecordingOperationHandle,
    ) -> bool {
        let Ok(core) = self.shared.core.try_lock() else {
            return false;
        };
        if core.closed
            || core.in_flight
            || matches!(
                core.read.phase,
                ReconciliationPhase::InFlight | ReconciliationPhase::Uncertain
            )
        {
            return false;
        }
        let Some(workflow) = &core.workflow else {
            return false;
        };
        if !workflow.operations[Stage::Apply.index()]
            .as_ref()
            .is_some_and(|handle| Arc::ptr_eq(&handle.0, &original.0))
        {
            return false;
        }
        let Some(completed) = original.0.completion.borrow().clone() else {
            return false;
        };
        let Some(supervisor) = core.supervisor.as_ref() else {
            return false;
        };
        qualifies_read(&core, supervisor, completed.as_value())
            && supervisor.require_receipt_reader().is_ok()
    }

    /// Inspect the current original apply only. A receipt never clears recovery.
    pub fn reconcile(
        &self,
        change: &RecordingChangeHandle,
        original: &RecordingOperationHandle,
        reconciliation_id: &str,
        control: QueryControl,
    ) -> Result<RecordingReconciliationHandle, OperationRejection> {
        #[cfg(test)]
        self.shared.reconcile_calls.fetch_add(1, Ordering::Relaxed);
        let fail = |code| self.shared.rejection(code);
        // Bound the identifier before cloning it into a JSON document.
        if reconciliation_id.is_empty() || reconciliation_id.len() > 64 {
            return Err(fail(OperationErrorCode::InvalidRequest));
        }
        projection::control(&control).map_err(fail)?;
        let mut core = self.shared.core.try_lock().map_err(|e| {
            fail(match e {
                TryLockError::WouldBlock => OperationErrorCode::Busy,
                TryLockError::Poisoned(_) => OperationErrorCode::Internal,
            })
        })?;
        if core.closed {
            return Err(fail(OperationErrorCode::WrongOwner));
        }
        if core.in_flight
            || matches!(
                core.read.phase,
                ReconciliationPhase::InFlight | ReconciliationPhase::Uncertain
            )
        {
            return Err(fail(OperationErrorCode::Busy));
        }
        let w = core
            .workflow
            .as_ref()
            .ok_or_else(|| fail(OperationErrorCode::NoCandidate))?;
        if !Arc::ptr_eq(&change.owner, &self.shared.identity)
            || !Arc::ptr_eq(&change.token, &w.change.token)
            || !w.operations[Stage::Apply.index()]
                .as_ref()
                .is_some_and(|h| Arc::ptr_eq(&h.0, &original.0))
            || original.0.stage != Stage::Apply
        {
            return Err(fail(OperationErrorCode::WrongOwner));
        }
        let completed = original
            .0
            .completion
            .borrow()
            .clone()
            .ok_or_else(|| fail(OperationErrorCode::Busy))?;
        let s = core
            .supervisor
            .as_ref()
            .ok_or_else(|| fail(OperationErrorCode::WorkerFailure))?;
        if !qualifies_read(&core, s, completed.as_value()) {
            return Err(fail(OperationErrorCode::InvalidRequest));
        }
        s.require_receipt_reader()
            .map_err(|e| fail(projection::supervisor_error(&e)))?;
        let request = RecordingReconciliationRequest::from_value(json!({"version":1,"kind":"recordingReconciliationRequest","reconciliationId":reconciliation_id,"operation":original.request().as_value()})).map_err(|_| fail(OperationErrorCode::InvalidRequest))?;
        if core.read.used.contains(reconciliation_id) {
            return Err(fail(OperationErrorCode::Consumed));
        }
        if core.read.used.len() >= MAX_RECONCILIATION_IDS {
            return Err(fail(OperationErrorCode::BudgetExceeded));
        }
        projection::control(&control).map_err(fail)?;
        let apply = w.apply.clone();
        let (completion, _) = watch::channel(None);
        let handle = RecordingReconciliationHandle(Arc::new(Read {
            request,
            cancel: control.cancellation.clone(),
            completion,
        }));
        core.read.used.insert(reconciliation_id.into());
        core.read.phase = ReconciliationPhase::InFlight;
        core.read.handle = Some(handle.clone());
        core.read.failure = None;
        core.in_flight = true;
        let supervisor = core.supervisor.take().expect("checked supervisor");
        self.shared.publish(&core);
        drop(core);
        driver::dispatch(
            self.shared.clone(),
            supervisor,
            handle.clone(),
            original.clone(),
            apply,
            control,
        );
        Ok(handle)
    }
}

fn qualifies_read(
    core: &Core,
    supervisor: &RecordingSupervisor,
    value: &serde_json::Value,
) -> bool {
    value["outcome"]["kind"] == "failed" && value["outcome"]["effect"] == "unconfirmed"
        || value["outcome"]["kind"] == "applied"
            && (value["quiescence"] == "unknown"
                || value["recoveryRequired"] == true
                || core.recovery
                || supervisor.recording_plan_guard_state().recovery_required)
}

#[cfg(test)]
mod tests;
