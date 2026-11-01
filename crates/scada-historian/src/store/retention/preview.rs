//! Read-only impact of caller-supplied elapsed policies on one raw snapshot.
//! Comparison policy is not a claim about a persisted/applied configuration.
use super::{clock_guard::RetentionClockPolicy, policy::derive_cutoff};
use crate::store::{
    query::{control::Budget, QueryControl},
    recovery::{self, StoreRecoveryState},
    SqliteStore, StoreError, StoreResult, MAX_SAFE,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionPreviewRequest {
    pub reference_wall_ms: i64,
    pub proposed_policy: RetentionClockPolicy,
    pub comparison_policy: Option<RetentionClockPolicy>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetCounts {
    pub ticks: u64,
    pub observations: u64,
    pub series: u64,
    pub earliest_sample_ms: Option<i64>,
    pub latest_sample_ms: Option<i64>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewRange {
    pub from_ms: i64,
    pub to_ms: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RangeImpact {
    pub range: Option<PreviewRange>,
    pub targets: TargetCounts,
}
impl RangeImpact {
    fn empty() -> Self {
        Self {
            range: None,
            targets: TargetCounts::default(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyImpact {
    pub policy: RetentionClockPolicy,
    pub cutoff_ms: i64,
    pub targets: TargetCounts,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum DurationChange {
    Shorter,
    Longer,
    SameDuration,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyDifference {
    pub change: DurationChange,
    pub newly_targeted: RangeImpact,
    pub no_longer_targeted: RangeImpact,
}
/// Counts existing query rows only, with no reservation or deletion authority.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionPreview {
    pub recovery: StoreRecoveryState,
    pub reference_wall_ms: i64,
    pub proposed: PolicyImpact,
    pub comparison: Option<PolicyImpact>,
    pub difference: Option<PolicyDifference>,
}

impl SqliteStore {
    pub fn preview_retention_change(
        &mut self,
        request: &RetentionPreviewRequest,
        control: &QueryControl,
    ) -> StoreResult<RetentionPreview> {
        self.preview_with_hook(request, control, &mut || Ok(()))
    }

    fn preview_with_hook(
        &mut self,
        request: &RetentionPreviewRequest,
        control: &QueryControl,
        hook: &mut impl FnMut() -> StoreResult<()>,
    ) -> StoreResult<RetentionPreview> {
        derive_policies(request)?;
        self.run_maintenance(control, true, |connection, budget| {
            budget.work.statement()?;
            connection.execute_batch("BEGIN DEFERRED")?;
            let recovery = recovery::read_snapshot(connection, budget, &mut || Ok(()))?;
            hook()?;
            let report = build_preview(connection, budget, request, recovery)?;
            budget.result(&serde_json::to_value(&report)?)?;
            budget.work.statement()?;
            connection.execute_batch("ROLLBACK")?;
            Ok(report)
        })
    }
}

fn derive_policies(request: &RetentionPreviewRequest) -> StoreResult<(i64, Option<i64>)> {
    let derive = |p| {
        derive_cutoff(p, request.reference_wall_ms)
            .map(|d| d.cutoff_ms)
            .map_err(|_| {
                StoreError::Invalid("preview requires valid elapsed policies and reference time")
            })
    };
    let proposed_cutoff = derive(&request.proposed_policy)?;
    let comparison_cutoff = request.comparison_policy.as_ref().map(derive).transpose()?;
    Ok((proposed_cutoff, comparison_cutoff))
}

pub(super) fn build_preview(
    connection: &Connection,
    budget: &mut Budget,
    request: &RetentionPreviewRequest,
    recovery: StoreRecoveryState,
) -> StoreResult<RetentionPreview> {
    let (proposed_cutoff, comparison_cutoff) = derive_policies(request)?;
    let maximum = comparison_cutoff.map_or(proposed_cutoff, |t| t.max(proposed_cutoff));
    validate_targets(connection, budget, maximum, recovery.snapshot_commit)?;
    let proposed = PolicyImpact {
        policy: request.proposed_policy.clone(),
        cutoff_ms: proposed_cutoff,
        targets: counts(connection, budget, None, proposed_cutoff)?,
    };
    let comparison = match (&request.comparison_policy, comparison_cutoff) {
        (Some(policy), Some(cutoff)) => Some(PolicyImpact {
            policy: policy.clone(),
            cutoff_ms: cutoff,
            targets: counts(connection, budget, None, cutoff)?,
        }),
        _ => None,
    };
    let difference = if let Some(old) = &comparison {
        let mut result = PolicyDifference {
            change: DurationChange::SameDuration,
            newly_targeted: RangeImpact::empty(),
            no_longer_targeted: RangeImpact::empty(),
        };
        if proposed_cutoff != old.cutoff_ms {
            let from = proposed_cutoff.min(old.cutoff_ms);
            let to = proposed_cutoff.max(old.cutoff_ms);
            let range = RangeImpact {
                range: Some(PreviewRange {
                    from_ms: from,
                    to_ms: to,
                }),
                targets: counts(connection, budget, Some(from), to)?,
            };
            if proposed_cutoff > old.cutoff_ms {
                result.change = DurationChange::Shorter;
                result.newly_targeted = range;
            } else {
                result.change = DurationChange::Longer;
                result.no_longer_targeted = range;
            }
        }
        Some(result)
    } else {
        None
    };
    let report = RetentionPreview {
        recovery,
        reference_wall_ms: request.reference_wall_ms,
        proposed,
        comparison,
        difference,
    };
    validate_saved_preview(&report)?;
    Ok(report)
}

pub(super) fn validate_saved_preview(report: &RetentionPreview) -> StoreResult<()> {
    super::clock_guard::validate::recovery(&report.recovery)
        .map_err(|_| StoreError::CorruptData)?;
    let derive = |policy: &RetentionClockPolicy| {
        derive_cutoff(policy, report.reference_wall_ms)
            .map(|d| d.cutoff_ms)
            .map_err(|_| StoreError::CorruptData)
    };
    if derive(&report.proposed.policy)? != report.proposed.cutoff_ms {
        return Err(StoreError::CorruptData);
    }
    validate_counts(&report.proposed.targets, None, report.proposed.cutoff_ms)?;
    match (&report.comparison, &report.difference) {
        (None, None) => {}
        (Some(old), Some(diff)) => {
            if derive(&old.policy)? != old.cutoff_ms {
                return Err(StoreError::CorruptData);
            }
            validate_counts(&old.targets, None, old.cutoff_ms)?;
            let from = old.cutoff_ms.min(report.proposed.cutoff_ms);
            let to = old.cutoff_ms.max(report.proposed.cutoff_ms);
            let expected = if old.cutoff_ms < report.proposed.cutoff_ms {
                DurationChange::Shorter
            } else if old.cutoff_ms > report.proposed.cutoff_ms {
                DurationChange::Longer
            } else {
                DurationChange::SameDuration
            };
            if diff.change != expected {
                return Err(StoreError::CorruptData);
            }
            let (changed, empty) = if expected == DurationChange::Longer {
                (&diff.no_longer_targeted, &diff.newly_targeted)
            } else {
                (&diff.newly_targeted, &diff.no_longer_targeted)
            };
            if *empty != RangeImpact::empty() {
                return Err(StoreError::CorruptData);
            }
            if expected == DurationChange::SameDuration {
                if *changed != RangeImpact::empty() {
                    return Err(StoreError::CorruptData);
                }
            } else {
                if changed.range
                    != Some(PreviewRange {
                        from_ms: from,
                        to_ms: to,
                    })
                {
                    return Err(StoreError::CorruptData);
                }
                validate_counts(&changed.targets, Some(from), to)?;
            }
        }
        _ => return Err(StoreError::CorruptData),
    }
    if let (Some(old), Some(diff)) = (&report.comparison, &report.difference) {
        let (smaller, added, larger) = match diff.change {
            DurationChange::Shorter => (
                &old.targets,
                &diff.newly_targeted.targets,
                &report.proposed.targets,
            ),
            DurationChange::Longer => (
                &report.proposed.targets,
                &diff.no_longer_targeted.targets,
                &old.targets,
            ),
            DurationChange::SameDuration => (
                &old.targets,
                &diff.newly_targeted.targets,
                &report.proposed.targets,
            ),
        };
        if smaller.ticks.checked_add(added.ticks) != Some(larger.ticks)
            || smaller.observations.checked_add(added.observations) != Some(larger.observations)
            || (diff.change == DurationChange::SameDuration && smaller != larger)
        {
            return Err(StoreError::CorruptData);
        }
    }
    Ok(())
}

fn validate_counts(c: &TargetCounts, from: Option<i64>, to: i64) -> StoreResult<()> {
    if [c.ticks, c.observations, c.series]
        .iter()
        .any(|n| *n > MAX_SAFE)
        || c.ticks > c.observations
        || c.observations > c.ticks.saturating_mul(8)
        || c.series > c.observations
        || (c.observations == 0
            && (c.ticks != 0
                || c.series != 0
                || c.earliest_sample_ms.is_some()
                || c.latest_sample_ms.is_some()))
        || (c.observations > 0
            && (c.ticks == 0
                || c.series == 0
                || c.earliest_sample_ms.is_none()
                || c.latest_sample_ms.is_none()))
        || c.earliest_sample_ms
            .zip(c.latest_sample_ms)
            .is_some_and(|(a, b)| {
                a > b
                    || !super::safe(a)
                    || !super::safe(b)
                    || from.is_some_and(|f| a < f)
                    || b >= to
            })
    {
        return Err(StoreError::CorruptData);
    }
    Ok(())
}

fn validate_targets(
    connection: &Connection,
    budget: &mut Budget,
    cutoff: i64,
    snapshot: u64,
) -> StoreResult<()> {
    budget.work.statement()?;
    let corrupt: bool = connection.query_row(
        include_str!("preview/validate.sql"),
        params![cutoff, snapshot as i64],
        |r| r.get(0),
    )?;
    budget.row()?;
    if corrupt {
        return Err(StoreError::CorruptData);
    }
    Ok(())
}

type CountsRow = (i64, i64, i64, Option<i64>, Option<i64>);
fn counts(
    connection: &Connection,
    budget: &mut Budget,
    from: Option<i64>,
    to: i64,
) -> StoreResult<TargetCounts> {
    budget.work.statement()?;
    let (ticks, observations, series, earliest, latest): CountsRow =
        connection.query_row(include_str!("preview/counts.sql"), params![from, to], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?;
    budget.row()?;
    if [ticks, observations, series].iter().any(|n| *n < 0) {
        return Err(StoreError::CorruptData);
    }
    let result = TargetCounts {
        ticks: ticks as u64,
        observations: observations as u64,
        series: series as u64,
        earliest_sample_ms: earliest,
        latest_sample_ms: latest,
    };
    validate_counts(&result, from, to)?;
    Ok(result)
}

#[cfg(test)]
mod tests;
