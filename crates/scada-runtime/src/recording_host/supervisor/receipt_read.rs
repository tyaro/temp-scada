//! Private same-reader receipt loan. It never authorizes a mutation or a restart.
use super::*;
use scada_historian::store::{
    query::{CancellationToken, HistoryReader, QueryError},
    recording_plan::{ApplyRecordingPlanRequest, RecordingPlanReceiptSnapshot},
    StoreError, StoreResult,
};
use tokio::task::JoinHandle;

pub(super) struct ReceiptRead {
    cancel: CancellationToken,
    cancel_on_drop: bool,
    task: JoinHandle<(HistoryReader, StoreResult<RecordingPlanReceiptSnapshot>)>,
}
impl Drop for ReceiptRead {
    fn drop(&mut self) {
        if self.cancel_on_drop {
            self.cancel.cancel();
        }
    }
}
impl RecordingSupervisor {
    pub(super) fn require_receipt_reader(&self) -> Result<(), SupervisorError> {
        if self.receipt_read.is_some()
            || self.resume.running.is_some()
            || self.host.plan_turn.running.is_some()
            || self.host.retention.running.is_some()
        {
            return Err(SupervisorError::Busy);
        }
        // Pending candidate and writer recovery are intentionally not reader gates.
        self.preflight.require_idle()
    }
    pub(super) fn start_receipt_read(
        &mut self,
        request: ApplyRecordingPlanRequest,
        control: QueryControl,
    ) -> Result<(), SupervisorError> {
        self.start_receipt_read_with(request, control, |reader, request, control| {
            reader.recording_plan_receipt_for_request(request, control)
        })
    }
    pub(super) fn start_receipt_read_with(
        &mut self,
        request: ApplyRecordingPlanRequest,
        control: QueryControl,
        read: impl FnOnce(
                &mut HistoryReader,
                &ApplyRecordingPlanRequest,
                &QueryControl,
            ) -> StoreResult<RecordingPlanReceiptSnapshot>
            + Send
            + 'static,
    ) -> Result<(), SupervisorError> {
        self.require_receipt_reader()?;
        tokio::runtime::Handle::try_current().map_err(|_| SupervisorError::NoRuntime)?;
        let mut reader = self.preflight.reader.take().expect("checked reader");
        let cancel = control.cancellation.clone();
        let task = tokio::task::spawn_blocking(move || {
            let outcome = read(&mut reader, &request, &control);
            (reader, outcome)
        });
        self.receipt_read = Some(ReceiptRead {
            cancel,
            cancel_on_drop: true,
            task,
        });
        Ok(())
    }
    pub(super) async fn join_receipt_read(
        &mut self,
    ) -> Result<StoreResult<RecordingPlanReceiptSnapshot>, SupervisorError> {
        let running = self
            .receipt_read
            .as_mut()
            .ok_or(SupervisorError::NoReader)?;
        let result = (&mut running.task).await;
        running.cancel_on_drop = false;
        self.receipt_read.take();
        match result {
            Ok((reader, outcome)) => {
                self.preflight.reader = Some(reader);
                self.preflight.unusable |= matches!(
                    &outcome,
                    Err(StoreError::Control(QueryError::ReaderUnusable))
                );
                Ok(outcome)
            }
            Err(_) => {
                self.preflight.faulted = true;
                Err(SupervisorError::ReaderFailed)
            }
        }
    }
}
