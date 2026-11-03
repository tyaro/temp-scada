//! Advisory checks against saved mappings, without stopping or mutating anything.
use super::*;
use query::HistoryReader;

impl HistoryReader {
    /// Check a mapping proposal while recording continues. Replay never requests
    /// a stop. Candidate must be checked again by the eventual writer transaction.
    pub fn preflight_recording_mapping(
        &mut self,
        request: &RegisterMappingRequest,
        control: &QueryControl,
    ) -> StoreResult<RecordingMappingPreflight> {
        self.mapping_preflight_with_hook(request, control, &mut || Ok(()))
    }
    fn mapping_preflight_with_hook(
        &mut self,
        request: &RegisterMappingRequest,
        control: &QueryControl,
        hook: &mut impl FnMut() -> StoreResult<()>,
    ) -> StoreResult<RecordingMappingPreflight> {
        canonical::validate_mapping(request)?;
        let payload = canonical::encode(request)?;
        let request: RegisterMappingRequest = serde_json::from_str(&payload)?;
        self.store_snapshot(&bounded(control), |c, b| {
            let snapshot_commit = read::snapshot(c, b)?;
            hook()?;
            let outcome = match prepare::register(c, b, &request, &payload, true)? {
                prepare::Prepared::Replay(receipt) => MappingPreflightOutcome::Replay(receipt),
                prepare::Prepared::Candidate(c) => MappingPreflightOutcome::Candidate {
                    active_session_id: c.active_session_id,
                },
            };
            Ok(RecordingMappingPreflight {
                snapshot_commit,
                outcome,
            })
        })
    }

    /// Check an apply request against an already saved mapping. A successful
    /// mapping proposal is not a saved mapping revision and cannot be used here.
    pub fn preflight_recording_plan(
        &mut self,
        request: &ApplyRecordingPlanRequest,
        control: &QueryControl,
    ) -> StoreResult<RecordingPlanPreflight> {
        self.plan_preflight_with_hook(request, control, &mut || Ok(()))
    }
    fn plan_preflight_with_hook(
        &mut self,
        request: &ApplyRecordingPlanRequest,
        control: &QueryControl,
        hook: &mut impl FnMut() -> StoreResult<()>,
    ) -> StoreResult<RecordingPlanPreflight> {
        canonical::validate_apply(request)?;
        let payload = canonical::encode(request)?;
        let request: ApplyRecordingPlanRequest = serde_json::from_str(&payload)?;
        self.store_snapshot(&bounded(control), |c, b| {
            let snapshot_commit = read::snapshot(c, b)?;
            hook()?;
            let outcome = match prepare::apply(c, b, &request, &payload, true)? {
                prepare::Prepared::Replay(receipt) => PlanPreflightOutcome::Replay(receipt),
                prepare::Prepared::Candidate(c) => PlanPreflightOutcome::Candidate {
                    active_session_id: c.active_session_id,
                },
            };
            Ok(RecordingPlanPreflight {
                snapshot_commit,
                outcome,
            })
        })
    }
}

#[cfg(test)]
mod tests;
