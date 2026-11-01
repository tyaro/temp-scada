-- Same-snapshot evidence validation and bounded decoding of contiguous ms islands.
WITH evidence AS (
    SELECT e.sample_time_ms AS time_ms,
        CASE WHEN length(CAST(e.operation_id AS BLOB)) BETWEEN 1 AND 64
            AND substr(e.operation_id,1,1) GLOB '[A-Za-z0-9]'
            AND e.operation_id NOT GLOB '*[^A-Za-z0-9._:-]*' AND instr(e.operation_id,char(0))=0
            AND e.deleted_records>0 AND e.deleted_records<=o.deleted_observations
            AND e.sample_time_ms<o.cutoff_ms AND o.cutoff_ms<=?4
            AND o.deleted_ticks BETWEEN 1 AND 1024
            AND o.deleted_observations BETWEEN o.deleted_ticks AND o.deleted_ticks*8
            AND o.commit_version>0 AND o.commit_version<=?5
        THEN 0 ELSE 1 END AS corrupt
    FROM expired_samples e LEFT JOIN retention_operations o ON o.request_id=e.operation_id
    WHERE e.series_id=?1 AND e.sample_time_ms>=?2 AND e.sample_time_ms<?3
    UNION ALL
    SELECT e.sample_time_ms,
        CASE WHEN length(CAST(e.job_id AS BLOB)) BETWEEN 1 AND 64
            AND substr(e.job_id,1,1) GLOB '[A-Za-z0-9]'
            AND e.job_id NOT GLOB '*[^A-Za-z0-9._:-]*' AND instr(e.job_id,char(0))=0
            AND j.cutoff_ms BETWEEN -9007199254740991 AND 9007199254740991
            AND e.sample_time_ms<j.cutoff_ms
            AND j.begin_commit>0 AND j.begin_commit<m.last_commit
            AND j.last_step BETWEEN 1 AND 9007199254740991
            AND j.deleted_ticks BETWEEN 1 AND 9007199254740991
            AND j.deleted_observations BETWEEN j.deleted_ticks AND 9007199254740991
            AND j.deleted_observations<=j.deleted_ticks*8
            AND e.deleted_records BETWEEN 1 AND j.deleted_ticks
            AND latest.step=j.last_step AND latest.commit_version>j.begin_commit
            AND latest.commit_version<=m.last_commit
            AND latest.completed=(j.state='complete')
            AND latest.deleted_ticks BETWEEN 0 AND 1024
            AND latest.deleted_observations BETWEEN latest.deleted_ticks AND latest.deleted_ticks*8
            AND latest.deleted_ticks<=j.deleted_ticks AND latest.deleted_observations<=j.deleted_observations
            AND (latest.completed=1 OR latest.deleted_ticks>0)
            AND (j.state<>'complete' OR latest.commit_version=j.completion_commit)
            AND d.step BETWEEN 1 AND j.last_step AND d.completed IN (0,1)
            AND d.commit_version<=latest.commit_version
            AND (d.step=j.last_step OR d.commit_version<latest.commit_version)
            AND d.commit_version>j.begin_commit AND d.commit_version<=m.last_commit
            AND d.deleted_ticks BETWEEN 1 AND 1024
            AND d.deleted_observations BETWEEN d.deleted_ticks AND d.deleted_ticks*8
            AND d.deleted_ticks<=j.deleted_ticks AND d.deleted_observations<=j.deleted_observations
            AND (d.step<j.last_step OR d.completed=(j.state='complete'))
            AND (d.completed=0 OR (j.state='complete' AND d.commit_version=j.completion_commit))
            AND ((j.state='active' AND j.completion_commit IS NULL
                AND j.begin_commit>?5 AND j.expected_cutoff_ms IS ?4
                AND (?4 IS NULL OR j.cutoff_ms>?4)
                AND NOT EXISTS(SELECT 1 FROM sessions WHERE state='active'))
                OR (j.state='complete' AND j.completion_commit>j.begin_commit
                    AND d.commit_version<=j.completion_commit AND j.completion_commit<=?5
                    AND j.cutoff_ms<=?4))
        THEN 0 ELSE 1 END
    FROM job_expired_samples e
    LEFT JOIN retention_jobs j ON j.job_id=e.job_id
    LEFT JOIN retention_job_steps d ON d.job_id=e.job_id AND d.step=e.published_step
    LEFT JOIN retention_job_steps latest ON latest.job_id=j.job_id AND latest.step=j.last_step
    CROSS JOIN store_meta m
    WHERE e.series_id=?1 AND e.sample_time_ms>=?2 AND e.sample_time_ms<?3 AND m.singleton=1
), points AS (
    SELECT time_ms, sum(corrupt)+(count(*)<>1) AS corrupt FROM evidence GROUP BY time_ms
), edges AS (
    SELECT time_ms,corrupt,CASE WHEN lag(time_ms) OVER (ORDER BY time_ms)=time_ms-1 THEN 0 ELSE 1 END AS edge FROM points
), grouped AS (
    SELECT time_ms,corrupt,sum(edge) OVER (ORDER BY time_ms) AS island FROM edges
)
SELECT min(time_ms) AS from_ms,max(time_ms)+1 AS to_ms,sum(corrupt) AS corrupt
FROM grouped GROUP BY island ORDER BY from_ms LIMIT 257
