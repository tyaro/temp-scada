//! Pure assessment of caller-supplied retention candidates and clock continuity.
//! No clock, timezone, policy defaults, job ID generation, or DB work occurs here.
mod validate;
use crate::store::recovery::StoreRecoveryState;
use serde::Serialize;
use std::fmt;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RetentionClockPolicy {
    pub policy_id: String,
    pub revision: u64,
    pub tolerance_ms: u64,
    pub max_observation_gap_ms: u64,
    pub max_cutoff_advance_ms: u64,
    pub initial_cutoff_ceiling_ms: Option<i64>,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClockSample {
    pub clock_epoch: String,
    pub wall_time_ms: i64,
    pub monotonic_ms: u64,
    pub trusted: bool,
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SuspendReason {
    MalformedClockSample,
    UntrustedClock,
    PolicyChanged,
    ClockEpochChanged,
    WallClockRegressed,
    MonotonicClockRegressed,
    MonotonicClockDiscontinuity,
    ObservationGap,
    ClockDriftExceeded,
}
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum GuardState {
    #[default]
    Unarmed,
    Primed {
        policy_snapshot: RetentionClockPolicy,
        last_sample: ClockSample,
    },
    Tracking {
        policy_snapshot: RetentionClockPolicy,
        last_sample: ClockSample,
    },
    Suspended {
        reason: SuspendReason,
    },
}
impl GuardState {
    /// Explicit caller reset; a new baseline still requires two trusted samples.
    pub fn rearm(&self) -> Self {
        Self::Unarmed
    }
}
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeferredReason {
    CutoffBeyondClock,
    CutoffAdvanceLimit,
    InitialCutoffNotAuthorized,
    InitialCutoffLimit,
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RetentionAction {
    ExistingJob {
        job_id: String,
    },
    WaitForClock,
    Deferred {
        reason: DeferredReason,
    },
    NoAdvance,
    WaitForRecordingStop {
        session_id: String,
    },
    ProposeJob {
        cutoff_ms: i64,
        expected_cutoff_ms: Option<i64>,
        snapshot_commit: u64,
        policy_id: String,
        revision: u64,
    },
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Assessment {
    pub next_state: GuardState,
    pub action: RetentionAction,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvalidInput {
    Policy,
    GuardState,
    RecoveryState,
    Cutoff,
}
impl fmt::Display for InvalidInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "invalid retention {}",
            match self {
                Self::Policy => "clock policy",
                Self::GuardState => "guard state",
                Self::RecoveryState => "recovery state",
                Self::Cutoff => "cutoff",
            }
        )
    }
}
impl std::error::Error for InvalidInput {}

/// Returns an advisory candidate, never a deletion authorization or a lease.
/// On InvalidInput the caller must stop its automatic path rather than reuse a
/// previous proposal/state; fix the input and explicitly rearm as appropriate.
pub fn assess_retention(
    policy: &RetentionClockPolicy,
    state: &GuardState,
    sample: &ClockSample,
    candidate_cutoff_ms: i64,
    recovery: &StoreRecoveryState,
) -> Result<Assessment, InvalidInput> {
    validate::policy(policy)?;
    validate::state(state)?;
    validate::recovery(recovery)?;
    if !validate::safe(candidate_cutoff_ms) {
        return Err(InvalidInput::Cutoff);
    }
    let (next_state, stable) = advance(policy, state, sample);
    let action = if let Some(job) = &recovery.active_job {
        RetentionAction::ExistingJob {
            job_id: job.status.job_id.clone(),
        }
    } else if !stable {
        RetentionAction::WaitForClock
    } else {
        candidate(policy, sample, candidate_cutoff_ms, recovery)
    };
    Ok(Assessment { next_state, action })
}

fn suspended(reason: SuspendReason) -> (GuardState, bool) {
    (GuardState::Suspended { reason }, false)
}
fn advance(
    policy: &RetentionClockPolicy,
    state: &GuardState,
    sample: &ClockSample,
) -> (GuardState, bool) {
    if matches!(state, GuardState::Suspended { .. }) {
        return (state.clone(), false);
    }
    if !validate::sample(sample) {
        return suspended(SuspendReason::MalformedClockSample);
    }
    if !sample.trusted {
        return suspended(SuspendReason::UntrustedClock);
    }
    let (previous_policy, last) = match state {
        GuardState::Unarmed => {
            return (
                GuardState::Primed {
                    policy_snapshot: policy.clone(),
                    last_sample: sample.clone(),
                },
                false,
            )
        }
        GuardState::Primed {
            policy_snapshot,
            last_sample,
        }
        | GuardState::Tracking {
            policy_snapshot,
            last_sample,
        } => (policy_snapshot, last_sample),
        GuardState::Suspended { .. } => unreachable!(),
    };
    if policy != previous_policy {
        return suspended(SuspendReason::PolicyChanged);
    }
    if sample.clock_epoch != last.clock_epoch {
        return suspended(SuspendReason::ClockEpochChanged);
    }
    let Some(mono_delta) = sample.monotonic_ms.checked_sub(last.monotonic_ms) else {
        return suspended(SuspendReason::MonotonicClockRegressed);
    };
    if mono_delta == 0 {
        return if sample.wall_time_ms == last.wall_time_ms {
            (state.clone(), false)
        } else {
            suspended(SuspendReason::MonotonicClockDiscontinuity)
        };
    }
    if sample.wall_time_ms < last.wall_time_ms {
        return suspended(SuspendReason::WallClockRegressed);
    }
    if mono_delta > policy.max_observation_gap_ms {
        return suspended(SuspendReason::ObservationGap);
    }
    let wall_delta = (sample.wall_time_ms as i128 - last.wall_time_ms as i128) as u128;
    if wall_delta.abs_diff(mono_delta as u128) > policy.tolerance_ms as u128 {
        return suspended(SuspendReason::ClockDriftExceeded);
    }
    (
        GuardState::Tracking {
            policy_snapshot: policy.clone(),
            last_sample: sample.clone(),
        },
        true,
    )
}

fn candidate(
    policy: &RetentionClockPolicy,
    sample: &ClockSample,
    cutoff: i64,
    recovery: &StoreRecoveryState,
) -> RetentionAction {
    if cutoff > sample.wall_time_ms {
        return RetentionAction::Deferred {
            reason: DeferredReason::CutoffBeyondClock,
        };
    }
    if let Some(applied) = recovery.retention_fence.cutoff_ms {
        if cutoff <= applied {
            return RetentionAction::NoAdvance;
        }
        if cutoff as i128 - applied as i128 > policy.max_cutoff_advance_ms as i128 {
            return RetentionAction::Deferred {
                reason: DeferredReason::CutoffAdvanceLimit,
            };
        }
    } else {
        let Some(ceiling) = policy.initial_cutoff_ceiling_ms else {
            return RetentionAction::Deferred {
                reason: DeferredReason::InitialCutoffNotAuthorized,
            };
        };
        if cutoff > ceiling {
            return RetentionAction::Deferred {
                reason: DeferredReason::InitialCutoffLimit,
            };
        }
    }
    if let Some(session) = &recovery.active_session_id {
        return RetentionAction::WaitForRecordingStop {
            session_id: session.clone(),
        };
    }
    RetentionAction::ProposeJob {
        cutoff_ms: cutoff,
        expected_cutoff_ms: recovery.retention_fence.cutoff_ms,
        snapshot_commit: recovery.snapshot_commit,
        policy_id: policy.policy_id.clone(),
        revision: policy.revision,
    }
}

#[cfg(test)]
mod tests;
