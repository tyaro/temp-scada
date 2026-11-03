use super::*;
use store::{
    query::QueryControl,
    recording_plan::{ActivateRecordingPlanRequest, RecordingActivationReceipt},
};

/// Expected deployment revisions; actual session and start clock come from the recorder.
#[derive(Clone, Debug)]
pub struct ManagedRecorderStart {
    pub activation_id: String,
    pub expected_applied_revision: u64,
    pub expected_mapping_revision: u64,
    pub expected_retention_applied_revision: u64,
}
impl ManagedRecorderStart {
    pub fn validate(&self) -> Result<(), RecorderStartError> {
        if !store::id(&self.activation_id)
            || ![
                self.expected_applied_revision,
                self.expected_mapping_revision,
                self.expected_retention_applied_revision,
            ]
            .into_iter()
            .all(|r| (1..=MAX_SAFE).contains(&r))
        {
            return Err(RecorderStartError::InvalidConfig);
        }
        Ok(())
    }
}
impl Recorder {
    /// Fresh start only. A persisted activation receipt never resumes a recorder.
    pub fn start_managed(
        store: &mut SqliteStore,
        config: RecorderConfig,
        binding: ManagedRecorderStart,
        clock: &mut impl RecorderClock,
        control: &QueryControl,
    ) -> Result<(Self, RecordingActivationReceipt), RecorderStartError> {
        Self::start_managed_with(
            store,
            config,
            binding,
            clock,
            control,
            |store, request, control| store.activate_recording_plan(request, control),
        )
    }
    pub(super) fn start_managed_with(
        store: &mut SqliteStore,
        config: RecorderConfig,
        binding: ManagedRecorderStart,
        clock: &mut impl RecorderClock,
        control: &QueryControl,
        activate: impl FnOnce(
            &mut SqliteStore,
            &ActivateRecordingPlanRequest,
            &QueryControl,
        ) -> store::StoreResult<RecordingActivationReceipt>,
    ) -> Result<(Self, RecordingActivationReceipt), RecorderStartError> {
        let config = config.validated()?;
        binding.validate()?;
        if store
            .recording_activation(&binding.activation_id, control)
            .map_err(RecorderStartError::Store)?
            .is_some()
        {
            return Err(RecorderStartError::AlreadyActivated);
        }
        let state = store
            .recording_plan_state(control)
            .map_err(RecorderStartError::Store)?;
        let applied = state
            .applied
            .ok_or(RecorderStartError::ManagedBindingMismatch)?;
        if !applied.receipt.enabled
            || applied.receipt.applied_revision != binding.expected_applied_revision
            || applied.receipt.mapping_revision != Some(binding.expected_mapping_revision)
            || state.mapping.as_ref().map(|m| m.receipt.mapping_revision)
                != Some(binding.expected_mapping_revision)
            || applied.receipt.retention_applied_revision
                != Some(binding.expected_retention_applied_revision)
            || applied.receipt.plan != config.plan
        {
            return Err(RecorderStartError::ManagedBindingMismatch);
        }
        let expected = store::SessionSpec {
            session_id: config.session.session_id.clone(),
            members: applied
                .resolution
                .ok_or(RecorderStartError::ManagedBindingMismatch)?
                .members
                .into_iter()
                .map(|m| m.identity)
                .collect(),
        }
        .validated()
        .map_err(RecorderStartError::Store)?;
        if expected != config.session {
            return Err(RecorderStartError::ManagedBindingMismatch);
        }
        // Keep this exact reading across the commit; SQLite latency becomes missed slots.
        let anchor = clock.read().map_err(RecorderStartError::Clock)?;
        valid_reading(&anchor).map_err(RecorderStartError::Clock)?;
        check_horizon(&config, &anchor)?;
        let request = ActivateRecordingPlanRequest {
            activation_id: binding.activation_id,
            expected_applied_revision: binding.expected_applied_revision,
            expected_mapping_revision: binding.expected_mapping_revision,
            expected_retention_applied_revision: binding.expected_retention_applied_revision,
            session_id: config.session.session_id.clone(),
            start: ClockStamp {
                clock_epoch: anchor.clock_epoch.clone(),
                at_ms: anchor.wall_time_ms,
            },
        };
        let receipt = activate(store, &request, control)
            .map_err(RecorderStartError::ActivationUnconfirmed)?;
        Ok((Self::from_anchor(config, anchor), receipt))
    }
}
