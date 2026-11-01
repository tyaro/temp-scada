//! One explicit retention turn: discovery, clock assessment, at most one job API.
//! This is a library entry point, not a scheduler or a recorder controller.
use super::{
    clock_guard::{
        assess_retention, Assessment, ClockSample, GuardState, InvalidInput, RetentionAction,
        RetentionClockPolicy,
    },
    jobs::{JobBeginReceipt, JobRequest, JobStepReceipt, JobStepRequest},
};
use crate::store::{
    query::QueryControl, recovery::StoreRecoveryState, SqliteStore, StoreError, StoreResult,
};
use serde::Serialize;
use std::fmt;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "request", rename_all = "camelCase")]
pub enum CoordinatorIntent {
    Observe,
    Begin(JobRequest),
    ContinueExisting(JobStepRequest),
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoordinatorInput {
    pub policy: RetentionClockPolicy,
    pub guard_state: GuardState,
    pub sample: ClockSample,
    /// Some for ExplicitCandidate; None for Elapsed, derived from this sample.
    pub candidate_cutoff_ms: Option<i64>,
    pub intent: CoordinatorIntent,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NoWriteReason {
    /// Consult assessment.action for the clock, cutoff, job, or recording reason.
    NotProposed,
    BeginRequestMismatch,
    NoActiveJob,
    DifferentActiveJob,
    PolicyNotApplied,
    AppliedPolicyMismatch,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
pub enum CoordinatorOutcome {
    Observed,
    NoWrite { reason: NoWriteReason },
    Begun(JobBeginReceipt),
    Stepped(JobStepReceipt),
}

#[derive(Debug)]
pub enum CoordinatorError {
    Store(StoreError),
    Assessment(InvalidInput),
}
impl fmt::Display for CoordinatorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Store(error) => write!(f, "{error}"),
            Self::Assessment(error) => write!(f, "{error}"),
        }
    }
}
impl std::error::Error for CoordinatorError {}

/// Always retain next_state, including on execution failure. Any Err stops the
/// caller's automatic path; never reuse an older proposal as an authorization.
#[derive(Debug)]
pub struct CoordinatorReport {
    pub next_state: GuardState,
    /// None if discovery failed or assessment rejected its inputs.
    pub assessment: Option<Assessment>,
    /// Pre-operation snapshot, never a claim about post-operation state.
    pub recovery: Option<StoreRecoveryState>,
    /// Assessment contract errors require input repair and explicit rearm.
    pub rearm_required: bool,
    pub outcome: Result<CoordinatorOutcome, CoordinatorError>,
}

impl SqliteStore {
    /// Uses one shared deadline/token with independent budgets for discovery and
    /// at most one begin/step. Never loops, retries, closes sessions, or rearms.
    pub fn coordinate_retention_once(
        &mut self,
        input: &CoordinatorInput,
        control: &QueryControl,
    ) -> CoordinatorReport {
        self.coordinate_with_hook(input, control, &mut |_| Ok(()))
    }

    fn coordinate_with_hook(
        &mut self,
        input: &CoordinatorInput,
        control: &QueryControl,
        hook: &mut impl FnMut(&mut Self) -> StoreResult<()>,
    ) -> CoordinatorReport {
        let mut report = CoordinatorReport {
            next_state: input.guard_state.clone(),
            assessment: None,
            recovery: None,
            rearm_required: false,
            outcome: Ok(CoordinatorOutcome::Observed),
        };
        let recovery = match self.recovery_state(control) {
            Ok(state) => state,
            Err(error) => {
                report.outcome = Err(CoordinatorError::Store(error));
                return report;
            }
        };
        let assessment = assess_retention(
            &input.policy,
            &input.guard_state,
            &input.sample,
            input.candidate_cutoff_ms,
            &recovery,
        );
        report.recovery = Some(recovery);
        let assessment = match assessment {
            Ok(assessment) => assessment,
            Err(error) => {
                report.rearm_required = true;
                report.outcome = Err(CoordinatorError::Assessment(error));
                return report;
            }
        };
        report.next_state = assessment.next_state.clone();
        report.assessment = Some(assessment);
        report.outcome = self
            .execute_coordinated(input, &report, control, hook)
            .map_err(CoordinatorError::Store);
        report
    }

    fn execute_coordinated(
        &mut self,
        input: &CoordinatorInput,
        report: &CoordinatorReport,
        control: &QueryControl,
        hook: &mut impl FnMut(&mut Self) -> StoreResult<()>,
    ) -> StoreResult<CoordinatorOutcome> {
        let assessment = report
            .assessment
            .as_ref()
            .expect("assessed before execution");
        let recovery = report
            .recovery
            .as_ref()
            .expect("discovered before execution");
        let no_write = |reason| Ok(CoordinatorOutcome::NoWrite { reason });
        match &input.intent {
            CoordinatorIntent::Observe => Ok(CoordinatorOutcome::Observed),
            CoordinatorIntent::Begin(request) => {
                let RetentionAction::ProposeJob {
                    cutoff_ms,
                    expected_cutoff_ms,
                    ..
                } = &assessment.action
                else {
                    return no_write(NoWriteReason::NotProposed);
                };
                let Some(applied) = &recovery.applied_retention_policy else {
                    return no_write(NoWriteReason::PolicyNotApplied);
                };
                if applied.policy != input.policy {
                    return no_write(NoWriteReason::AppliedPolicyMismatch);
                }
                if request.cutoff_ms != *cutoff_ms
                    || request.expected_cutoff_ms != *expected_cutoff_ms
                {
                    return no_write(NoWriteReason::BeginRequestMismatch);
                }
                hook(self)?;
                self.begin_retention_job_bound(request.clone(), applied, control)
                    .map(CoordinatorOutcome::Begun)
            }
            CoordinatorIntent::ContinueExisting(request) => {
                let Some(active) = &recovery.active_job else {
                    return no_write(NoWriteReason::NoActiveJob);
                };
                if request.job_id != active.status.job_id {
                    return no_write(NoWriteReason::DifferentActiveJob);
                }
                // An explicit request for an already started job is distinct
                // from clock authorization for a new cutoff. Preserve the exact
                // step/max_ticks so reply-loss retries cannot advance the job.
                hook(self)?;
                self.step_retention_job(request.clone(), control)
                    .map(CoordinatorOutcome::Stepped)
            }
        }
    }
}

#[cfg(test)]
mod tests;
