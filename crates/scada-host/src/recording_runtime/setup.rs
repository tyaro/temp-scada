//! First setup and start of recording (product-owner design §5
//! `recording_initial_setup`, C5-2).
//!
//! Each step is decided from what the store holds, so a call whose outcome
//! was unknown (a lost reply, a failed write, a process that stopped half
//! way) is simply called again: a registered mapping that fits the Project's
//! plan is used again, an applied retention policy is kept, and the plan the
//! same setup applied is started if it never was. The store's CAS on each
//! revision keeps a repeat from applying anything twice.
use super::sdk;
use banto_tagclient::{BindingRequest, BindingView, GenerationSnapshot, RestClient, ValueSource};
use scada_historian::store::query::QueryControl;
use scada_historian::store::recording_plan::{
    ApplyRecordingPlanRequest, RecordingMapping, RecordingMappingMember, RecordingPlanState,
    RegisterMappingRequest,
};
use scada_historian::store::retention::application::{
    PolicyApplyRequest, PolicyPreparationRequest,
};
use scada_historian::store::retention::clock_guard::{CutoffRule, RetentionClockPolicy};
use scada_historian::store::{IdentityDescriptor, SessionSpec, Source, SqliteStore, ValueType};
use scada_runtime::recorder_source::SdkRecorderPlan;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

/// The default retention (design §8-4): 30 days of elapsed time.
pub const DEFAULT_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;
pub const DEFAULT_RETENTION_POLICY_ID: &str = "retention:default";
/// The recorder's bound on the drift between adjacent wall and monotonic
/// clock readings; a larger step stops the recording.
pub const MAX_CLOCK_SKEW_MS: u64 = 1000;
/// Each bounded store step of the setup.
const STORE_TIMEOUT: Duration = Duration::from_secs(10);

/// Why the first setup did not start recording. `as_str` is the command's
/// error. Each is safe to call again after.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetupFailure {
    /// The recording DB is not open (see the runtime's reason).
    Unavailable,
    /// The store already has another applied plan or recorded under it, or
    /// recording is not stopped: later changes are not the first setup.
    NotAllowed,
    /// Another recording operation holds the writer.
    Busy,
    NoRecordingPlan,
    PlanDisabled,
    InvalidPlan,
    /// No Hub is configured for this host.
    HubNotConfigured,
    HubUnauthorized,
    /// The Hub did not give a live generation in time.
    HubUnavailable,
    /// A plan member's tag is not in the Hub's catalog.
    TagsUnresolved,
    /// The Hub's tags do not fit the plan or its registered mapping (type,
    /// source, or a recorded member's identity).
    ResolutionMismatch,
    /// A store step failed; whether it was saved is read again next time.
    StoreFailed,
    /// Recording was accepted but stopped before running.
    StartFailed,
}

impl SetupFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::NotAllowed => "not_allowed",
            Self::Busy => "busy",
            Self::NoRecordingPlan => "no_recording_plan",
            Self::PlanDisabled => "plan_disabled",
            Self::InvalidPlan => "invalid_plan",
            Self::HubNotConfigured => "hub_not_configured",
            Self::HubUnauthorized => "hub_unauthorized",
            Self::HubUnavailable => "hub_unavailable",
            Self::TagsUnresolved => "tags_unresolved",
            Self::ResolutionMismatch => "resolution_mismatch",
            Self::StoreFailed => "store_failed",
            Self::StartFailed => "start_failed",
        }
    }
}

pub(super) fn control() -> QueryControl {
    QueryControl::with_timeout(STORE_TIMEOUT).expect("fixed store timeout")
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}:{}", uuid::Uuid::new_v4())
}

/// The default retention policy (design §8-4). The clock guard bounds are
/// explicit values of this host, not library defaults. No initial cutoff
/// ceiling: nothing is deleted before retention is operated (C6).
pub fn default_retention_policy() -> RetentionClockPolicy {
    RetentionClockPolicy {
        policy_id: DEFAULT_RETENTION_POLICY_ID.into(),
        revision: 1,
        cutoff_rule: CutoffRule::Elapsed {
            retain_for_ms: DEFAULT_RETENTION_MS,
        },
        tolerance_ms: 2000,
        max_observation_gap_ms: 60 * 60 * 1000,
        max_cutoff_advance_ms: 24 * 60 * 60 * 1000,
        initial_cutoff_ceiling_ms: None,
    }
}

