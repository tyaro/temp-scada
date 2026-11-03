//! One management snapshot for explicit resume decisions and recovery diagnostics.
use super::*;
use query::HistoryReader;
use serde::Serialize;
/// Composite of three existing management reads; individual API caps remain unchanged.
pub const MAX_RESUME_DECODED_ROWS: u32 = 768;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingResumeState {
    pub snapshot_commit: u64,
    pub plan: RecordingPlanState,
    pub latest_activation: Option<RecordingActivation>,
    pub recovery: recovery::StoreRecoveryState,
}
impl HistoryReader {
    /// Read-only evidence, never permission to reattach a session or clear a Host latch.
    pub fn recording_resume_state(
        &mut self,
        control: &QueryControl,
    ) -> StoreResult<RecordingResumeState> {
        self.resume_with_hook(control, &mut || Ok(()))
    }
    fn resume_with_hook(
        &mut self,
        control: &QueryControl,
        hook: &mut impl FnMut() -> StoreResult<()>,
    ) -> StoreResult<RecordingResumeState> {
        let mut control = control.clone();
        control.limits.max_decoded_rows =
            control.limits.max_decoded_rows.min(MAX_RESUME_DECODED_ROWS);
        self.store_snapshot(&control, |c, b| {
            let h = read::heads(c, b)?;
            hook()?;
            let mut cache = reservations::EvidenceCache::default();
            let plan = read::state_from_heads(c, b, &h, &mut cache)?;
            let latest_activation = activation::latest_with_cache(c, b, &h, &mut cache)?;
            let recovery = recovery::read_snapshot(c, b, &mut || Ok(()))?;
            if recovery.snapshot_commit != h.snapshot {
                return Err(StoreError::CorruptData);
            }
            // A managed active session must be exactly the latest activation.
            if plan.applied.is_some()
                && recovery.active_session_id.as_ref().is_some_and(|id_| {
                    latest_activation.as_ref().is_none_or(|a| {
                        a.session.spec.session_id != *id_
                            || a.session.state != crate::store::SessionState::Active
                    })
                })
            {
                return Err(StoreError::CorruptData);
            }
            Ok(RecordingResumeState {
                snapshot_commit: h.snapshot,
                plan,
                latest_activation,
                recovery,
            })
        })
    }
}
#[cfg(test)]
mod tests;
