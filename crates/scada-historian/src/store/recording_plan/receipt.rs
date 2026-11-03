//! Read commit evidence for the original apply without borrowing or recovering a writer.
use super::*;
use query::HistoryReader;
use serde::Serialize;

/// Evidence at one snapshot, not proof of worker quiescence or permission to retry.
/// `None` cannot rule out an in-flight or later commit. Neither case clears a latch.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingPlanReceiptSnapshot {
    pub snapshot_commit: u64,
    pub receipt: Option<RecordingPlanReceipt>,
}

impl HistoryReader {
    /// Validate saved evidence and the complete original apply request in one
    /// read-only snapshot. A reused ID with different canonical content conflicts.
    /// This does not recheck current-head CAS or acquire/release a writer.
    pub fn recording_plan_receipt_for_request(
        &mut self,
        request: &ApplyRecordingPlanRequest,
        control: &QueryControl,
    ) -> StoreResult<RecordingPlanReceiptSnapshot> {
        self.receipt_for_request_with_hook(request, control, &mut || Ok(()))
    }

    fn receipt_for_request_with_hook(
        &mut self,
        request: &ApplyRecordingPlanRequest,
        control: &QueryControl,
        hook: &mut impl FnMut() -> StoreResult<()>,
    ) -> StoreResult<RecordingPlanReceiptSnapshot> {
        canonical::validate_apply(request)?;
        // Validate caller limits before the management row cap can narrow them.
        control.validate()?;
        let payload = canonical::encode(request)?;
        self.store_snapshot(&bounded(control), |c, b| {
            let h = read::heads(c, b)?;
            hook()?;
            let receipt = find(
                c,
                b,
                "recording_plan_applications",
                "applied_revision",
                &request.request_id,
            )?
            .map(|revision| {
                let saved = read::application(
                    c,
                    b,
                    revision,
                    h.snapshot,
                    h.ledger.as_deref().ok_or(StoreError::CorruptData)?,
                )?;
                if canonical::encode(&saved.request)? != payload {
                    return Err(StoreError::Conflict);
                }
                Ok(saved.receipt)
            })
            .transpose()?;
            Ok(RecordingPlanReceiptSnapshot {
                snapshot_commit: h.snapshot,
                receipt,
            })
        })
    }
}

#[cfg(test)]
mod tests;