/// `desired` with its members in `memberId` order, as the store keeps it.
fn canonical(desired: &Value) -> Value {
    let mut value = desired.clone();
    if let Some(members) = value["group"]["members"].as_array_mut() {
        members.sort_by(|a, b| a["memberId"].as_str().cmp(&b["memberId"].as_str()));
    }
    value
}

fn value_type(member: &Value) -> Option<ValueType> {
    match member["valueType"].as_str()? {
        "number" => Some(ValueType::Number),
        "bool" => Some(ValueType::Bool),
        _ => None,
    }
}

/// Whether `mapping` resolves `desired` (the store's resolution rule).
fn fits(mapping: &RecordingMapping, desired: &Value) -> bool {
    let group = &desired["group"];
    let Some(members) = group["members"].as_array() else {
        return false;
    };
    group["hubRef"] == mapping.hub_ref.as_str()
        && members.len() == mapping.members.len()
        && members.iter().all(|member| {
            mapping.members.iter().any(|row| {
                member["memberId"] == row.member_id.as_str()
                    && member["externalName"] == row.identity.external_name.as_str()
                    && value_type(member) == Some(row.identity.value_type)
                    && group["periodMs"].as_u64() == Some(row.identity.period_ms)
            })
        })
}

/// What the store already holds for this setup (read before the Hub).
pub(super) struct Found {
    /// The registered mapping fits the plan: its identities are kept.
    pub mapping: Option<RecordingMapping>,
    pub mapping_revision: Option<u64>,
    pub retention_revision: Option<u64>,
    /// This plan is already applied (an earlier call of this setup).
    pub applied: bool,
}

/// Decides from `state` whether this is (still) the first setup.
pub(super) fn find(
    state: &RecordingPlanState,
    retention_revision: Option<u64>,
    activated: bool,
    active: bool,
    desired: &Value,
) -> Result<Found, SetupFailure> {
    if active {
        return Err(SetupFailure::NotAllowed);
    }
    let applied = match &state.applied {
        None => false,
        // The same setup applied it and nothing has recorded under it yet.
        Some(applied)
            if !activated
                && applied.receipt.enabled
                && canonical(&applied.request.desired) == canonical(desired) =>
        {
            true
        }
        Some(_) => return Err(SetupFailure::NotAllowed),
    };
    let registered = state.mapping.as_ref();
    let mapping = registered
        .filter(|m| fits(&m.mapping, desired))
        .map(|m| m.mapping.clone());
    if applied && mapping.is_none() {
        return Err(SetupFailure::NotAllowed);
    }
    Ok(Found {
        mapping,
        mapping_revision: registered.map(|m| m.receipt.mapping_revision),
        retention_revision,
        applied,
    })
}

/// The binding requests of a mapping: binding key = series ID.
pub(super) fn requests(mapping: &RecordingMapping) -> Vec<BindingRequest> {
    mapping
        .members
        .iter()
        .map(|m| BindingRequest {
            binding_key: m.identity.series_id.clone(),
            external_name: m.identity.external_name.clone(),
        })
        .collect()
}

/// A new mapping for `desired` with identities this host draws: a new Hub
/// instance, and a new series, incarnation and segment per member. Nothing
/// is derived from names or the Hub's counters. Source and unit are filled
/// from the resolution ([`complete`]).
pub(super) fn draft(desired: &Value) -> Result<RecordingMapping, SetupFailure> {
    let group = &desired["group"];
    let hub_instance_id = new_id("hub");
    let period_ms = group["periodMs"]
        .as_u64()
        .ok_or(SetupFailure::InvalidPlan)?;
    let members = group["members"]
        .as_array()
        .ok_or(SetupFailure::InvalidPlan)?
        .iter()
        .map(|member| {
            Ok(RecordingMappingMember {
                member_id: member["memberId"]
                    .as_str()
                    .ok_or(SetupFailure::InvalidPlan)?
                    .into(),
                identity: IdentityDescriptor {
                    series_id: new_id("series"),
                    hub_instance_id: hub_instance_id.clone(),
                    incarnation_id: new_id("incarnation"),
                    external_name: member["externalName"]
                        .as_str()
                        .ok_or(SetupFailure::InvalidPlan)?
                        .into(),
                    segment_id: new_id("segment"),
                    value_type: value_type(member).ok_or(SetupFailure::InvalidPlan)?,
                    unit: None,
                    period_ms,
                    source: Source::Unknown,
                },
            })
        })
        .collect::<Result<Vec<_>, SetupFailure>>()?;
    Ok(RecordingMapping {
        hub_ref: group["hubRef"]
            .as_str()
            .ok_or(SetupFailure::InvalidPlan)?
            .into(),
        hub_instance_id,
        members,
    })
}

