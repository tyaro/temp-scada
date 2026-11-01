//! Restartable quiescent retention. Published expiry never overlaps retained raw.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobRequest {
    pub job_id: String,
    pub cutoff_ms: i64,
    pub expected_cutoff_ms: Option<i64>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredJobRequest {
    job_id: String,
    cutoff_ms: i64,
    expected_cutoff_ms: Option<i64>,
    policy_applied_revision: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobStepRequest {
    pub job_id: String,
    pub step: u64,
    pub max_ticks: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobBeginReceipt {
    pub job_id: String,
    pub cutoff_ms: i64,
    pub begin_commit: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobStepReceipt {
    pub job_id: String,
    pub step: u64,
    pub commit_version: u64,
    pub deleted_ticks: usize,
    pub deleted_observations: usize,
    pub completed: bool,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Active,
    Complete,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub job_id: String,
    pub cutoff_ms: i64,
    pub state: JobState,
    /// None after completion or exhaustion of the safe step counter.
    pub next_step: Option<u64>,
    pub deleted_ticks: u64,
    pub deleted_observations: u64,
    pub begin_commit: u64,
    pub completion_commit: Option<u64>,
    pub policy_applied_revision: Option<u64>,
}
struct Job {
    request: JobRequest,
    state: JobState,
    begin: i64,
    last: u64,
    ticks: u64,
    observations: u64,
    completion: Option<i64>,
    latest_commit: u64,
    policy_applied_revision: Option<u64>,
}

impl SqliteStore {
    pub fn begin_retention_job(
        &mut self,
        request: JobRequest,
        control: &QueryControl,
    ) -> StoreResult<JobBeginReceipt> {
        self.begin_job(request, None, control)
    }

    pub(super) fn begin_retention_job_bound(
        &mut self,
        request: JobRequest,
        applied: &super::application::AppliedRetentionPolicy,
        control: &QueryControl,
    ) -> StoreResult<JobBeginReceipt> {
        self.begin_job(request, Some(applied), control)
    }

    fn begin_job(
        &mut self,
        request: JobRequest,
        applied: Option<&super::application::AppliedRetentionPolicy>,
        control: &QueryControl,
    ) -> StoreResult<JobBeginReceipt> {
        if !id(&request.job_id)
            || !safe(request.cutoff_ms)
            || request.expected_cutoff_ms.is_some_and(|t| !safe(t))
        {
            return invalid("invalid retention job request");
        }
        self.run_maintenance(control, false, |connection, budget| {
            statement(connection, budget, "BEGIN IMMEDIATE")?;
            if let Some(job) = load(connection, &request.job_id, budget)? {
                if job.request != request
                    || applied
                        .is_some_and(|p| job.policy_applied_revision != Some(p.applied_revision))
                {
                    return Err(StoreError::Conflict);
                }
                let receipt = JobBeginReceipt {
                    job_id: request.job_id.clone(),
                    cutoff_ms: request.cutoff_ms,
                    begin_commit: job.begin as u64,
                };
                budget.result(&serde_json::to_value(&receipt)?)?;
                statement(connection, budget, "COMMIT")?;
                return Ok(receipt);
            }
            budget.work.statement()?;
            ensure_idle(connection)?;
            budget.row()?;
            check_quiescent(connection, budget)?;
            if let Some(expected) = applied {
                budget.work.statement()?;
                let snapshot: i64 = connection.query_row(
                    "SELECT last_commit FROM store_meta WHERE singleton=1",
                    [],
                    |r| r.get(0),
                )?;
                budget.row()?;
                if snapshot < 0
                    || super::application::load_current(connection, budget, snapshot as u64)?
                        .as_ref()
                        != Some(expected)
                {
                    return Err(StoreError::Conflict);
                }
            }
            let (cutoff, _) = checked_fence(connection, budget)?;
            if cutoff != request.expected_cutoff_ms
                || cutoff.is_some_and(|t| request.cutoff_ms <= t)
            {
                return Err(StoreError::Conflict);
            }
            let commit = commit(connection, budget)?;
            budget.work.statement()?;
            connection.execute(
                "INSERT INTO retention_jobs VALUES (?1,?2,?3,?4,'active',?5,0,0,0,NULL,?6)",
                params![
                    request.job_id,
                    serde_json::to_string(&StoredJobRequest {
                        job_id: request.job_id.clone(),
                        cutoff_ms: request.cutoff_ms,
                        expected_cutoff_ms: request.expected_cutoff_ms,
                        policy_applied_revision: applied.map(|p| p.applied_revision)
                    })?,
                    request.cutoff_ms,
                    request.expected_cutoff_ms,
                    commit,
                    applied.map(|p| p.applied_revision as i64)
                ],
            )?;
            let receipt = JobBeginReceipt {
                job_id: request.job_id.clone(),
                cutoff_ms: request.cutoff_ms,
                begin_commit: commit as u64,
            };
            budget.result(&serde_json::to_value(&receipt)?)?;
            statement(connection, budget, "COMMIT")?;
            Ok(receipt)
        })
    }

    pub fn step_retention_job(
        &mut self,
        request: JobStepRequest,
        control: &QueryControl,
    ) -> StoreResult<JobStepReceipt> {
        self.step_job_with_hook(request, control, &mut |_| Ok(()))
    }

    fn step_job_with_hook(
        &mut self,
        request: JobStepRequest,
        control: &QueryControl,
        hook: &mut impl FnMut(Boundary) -> StoreResult<()>,
    ) -> StoreResult<JobStepReceipt> {
        if !id(&request.job_id)
            || !(1..=MAX_SAFE).contains(&request.step)
            || !(1..=MAX_TRIM_TICKS as u32).contains(&request.max_ticks)
        {
            return invalid("invalid retention job step");
        }
        self.run_maintenance(control,false,|connection,budget| {
            statement(connection,budget,"BEGIN IMMEDIATE")?;
            let job=load(connection,&request.job_id,budget)?.ok_or(StoreError::Invalid("unknown retention job"))?;
            if let Some((saved,receipt))=saved_step(connection,&request.job_id,request.step,budget)? {
                if saved!=request {return Err(StoreError::Conflict);}
                if receipt.commit_version<=job.begin as u64 || request.step>job.last || receipt.commit_version>job.latest_commit || (request.step<job.last && receipt.commit_version>=job.latest_commit) || receipt.deleted_ticks as u64>job.ticks || receipt.deleted_observations as u64>job.observations || (receipt.completed && request.step!=job.last) || job.completion.is_some_and(|end| receipt.commit_version>end as u64) {return Err(StoreError::CorruptData);}
                budget.result(&serde_json::to_value(&receipt)?)?;statement(connection,budget,"COMMIT")?;return Ok(receipt);
            }
            if job.state!=JobState::Active {return Err(StoreError::Conflict);}
            let expected=job.last.checked_add(1).filter(|n| *n<=MAX_SAFE).ok_or(StoreError::Invalid("retention step exhausted"))?;
            if request.step!=expected {return Err(StoreError::Sequence{expected});}
            check_quiescent(connection,budget)?;
            let (cutoff,_)=checked_fence(connection,budget)?;
            if cutoff!=job.request.expected_cutoff_ms {return Err(StoreError::CorruptData);}
            let ticks=candidates(connection,job.request.cutoff_ms,request.max_ticks,budget)?;
            let (points,observations)=validate_ticks(connection,&ticks,job.request.cutoff_ms,budget)?;
            let total_ticks=add(job.ticks,ticks.len())?;
            let total_observations=add(job.observations,observations)?;
            let commit=commit(connection,budget)?;
            // Create the FK target in this transaction before expiry publication.
            budget.work.statement()?;
            connection.execute("INSERT INTO retention_job_steps VALUES (?1,?2,?3,?4,?5,?6,0)",params![request.job_id,request.step as i64,serde_json::to_string(&request)?,commit,ticks.len() as i64,observations as i64])?;
            for ((series,time),count) in &points {
                budget.work.statement()?;
                let cumulative: Option<i64> = connection.query_row("INSERT INTO retention_job_pending SELECT ?1,?2,?3,?4 WHERE NOT EXISTS(SELECT 1 FROM expired_samples WHERE series_id=?2 AND sample_time_ms=?3 UNION ALL SELECT 1 FROM job_expired_samples WHERE series_id=?2 AND sample_time_ms=?3) ON CONFLICT (job_id,series_id,sample_time_ms) DO UPDATE SET deleted_records=deleted_records+excluded.deleted_records WHERE deleted_records BETWEEN 1 AND ?5 RETURNING deleted_records",params![request.job_id,series,time,*count as i64,job.ticks as i64],|r|r.get(0)).optional()?;
                budget.row()?;
                if cumulative.is_none_or(|n| n<=0 || n as u64>total_ticks) {return Err(StoreError::CorruptData);}

            }
            hook(Boundary::Metadata)?;
            let mut deleted=0;
            for (session,sequence) in &ticks {
                budget.work.statement()?;
                deleted+=connection.execute("DELETE FROM observations WHERE session_id=?1 AND sequence=?2",params![session,sequence])?;
            }
            if deleted!=observations {return Err(StoreError::CorruptData);}
            hook(Boundary::Observation)?;
            for (series,time) in points.keys() {
                budget.work.statement()?;
                connection.execute("INSERT INTO job_expired_samples SELECT series_id,sample_time_ms,job_id,?4,deleted_records FROM retention_job_pending WHERE job_id=?1 AND series_id=?2 AND sample_time_ms=?3 AND NOT EXISTS(SELECT 1 FROM observations WHERE series_id=?2 AND sample_time_ms=?3)",params![request.job_id,series,time,request.step as i64])?;
                budget.work.statement()?;
                connection.execute("DELETE FROM retention_job_pending WHERE job_id=?1 AND series_id=?2 AND sample_time_ms=?3 AND EXISTS(SELECT 1 FROM job_expired_samples WHERE job_id=?1 AND series_id=?2 AND sample_time_ms=?3 AND published_step=?4)",params![request.job_id,series,time,request.step as i64])?;
            }
            budget.work.statement()?;
            let remaining:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM observations WHERE sample_time_ms<?1)",[job.request.cutoff_ms],|r|r.get(0))?;budget.row()?;
            let completed=!remaining;
            if completed {
                budget.work.statement()?;
                let pending:bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM retention_job_pending WHERE job_id=?1)",[&request.job_id],|r|r.get(0))?;budget.row()?;
                if pending {return Err(StoreError::CorruptData);}
            }
            budget.work.statement()?;
            connection.execute("UPDATE retention_jobs SET last_step=?2,deleted_ticks=?3,deleted_observations=?4,state=?5,completion_commit=?6 WHERE job_id=?1",params![request.job_id,request.step as i64,total_ticks as i64,total_observations as i64,if completed {"complete"}else{"active"},completed.then_some(commit)])?;
            if completed {
                budget.work.statement()?;
                connection.execute("UPDATE retention_job_steps SET completed=1 WHERE job_id=?1 AND step=?2",params![request.job_id,request.step as i64])?;
                budget.work.statement()?;
                connection.execute("UPDATE retention_state SET cutoff_ms=?1,revision_commit=?2 WHERE singleton=1",params![job.request.cutoff_ms,commit])?;
            }
            hook(Boundary::Watermark)?;
            let receipt=JobStepReceipt {job_id:request.job_id.clone(),step:request.step,commit_version:commit as u64,deleted_ticks:ticks.len(),deleted_observations:observations,completed};
            budget.result(&serde_json::to_value(&receipt)?)?;
            hook(Boundary::BeforeCommit)?;statement(connection,budget,"COMMIT")?;hook(Boundary::AfterCommit)?;Ok(receipt)
        })
    }

    pub fn retention_job_status(
        &mut self,
        job_id: &str,
        control: &QueryControl,
    ) -> StoreResult<Option<JobStatus>> {
        if !id(job_id) {
            return invalid("invalid retention job id");
        }
        self.run_maintenance(control, true, |connection, budget| {
            statement(connection, budget, "BEGIN DEFERRED")?;
            let result = load(connection, job_id, budget)?.map(Job::into_status);
            budget.result(&serde_json::to_value(&result)?)?;
            statement(connection, budget, "ROLLBACK")?;
            Ok(result)
        })
    }
}

impl Job {
    fn into_status(self) -> JobStatus {
        JobStatus {
            job_id: self.request.job_id,
            cutoff_ms: self.request.cutoff_ms,
            state: self.state,
            next_step: if self.state == JobState::Complete {
                None
            } else {
                self.last.checked_add(1).filter(|n| *n <= MAX_SAFE)
            },
            deleted_ticks: self.ticks,
            deleted_observations: self.observations,
            begin_commit: self.begin as u64,
            completion_commit: self.completion.map(|c| c as u64),
            policy_applied_revision: self.policy_applied_revision,
        }
    }
}

pub(in crate::store) fn recover_active(
    connection: &Connection,
    job_id: &str,
    cutoff: Option<i64>,
    revision: i64,
    snapshot: i64,
    budget: &mut Budget,
) -> StoreResult<crate::store::recovery::ActiveJobRecovery> {
    let job = load(connection, job_id, budget)?.ok_or(StoreError::CorruptData)?;
    check_head(connection, &job, budget)?;
    if job.state != JobState::Active
        || job.request.expected_cutoff_ms != cutoff
        || job.begin <= revision
        || job.begin > snapshot
        || job.latest_commit > snapshot as u64
    {
        return Err(StoreError::CorruptData);
    }
    let last_step = if job.last == 0 {
        None
    } else {
        let (request, receipt) =
            saved_step(connection, job_id, job.last, budget)?.ok_or(StoreError::CorruptData)?;
        if receipt.completed || receipt.commit_version != job.latest_commit {
            return Err(StoreError::CorruptData);
        }
        Some(crate::store::recovery::StepRecovery { request, receipt })
    };
    Ok(crate::store::recovery::ActiveJobRecovery {
        status: job.into_status(),
        last_step,
    })
}

pub(in crate::store) fn validate_completed_source(
    connection: &Connection,
    job_id: &str,
    cutoff: i64,
    revision: i64,
    budget: &mut Budget,
) -> StoreResult<()> {
    let job = load(connection, job_id, budget)?.ok_or(StoreError::CorruptData)?;
    check_head(connection, &job, budget)?;
    if job.state != JobState::Complete
        || job.request.cutoff_ms != cutoff
        || job.completion != Some(revision)
    {
        return Err(StoreError::CorruptData);
    }
    Ok(())
}

fn check_head(connection: &Connection, job: &Job, budget: &mut Budget) -> StoreResult<()> {
    budget.work.statement()?;
    let latest: Option<i64> = connection
        .query_row(
            "SELECT step FROM retention_job_steps WHERE job_id=?1 ORDER BY step DESC LIMIT 1",
            [&job.request.job_id],
            |r| r.get(0),
        )
        .optional()?;
    if latest.is_some() {
        budget.row()?;
    }
    match latest {
        None if job.last == 0 => Ok(()),
        Some(step) if job.last > 0 && step == job.last as i64 => Ok(()),
        _ => Err(StoreError::CorruptData),
    }
}

pub(in crate::store) fn ensure_idle(connection: &Connection) -> StoreResult<()> {
    if connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM retention_jobs WHERE state='active')",
        [],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(StoreError::Busy);
    }
    Ok(())
}
fn statement(connection: &Connection, budget: &Budget, sql: &str) -> StoreResult<()> {
    budget.work.statement()?;
    connection.execute_batch(sql)?;
    Ok(())
}
fn checked_fence(connection: &Connection, budget: &mut Budget) -> StoreResult<(Option<i64>, i64)> {
    for _ in 0..3 {
        budget.work.statement()?;
        budget.row()?;
    }
    fence(connection)
}
fn commit(connection: &Connection, budget: &mut Budget) -> StoreResult<i64> {
    budget.work.statement()?;
    budget.work.statement()?;
    budget.row()?;
    next_commit(connection)
}
fn add(old: u64, count: usize) -> StoreResult<u64> {
    old.checked_add(count as u64)
        .filter(|n| *n <= MAX_SAFE)
        .ok_or(StoreError::Invalid("retention total exhausted"))
}
fn check_quiescent(connection: &Connection, budget: &mut Budget) -> StoreResult<()> {
    budget.work.statement()?;
    let active: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE state='active')",
        [],
        |r| r.get(0),
    )?;
    budget.row()?;
    if active {
        return Err(StoreError::Busy);
    }
    Ok(())
}
fn candidates(
    connection: &Connection,
    cutoff: i64,
    max: u32,
    budget: &mut Budget,
) -> StoreResult<Vec<(String, i64)>> {
    budget.work.statement()?;
    let mut statement=connection.prepare("SELECT DISTINCT sample_time_ms,session_id,sequence FROM observations INDEXED BY observation_retention_time WHERE sample_time_ms<?1 ORDER BY sample_time_ms,session_id,sequence LIMIT ?2")?;
    let mut rows = statement.query(params![cutoff, max])?;
    let mut result = Vec::new();
    while let Some(row) = rows.next()? {
        budget.row()?;
        result.push((row.get(1)?, row.get(2)?));
    }
    Ok(result)
}

