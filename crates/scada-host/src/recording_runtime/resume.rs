//! The resume and the stopped reconfiguration of recording (product-owner
//! design §5 `recording_resume` and `recording_reconfigure`, C5-4).
//!
//! The resume starts the plan the store has applied, after the registry's
//! apply (the root is taken back first) and after a restart, from a fresh
//! SDK resolution. The reconfiguration applies the Project's plan while
//! nothing records and no root is installed; it never starts recording.
//! Both decide from what the store holds, like the first setup, so a call
//! whose outcome was unknown is simply called again.
use banto_tagclient::RestClient;
use scada_historian::store::recording_plan::{
    ApplyRecordingPlanRequest, RecordingMapping, RegisterMappingRequest,
};
use scada_historian::store::{SqliteStore, StoreError};
use scada_model::recording_plan::validate_recording_plan;
use scada_model::Project;
use scada_runtime::recording_host::{RecordingPhase, RecordingSupervisor};
use serde_json::Value;

use super::setup::{self, SetupFailure};
use super::{blocking, lock, resume_state, start, HistoryCatalog, Ready, RecordingRuntime};
use crate::auth_phase::PhaseGuard;
use crate::recording_gate::RecordingGate;

/// How a reconfiguration ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reconfigured {
    /// `false` when the store had applied the same plan already.
    pub changed: bool,
    pub enabled: bool,
}

impl RecordingRuntime {
    /// `recording_resume` (design §5): take an installed root back by its
    /// handoff, then start the applied plan from a fresh SDK resolution
    /// (`resolve`), recording with `record`. A recording that runs is not
    /// touched (`not_allowed`); an unsettled root is `busy` and nothing
    /// changes. Returns the recording phase reached (`running`, or
    /// `starting` if it did not run within the wait).
    pub async fn resume(
        &self,
        gate: Option<&RecordingGate>,
        phase: &PhaseGuard<'_>,
        resolve: RestClient,
        record: RestClient,
    ) -> Result<&'static str, SetupFailure> {
        let ready = self.state.as_ref().map_err(|_| SetupFailure::Unavailable)?;
        // A root over a running recording stays installed.
        let lent = lock(&ready.lent).as_ref().map(|w| w.borrow().phase);
        if lent.is_some_and(|phase| !settled(phase)) {
            return Err(SetupFailure::NotAllowed);
        }
        if let Some(gate) = gate {
            self.take_owner(gate, phase)
                .await
                .map_err(|_| SetupFailure::Busy)?;
        }
        let mut slot = ready.supervisor.lock().await;
        let supervisor = slot.as_mut().ok_or(SetupFailure::Unavailable)?;
        join_ended(supervisor).await?;
        let state = resume_state(supervisor).await?;
        if state.recovery.active_session_id.is_some() || state.recovery.active_job.is_some() {
            return Err(SetupFailure::NotAllowed);
        }
        let applied = state
            .plan
            .applied
            .as_ref()
            .ok_or(SetupFailure::NoRecordingPlan)?;
        if !applied.receipt.enabled {
            return Err(SetupFailure::PlanDisabled);
        }
        let mapping = applied
            .resolution
            .clone()
            .ok_or(SetupFailure::StoreFailed)?;
        // The History host's series follow the applied plan (the registry's
        // apply may have changed it).
        if let Some(catalog) = HistoryCatalog::from_state(state.plan.clone()) {
            *lock(&ready.catalog) = Some(catalog);
        }
        let snapshot = setup::resolve(resolve, &mapping).await?;
        setup::check(&mapping, &snapshot)?;
        start(supervisor, snapshot, record).await
    }

    /// `recording_reconfigure` (design §5): apply the Project's plan while
    /// recording is stopped and no root is installed. Registers a new mapping
    /// when the plan's members no longer fit the registered one (members that
    /// still fit keep their identities; only then is the Hub read through
    /// `resolve`), keeps the retention policy, and never starts recording.
    pub async fn reconfigure(
        &self,
        project: &Project,
        resolve: Option<RestClient>,
    ) -> Result<Reconfigured, SetupFailure> {
        let ready = self.state.as_ref().map_err(|_| SetupFailure::Unavailable)?;
        let desired = project
            .recording_plan()
            .ok_or(SetupFailure::NoRecordingPlan)?;
        validate_recording_plan(desired).map_err(|_| SetupFailure::InvalidPlan)?;
        let desired = desired.clone();
        let enabled = desired["enabled"] == true;
        let mut slot = ready.supervisor.lock().await;
        let Some(supervisor) = slot.as_mut() else {
            // Lent to an installed root: changes go through the registry.
            return Err(match lock(&ready.lent).is_some() {
                true => SetupFailure::NotAllowed,
                false => SetupFailure::Unavailable,
            });
        };
        if !matches!(
            supervisor.state().recording.phase,
            RecordingPhase::Idle | RecordingPhase::Joined
        ) {
            return Err(SetupFailure::NotAllowed);
        }
        let state = resume_state(supervisor).await?;
        if state.recovery.active_session_id.is_some() || state.recovery.active_job.is_some() {
            return Err(SetupFailure::NotAllowed);
        }
        // Without an applied plan this is the first setup's work.
        let applied = state
            .plan
            .applied
            .as_ref()
            .ok_or(SetupFailure::NotAllowed)?;
        if setup::canonical(&applied.request.desired) == setup::canonical(&desired) {
            return Ok(Reconfigured {
                changed: false,
                enabled,
            });
        }
        let applied_revision = applied.receipt.applied_revision;
        let registered = state.plan.mapping.as_ref();
        let retention = state
            .recovery
            .applied_retention_policy
            .as_ref()
            .map(|p| p.applied_revision);
        if enabled && retention.is_none() {
            return Err(SetupFailure::NotAllowed);
        }
        // What the apply binds: nothing for a disabled plan; else the
        // registered mapping if it fits, or a new one to register first.
        let binding = if !enabled {
            Binding::None
        } else if let Some(mapping) = registered.filter(|m| setup::fits(&m.mapping, &desired)) {
            Binding::Registered(mapping.receipt.mapping_revision)
        } else {
            let resolve = resolve.ok_or(SetupFailure::HubNotConfigured)?;
            let (mut mapping, kept) = redraft(&desired, registered.map(|m| &m.mapping))?;
            let snapshot = setup::resolve(resolve, &mapping).await?;
            setup::complete(&mut mapping, &snapshot, &kept)?;
            setup::check(&mapping, &snapshot)?;
            Binding::New(mapping, registered.map(|m| m.receipt.mapping_revision))
        };
        let store = supervisor.take_store().map_err(|_| SetupFailure::Busy)?;
        *slot = None;
        let Some((store, saved)) = blocking(store, move |store| {
            apply(store, binding, applied_revision, retention, desired)?;
            Ok(store
                .recording_plan_state(&setup::control())
                .ok()
                .and_then(HistoryCatalog::from_state))
        })
        .await
        else {
            return Err(SetupFailure::StoreFailed);
        };
        let supervisor =
            RecordingSupervisor::try_new(store).map_err(|_| SetupFailure::StoreFailed)?;
        *slot = Some(supervisor);
        update_catalog(ready, saved).map(|()| Reconfigured {
            changed: true,
            enabled,
        })
    }
}