/// Fills a drafted mapping's source (the value's own, not the catalog
/// label) and unit from the resolution.
pub(super) fn complete(
    mapping: &mut RecordingMapping,
    snapshot: &GenerationSnapshot,
) -> Result<(), SetupFailure> {
    for member in &mut mapping.members {
        let Some(BindingView::Resolved {
            tag,
            value: Some(value),
            ..
        }) = snapshot.binding(&member.identity.series_id)
        else {
            return Err(SetupFailure::TagsUnresolved);
        };
        member.identity.unit = tag.unit.clone();
        member.identity.source = match value.value_source {
            ValueSource::Real => Source::Real,
            ValueSource::Computed => Source::Computed,
            ValueSource::Internal => Source::Internal,
            ValueSource::Db => Source::Db,
            ValueSource::Simulation => Source::Simulation,
            ValueSource::DerivedSimulation => Source::DerivedSimulation,
            ValueSource::Unknown(_) => Source::Unknown,
        };
    }
    Ok(())
}

/// Checks that `snapshot` can record `mapping` (types, sources, one
/// generation) before anything is saved; the start checks it again.
pub(super) fn check(
    mapping: &RecordingMapping,
    snapshot: &GenerationSnapshot,
) -> Result<(), SetupFailure> {
    let session = SessionSpec {
        session_id: "setup-check".into(),
        members: mapping.members.iter().map(|m| m.identity.clone()).collect(),
    };
    SdkRecorderPlan::from_generation(session, snapshot)
        .map(|_| ())
        .map_err(|_| SetupFailure::ResolutionMismatch)
}

/// Saves what is missing: the mapping, the default retention policy and the
/// plan, each with a new request ID and the revisions read before.
pub(super) fn save(
    store: &mut SqliteStore,
    found: &Found,
    mapping: &RecordingMapping,
    new_mapping: bool,
    desired: &Value,
) -> Result<(), SetupFailure> {
    let failed = |_| SetupFailure::StoreFailed;
    let mapping_revision = if new_mapping {
        store
            .register_recording_mapping(
                &RegisterMappingRequest {
                    request_id: new_id("mapping"),
                    expected_mapping_revision: found.mapping_revision,
                    mapping: mapping.clone(),
                },
                &control(),
            )
            .map_err(failed)?
            .mapping_revision
    } else {
        found.mapping_revision.ok_or(SetupFailure::StoreFailed)?
    };
    let retention_revision = match found.retention_revision {
        Some(revision) => revision,
        None => {
            let policy = default_retention_policy();
            let reference_wall_ms = now_ms();
            let preview = store
                .preview_retention_policy_application(
                    &PolicyPreparationRequest {
                        proposed_policy: policy.clone(),
                        reference_wall_ms,
                    },
                    &control(),
                )
                .map_err(failed)?;
            store
                .apply_retention_policy(
                    &PolicyApplyRequest {
                        request_id: new_id("retention"),
                        expected_applied_revision: preview.expected_applied_revision,
                        expected_preview_snapshot_commit: preview.snapshot_commit,
                        proposed_policy: policy,
                        reference_wall_ms,
                    },
                    &control(),
                )
                .map_err(failed)?
                .applied_revision
        }
    };
    if !found.applied {
        store
            .apply_recording_plan(
                &ApplyRecordingPlanRequest {
                    request_id: new_id("apply"),
                    expected_applied_revision: None,
                    desired: desired.clone(),
                    expected_mapping_revision: Some(mapping_revision),
                    expected_retention_applied_revision: Some(retention_revision),
                },
                &control(),
            )
            .map_err(failed)?;
    }
    Ok(())
}

/// The fresh SDK resolution of `mapping`.
pub(super) async fn resolve(
    client: RestClient,
    mapping: &RecordingMapping,
) -> Result<Arc<GenerationSnapshot>, SetupFailure> {
    sdk::resolve(client, requests(mapping), sdk::RESOLVE_TIMEOUT).await
}
