WITH target AS MATERIALIZED (
    SELECT session_id, sequence, series_id, sample_time_ms
    FROM observations INDEXED BY observation_retention_time
    WHERE sample_time_ms < ?2 AND (?1 IS NULL OR sample_time_ms >= ?1)
)
SELECT
    (SELECT count(*) FROM (SELECT session_id, sequence FROM target GROUP BY session_id, sequence)),
    count(*), count(DISTINCT series_id), min(sample_time_ms), max(sample_time_ms)
FROM target