fn update_catalog(
    ready: &Ready,
    saved: Result<Option<HistoryCatalog>, SetupFailure>,
) -> Result<(), SetupFailure> {
    if let Some(catalog) = saved? {
        *lock(&ready.catalog) = Some(catalog);
    }
    Ok(())
}

/// A recording phase in which no recording runs or is about to.
fn settled(phase: RecordingPhase) -> bool {
    matches!(phase, RecordingPhase::Idle | RecordingPhase::Joined)
}

/// Collect a recording that ended by itself, so the writer is back; refuse
/// one that runs or is starting or stopping.
async fn join_ended(supervisor: &mut RecordingSupervisor) -> Result<(), SetupFailure> {
    let status = supervisor.state().recording;
    match status.phase {
        RecordingPhase::Idle | RecordingPhase::Joined => Ok(()),
        RecordingPhase::FinishedUnjoined | RecordingPhase::Faulted => {
            let run = status.run.clone().ok_or(SetupFailure::NotAllowed)?;
            match tokio::time::timeout(
                std::time::Duration::from_secs(10),
                supervisor.join_recording(&run),
            )
            .await
            {
                Ok(Ok(_)) => Ok(()),
                _ => Err(SetupFailure::StartFailed),
            }
        }
        _ => Err(SetupFailure::NotAllowed),
    }
}

/// The mapping the apply binds.
enum Binding {
    /// A disabled plan binds none.
    None,
    /// The registered mapping (its revision).
    Registered(u64),
    /// A new mapping, registered over the given revision first.
    New(RecordingMapping, Option<u64>),
}

/// A mapping for `desired` that keeps the registered identity of each
/// member that still fits (same Hub, member, name, value type and period)
/// and draws new identities for the others. Returns the kept member IDs.
fn redraft(
    desired: &Value,
    registered: Option<&RecordingMapping>,
) -> Result<(RecordingMapping, Vec<String>), SetupFailure> {
    let mut mapping = setup::draft(desired)?;
    let Some(registered) = registered.filter(|r| r.hub_ref == mapping.hub_ref) else {
        return Ok((mapping, Vec::new()));
    };
    mapping.hub_instance_id = registered.hub_instance_id.clone();
    let mut kept = Vec::new();
    for member in &mut mapping.members {
        member.identity.hub_instance_id = registered.hub_instance_id.clone();
        if let Some(old) = registered.members.iter().find(|old| {
            old.member_id == member.member_id
                && old.identity.external_name == member.identity.external_name
                && old.identity.value_type == member.identity.value_type
                && old.identity.period_ms == member.identity.period_ms
        }) {
            member.identity = old.identity.clone();
            kept.push(member.member_id.clone());
        }
    }
    Ok((mapping, kept))
}

/// Registers the new mapping if any, then applies `desired` over
/// `applied_revision`, each with a new request ID.
fn apply(
    store: &mut SqliteStore,
    binding: Binding,
    applied_revision: u64,
    retention: Option<u64>,
    desired: Value,
) -> Result<(), SetupFailure> {
    let failed = |error: StoreError| match error {
        StoreError::Conflict => SetupFailure::PlanConflict,
        _ => SetupFailure::StoreFailed,
    };
    let mapping_revision = match binding {
        Binding::None => None,
        Binding::Registered(revision) => Some(revision),
        Binding::New(mapping, expected) => Some(
            store
                .register_recording_mapping(
                    &RegisterMappingRequest {
                        request_id: setup::new_id("mapping"),
                        expected_mapping_revision: expected,
                        mapping,
                    },
                    &setup::control(),
                )
                .map_err(failed)?
                .mapping_revision,
        ),
    };
    store
        .apply_recording_plan(
            &ApplyRecordingPlanRequest {
                request_id: setup::new_id("apply"),
                expected_applied_revision: Some(applied_revision),
                desired,
                expected_mapping_revision: mapping_revision,
                expected_retention_applied_revision: mapping_revision.and(retention),
            },
            &setup::control(),
        )
        .map_err(failed)?;
    Ok(())
}
