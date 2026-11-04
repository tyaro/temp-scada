use super::*;
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReconciliationPhase {
    Idle,
    InFlight,
    Completed,
    Uncertain,
}
/// Err means read cleanup could not be established. It never releases the read gate.
pub type RecordingReconciliationCompletion = Result<Arc<RecordingReconciliationResult>, OwnerError>;
#[derive(Clone)]
pub struct RecordingReconciliationHandle(pub(super) Arc<Read>);
impl fmt::Debug for RecordingReconciliationHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RecordingReconciliationHandle(..)")
    }
}
impl RecordingReconciliationHandle {
    pub fn request(&self) -> &RecordingReconciliationRequest {
        &self.0.request
    }
    /// Clone and release watch::Ref before calling the owner or awaiting.
    pub fn watch(&self) -> watch::Receiver<Option<RecordingReconciliationCompletion>> {
        self.0.completion.subscribe()
    }
    pub async fn wait(&self) -> RecordingReconciliationCompletion {
        let mut rx = self.watch();
        loop {
            if let Some(value) = rx.borrow_and_update().clone() {
                return value;
            }
            rx.changed().await.map_err(|_| OwnerError::Unavailable)?;
        }
    }
    pub fn request_cancel(&self) -> CancelDisposition {
        if self.0.completion.borrow().is_some() {
            CancelDisposition::AlreadyCompleted
        } else {
            self.0.cancel.cancel();
            CancelDisposition::Requested
        }
    }
}
