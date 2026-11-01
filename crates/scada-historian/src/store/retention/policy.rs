//! Explicit elapsed-time retention. Calendar days/timezones are not represented.
use super::{
    clock_guard::{validate, RetentionClockPolicy},
    safe,
};
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CutoffRule {
    ExplicitCandidate,
    /// Exact elapsed milliseconds; never local calendar days or month boundaries.
    Elapsed {
        retain_for_ms: u64,
    },
}

/// An explanation of arithmetic, not a clock trust claim or execution permit.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DerivedCutoff {
    pub policy_id: String,
    pub revision: u64,
    pub reference_wall_ms: i64,
    pub retain_for_ms: u64,
    pub cutoff_ms: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CutoffError {
    InvalidPolicy,
    NotElapsed,
    InvalidReferenceTime,
    OutOfRange,
}
impl fmt::Display for CutoffError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidPolicy => "invalid retention policy",
            Self::NotElapsed => "retention policy is not elapsed time",
            Self::InvalidReferenceTime => "invalid retention reference time",
            Self::OutOfRange => "retention cutoff outside safe time range",
        })
    }
}
impl std::error::Error for CutoffError {}

/// Derives the exclusive UTC cutoff with integer arithmetic and no clamping,
/// rounding, clock read, defaults, or DB work. Trust and execution remain guarded
/// by assess_retention/coordinator using the same sample, not this result.
pub fn derive_cutoff(
    policy: &RetentionClockPolicy,
    reference_wall_ms: i64,
) -> Result<DerivedCutoff, CutoffError> {
    validate::policy(policy).map_err(|_| CutoffError::InvalidPolicy)?;
    let CutoffRule::Elapsed { retain_for_ms } = policy.cutoff_rule else {
        return Err(CutoffError::NotElapsed);
    };
    if !safe(reference_wall_ms) {
        return Err(CutoffError::InvalidReferenceTime);
    }
    let cutoff = reference_wall_ms as i128 - retain_for_ms as i128;
    let cutoff_ms = i64::try_from(cutoff).map_err(|_| CutoffError::OutOfRange)?;
    if !safe(cutoff_ms) {
        return Err(CutoffError::OutOfRange);
    }
    Ok(DerivedCutoff {
        policy_id: policy.policy_id.clone(),
        revision: policy.revision,
        reference_wall_ms,
        retain_for_ms,
        cutoff_ms,
    })
}

#[cfg(test)]
mod tests;