type JobRow = (
    String,
    i64,
    Option<i64>,
    String,
    i64,
    i64,
    i64,
    i64,
    Option<i64>,
    Option<i64>,
);
fn load(connection: &Connection, id: &str, budget: &mut Budget) -> StoreResult<Option<Job>> {
    budget.work.statement()?;
    let row:Option<JobRow>=connection.query_row("SELECT payload_json,cutoff_ms,expected_cutoff_ms,state,begin_commit,last_step,deleted_ticks,deleted_observations,completion_commit,policy_applied_revision FROM retention_jobs WHERE job_id=?1",[id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?))).optional()?;
    let Some((
        payload,
        cutoff,
        expected,
        state,
        begin,
        last,
        ticks,
        observations,
        end,
        policy_revision,
    )) = row
    else {
        return Ok(None);
    };
    budget.row()?;
    budget.evidence_text(&payload)?;
    let stored: StoredJobRequest =
        serde_json::from_str(&payload).map_err(|_| StoreError::CorruptData)?;
    if stored.policy_applied_revision != policy_revision.map(|n| n as u64) {
        return Err(StoreError::CorruptData);
    }
    let request = JobRequest {
        job_id: stored.job_id,
        cutoff_ms: stored.cutoff_ms,
        expected_cutoff_ms: stored.expected_cutoff_ms,
    };
    budget.work.statement()?;
    let snapshot: i64 = connection.query_row(
        "SELECT last_commit FROM store_meta WHERE singleton=1",
        [],
        |r| r.get(0),
    )?;
    budget.row()?;
    let state = match state.as_str() {
        "active" => JobState::Active,
        "complete" => JobState::Complete,
        _ => return Err(StoreError::CorruptData),
    };
    if request.job_id != id
        || request.cutoff_ms != cutoff
        || request.expected_cutoff_ms != expected
        || !safe(cutoff)
        || expected.is_some_and(|t| !safe(t) || t >= cutoff)
        || begin <= 0
        || begin > snapshot
        || !(0..=MAX_SAFE as i64).contains(&last)
        || !(0..=MAX_SAFE as i64).contains(&ticks)
        || !(ticks..=MAX_SAFE as i64).contains(&observations)
        || observations > ticks * 8
        || (last == 0 && (ticks != 0 || observations != 0))
        || (state == JobState::Active && end.is_some())
        || (state == JobState::Complete
            && (last == 0 || end.is_none_or(|e| e <= begin || e > snapshot)))
    {
        return Err(StoreError::CorruptData);
    }
    if let Some(revision) = policy_revision {
        if !(1..=MAX_SAFE as i64).contains(&revision) {
            return Err(StoreError::CorruptData);
        }
        super::application::validate_binding(connection, budget, revision as u64, begin as u64)?;
    }
    let mut latest_commit = begin as u64;
    if last > 0 {
        let (_, receipt) =
            saved_step(connection, id, last as u64, budget)?.ok_or(StoreError::CorruptData)?;
        latest_commit = receipt.commit_version;
        if receipt.commit_version <= begin as u64
            || receipt.commit_version > snapshot as u64
            || receipt.completed != (state == JobState::Complete)
            || end.is_some_and(|e| e as u64 != receipt.commit_version)
            || receipt.deleted_ticks as i64 > ticks
            || receipt.deleted_observations as i64 > observations
        {
            return Err(StoreError::CorruptData);
        }
    }
    Ok(Some(Job {
        request,
        state,
        begin,
        last: last as u64,
        ticks: ticks as u64,
        observations: observations as u64,
        completion: end,
        latest_commit,
        policy_applied_revision: policy_revision.map(|n| n as u64),
    }))
}
type StepRow = (String, i64, i64, i64, i64);
fn saved_step(
    connection: &Connection,
    job: &str,
    step: u64,
    budget: &mut Budget,
) -> StoreResult<Option<(JobStepRequest, JobStepReceipt)>> {
    budget.work.statement()?;
    let row:Option<StepRow>=connection.query_row("SELECT payload_json,commit_version,deleted_ticks,deleted_observations,completed FROM retention_job_steps WHERE job_id=?1 AND step=?2",params![job,step as i64],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?;
    let Some((payload, commit, ticks, observations, completed)) = row else {
        return Ok(None);
    };
    budget.row()?;
    budget.evidence_text(&payload)?;
    let saved: JobStepRequest =
        serde_json::from_str(&payload).map_err(|_| StoreError::CorruptData)?;
    if saved.job_id != job
        || saved.step != step
        || !(1..=MAX_TRIM_TICKS as u32).contains(&saved.max_ticks)
        || commit <= 0
        || ticks < 0
        || ticks > saved.max_ticks as i64
        || observations < ticks
        || observations > ticks * 8
        || !matches!(completed, 0 | 1)
        || (completed == 0 && ticks == 0)
    {
        return Err(StoreError::CorruptData);
    }
    Ok(Some((
        saved,
        JobStepReceipt {
            job_id: job.into(),
            step,
            commit_version: commit as u64,
            deleted_ticks: ticks as usize,
            deleted_observations: observations as usize,
            completed: completed == 1,
        },
    )))
}

#[cfg(test)]
mod tests;
