-- A selected key is validated using ALL its member rows, including rows outside
-- the requested time range. Counts must never describe a partial/corrupt tick.
WITH selected AS MATERIALIZED (
    SELECT DISTINCT session_id, sequence
    FROM observations INDEXED BY observation_retention_time
    WHERE sample_time_ms < ?1
), member_counts AS (
    SELECT session_id, count(*) AS members FROM session_members
    WHERE session_id IN (SELECT session_id FROM selected)
    GROUP BY session_id
), ticks AS (
    SELECT o.session_id, o.sequence, count(*) AS observations,
        max(mc.members) AS members,
        min(o.sample_time_ms) AS first_time, max(o.sample_time_ms) AS last_time,
        min(o.clock_epoch) AS first_clock, max(o.clock_epoch) AS last_clock,
        min(o.commit_version) AS first_commit, max(o.commit_version) AS last_commit,
        max(CASE WHEN
            s.session_id IS NULL OR sm.series_id IS NULL OR sg.series_id IS NULL
            OR sr.series_id IS NULL OR c.commit_version IS NULL
            OR s.state NOT IN ('active', 'closed', 'interrupted')
            OR s.begin_commit <= 0 OR s.begin_commit > ?2
            OR s.last_sequence NOT BETWEEN 1 AND 9007199254740991
            OR o.sequence NOT BETWEEN 1 AND s.last_sequence
            OR o.commit_version <= s.begin_commit OR o.commit_version > ?2
            OR (s.state = 'active' AND s.end_commit IS NOT NULL)
            OR (s.state != 'active' AND (s.end_commit IS NULL
                OR s.end_commit <= s.begin_commit OR s.end_commit > ?2
                OR o.commit_version >= s.end_commit))
            OR length(o.session_id) NOT BETWEEN 1 AND 64
            OR instr(o.session_id, char(0)) != 0
            OR substr(o.session_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
            OR o.session_id GLOB '*[^A-Za-z0-9._:-]*'
            OR length(o.series_id) NOT BETWEEN 1 AND 64
            OR instr(o.series_id, char(0)) != 0
            OR substr(o.series_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
            OR o.series_id GLOB '*[^A-Za-z0-9._:-]*'
            OR length(o.segment_id) NOT BETWEEN 1 AND 64
            OR instr(o.segment_id, char(0)) != 0
            OR substr(o.segment_id, 1, 1) NOT GLOB '[A-Za-z0-9]'
            OR o.segment_id GLOB '*[^A-Za-z0-9._:-]*'
            OR length(o.clock_epoch) NOT BETWEEN 1 AND 64
            OR instr(o.clock_epoch, char(0)) != 0
            OR substr(o.clock_epoch, 1, 1) NOT GLOB '[A-Za-z0-9]'
            OR o.clock_epoch GLOB '*[^A-Za-z0-9._:-]*'
        THEN 1 ELSE 0 END) AS invalid
    FROM selected t
    JOIN observations o ON o.session_id = t.session_id AND o.sequence = t.sequence
    LEFT JOIN sessions s ON s.session_id = o.session_id
    LEFT JOIN member_counts mc ON mc.session_id = o.session_id
    LEFT JOIN session_members sm ON sm.session_id = o.session_id
        AND sm.series_id = o.series_id AND sm.segment_id = o.segment_id
    LEFT JOIN segments sg ON sg.series_id = o.series_id AND sg.segment_id = o.segment_id
    LEFT JOIN series sr ON sr.series_id = o.series_id
    LEFT JOIN commits c ON c.session_id = o.session_id AND c.sequence = o.sequence
        AND c.commit_version = o.commit_version
    GROUP BY o.session_id, o.sequence
)
SELECT EXISTS (
    SELECT 1 FROM ticks
    WHERE invalid != 0 OR members IS NULL OR members NOT BETWEEN 1 AND 8
        OR observations != members
        OR first_time != last_time OR first_clock != last_clock OR first_commit != last_commit
        OR first_time < -9007199254740991 OR last_time > 9007199254740991
)
