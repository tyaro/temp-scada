use super::*;
use crate::store::{
    id,
    recovery::FenceSource,
    retention::{jobs::JobState, MAX_TRIM_TICKS},
    MAX_SAFE,
};

pub(super) fn safe(t: i64) -> bool {
    (-(MAX_SAFE as i64)..=MAX_SAFE as i64).contains(&t)
}
pub(super) fn sample(sample: &ClockSample) -> bool {
    id(&sample.clock_epoch) && safe(sample.wall_time_ms)
}
pub(in crate::store::retention) fn policy(
    policy: &RetentionClockPolicy,
) -> Result<(), InvalidInput> {
    if !id(&policy.policy_id)
        || !(1..=MAX_SAFE).contains(&policy.revision)
        || !(1..=MAX_SAFE).contains(&policy.max_observation_gap_ms)
        || policy.tolerance_ms > policy.max_observation_gap_ms
        || !(1..=MAX_SAFE).contains(&policy.max_cutoff_advance_ms)
        || policy.initial_cutoff_ceiling_ms.is_some_and(|t| !safe(t))
        || matches!(policy.cutoff_rule, CutoffRule::Elapsed { retain_for_ms } if !(1..=MAX_SAFE).contains(&retain_for_ms))
    {
        return Err(InvalidInput::Policy);
    }
    Ok(())
}
pub(super) fn state(state: &GuardState) -> Result<(), InvalidInput> {
    if let GuardState::Primed {
        policy_snapshot,
        last_sample,
    }
    | GuardState::Tracking {
        policy_snapshot,
        last_sample,
    } = state
    {
        if policy(policy_snapshot).is_err() || !sample(last_sample) || !last_sample.trusted {
            return Err(InvalidInput::GuardState);
        }
    }
    Ok(())
}
pub(super) fn recovery(recovery: &StoreRecoveryState) -> Result<(), InvalidInput> {
    let invalid = InvalidInput::RecoveryState;
    let fence = &recovery.retention_fence;
    if recovery.snapshot_commit > i64::MAX as u64
        || fence.revision_commit > recovery.snapshot_commit
        || fence.cutoff_ms.is_some_and(|t| !safe(t))
    {
        return Err(invalid);
    }
    match &fence.source {
        FenceSource::Initial if fence.cutoff_ms.is_none() && fence.revision_commit == 0 => {}
        FenceSource::SingleTrim { request_id }
            if id(request_id) && fence.cutoff_ms.is_some() && fence.revision_commit > 0 => {}
        FenceSource::CompletedJob { job_id }
            if id(job_id) && fence.cutoff_ms.is_some() && fence.revision_commit > 0 => {}
        _ => return Err(invalid),
    }
    if recovery.active_session_id.as_ref().is_some_and(|s| !id(s))
        || (recovery.active_session_id.is_some() && recovery.snapshot_commit == 0)
        || (recovery.active_session_id.is_some() && recovery.active_job.is_some())
    {
        return Err(invalid);
    }
    let Some(active) = &recovery.active_job else {
        return Ok(());
    };
    let job = &active.status;
    if !id(&job.job_id)
        || job.state != JobState::Active
        || !safe(job.cutoff_ms)
        || job.completion_commit.is_some()
        || job.begin_commit <= fence.revision_commit
        || job.begin_commit > recovery.snapshot_commit
        || matches!(&fence.source, FenceSource::CompletedJob { job_id } if job_id == &job.job_id)
        || fence.cutoff_ms.is_some_and(|t| job.cutoff_ms <= t)
        || job.deleted_ticks > MAX_SAFE
        || job.deleted_observations > MAX_SAFE
        || job.deleted_observations < job.deleted_ticks
        || job.deleted_observations > job.deleted_ticks * 8
    {
        return Err(invalid);
    }
    match &active.last_step {
        None if job.next_step == Some(1)
            && job.deleted_ticks == 0
            && job.deleted_observations == 0 => {}
        Some(last) => {
            let request = &last.request;
            let receipt = &last.receipt;
            if request.job_id != job.job_id
                || receipt.job_id != job.job_id
                || !(1..=MAX_SAFE).contains(&request.step)
                || request.step != receipt.step
                || !(1..=MAX_TRIM_TICKS as u32).contains(&request.max_ticks)
                || receipt.completed
                || receipt.commit_version <= job.begin_commit
                || receipt.commit_version > recovery.snapshot_commit
                || receipt.commit_version.saturating_sub(job.begin_commit) < request.step
                || request.step > job.deleted_ticks
                || receipt.deleted_ticks == 0
                || receipt.deleted_ticks > request.max_ticks as usize
                || receipt.deleted_observations < receipt.deleted_ticks
                || receipt.deleted_observations > receipt.deleted_ticks * 8
                || receipt.deleted_ticks as u64 > job.deleted_ticks
                || receipt.deleted_observations as u64 > job.deleted_observations
                || job.next_step != request.step.checked_add(1).filter(|n| *n <= MAX_SAFE)
            {
                return Err(invalid);
            }
            // Every preceding nonfinal step removed 1..=MAX_TRIM_TICKS whole
            // ticks, each containing 1..=8 members. Step one has no prior work.
            let prior_steps = (request.step - 1) as u128;
            let prior_ticks = (job.deleted_ticks - receipt.deleted_ticks as u64) as u128;
            let prior_observations =
                (job.deleted_observations - receipt.deleted_observations as u64) as u128;
            if prior_ticks < prior_steps
                || prior_ticks > prior_steps * MAX_TRIM_TICKS as u128
                || prior_observations < prior_ticks
                || prior_observations > prior_ticks * 8
            {
                return Err(invalid);
            }
        }
        _ => return Err(invalid),
    }
    Ok(())
}
