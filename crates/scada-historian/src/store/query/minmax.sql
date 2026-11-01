WITH declared(segment_id, value_type, expected_source, hub_id) AS (VALUES {descriptors})
SELECT (((o.sample_time_ms - ?2 + 1) * ?4 - 1) / (?3 - ?2)) AS bucket,
    COUNT(*) AS total,
    SUM(o.number_value IS NOT NULL OR o.bool_value IS NOT NULL) AS valued,
    MIN(COALESCE(o.number_value, CAST(o.bool_value AS REAL))),
    MAX(COALESCE(o.number_value, CAST(o.bool_value AS REAL))),
    MIN(o.segment_id), MAX(o.segment_id),
    MIN(o.session_id), MAX(o.session_id),
    MIN(o.clock_epoch), MAX(o.clock_epoch),
    MIN(o.source_epoch_id), MAX(o.source_epoch_id),
    SUM(CASE WHEN
        d.segment_id IS NOT NULL
        AND m.session_id IS NOT NULL AND s.session_id IS NOT NULL AND c.commit_version IS NOT NULL
        AND o.sequence BETWEEN 1 AND 9007199254740991 AND o.sequence <= s.last_sequence
        AND o.commit_version <= (SELECT last_commit FROM store_meta WHERE singleton = 1)
        AND length(o.session_id) BETWEEN 1 AND 64
        AND instr(o.session_id, char(0)) = 0
        AND substr(o.session_id, 1, 1) GLOB '[A-Za-z0-9]'
        AND o.session_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        AND length(o.clock_epoch) BETWEEN 1 AND 64
        AND instr(o.clock_epoch, char(0)) = 0
        AND substr(o.clock_epoch, 1, 1) GLOB '[A-Za-z0-9]'
        AND o.clock_epoch NOT GLOB '*[^A-Za-z0-9._:-]*'
        AND o.ingested_at_ms BETWEEN -9007199254740991 AND 9007199254740991
        AND (o.source_time_ms IS NULL OR o.source_time_ms BETWEEN -9007199254740991 AND 9007199254740991)
        AND (o.quality IS NULL OR o.quality IN ('good', 'bad', 'stale', 'unknown'))
        AND (o.source IS NULL OR o.source = d.expected_source)
        AND (o.source_epoch_id IS NULL OR (e.epoch_id IS NOT NULL AND e.hub_id = d.hub_id))
        AND ((o.quality IS NULL AND o.source IS NULL AND o.source_time_ms IS NULL) OR o.source_epoch_id IS NOT NULL)
        AND (
            (
                o.quality = 'good' AND o.source IN ('real', 'computed', 'internal', 'db')
                AND o.source_time_ms IS NOT NULL AND o.reason IS NULL
                AND (
                    (d.value_type = 'number' AND o.bool_value IS NULL
                        AND o.number_value BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308)
                    OR (d.value_type = 'bool' AND o.number_value IS NULL AND o.bool_value IN (0, 1))
                )
            )
            OR (
                o.number_value IS NULL AND o.bool_value IS NULL
                AND (
                    (o.reason = 'bad' AND o.quality = 'bad')
                    OR (o.reason = 'stale' AND o.quality = 'stale')
                    OR (o.reason = 'unknownQuality' AND o.quality = 'unknown')
                    OR (o.reason = 'simulationExcluded' AND o.source IN ('simulation', 'derivedSimulation'))
                    OR (o.reason = 'unknownSource' AND o.source = 'unknown')
                    OR (o.reason IN ('sourceUnavailable', 'unresolved', 'identityPending')
                        AND o.quality IS NULL AND o.source IS NULL AND o.source_time_ms IS NULL)
                    OR (o.reason IN ('missingValue', 'nonFinite', 'typeMismatch')
                        AND o.quality = 'good' AND o.source IN ('real', 'computed', 'internal', 'db'))
                )
            )
        )
        THEN 0 ELSE 1 END) AS corrupt_count
FROM observations AS o
LEFT JOIN declared AS d ON d.segment_id = o.segment_id
LEFT JOIN source_epochs AS e ON e.epoch_id = o.source_epoch_id
LEFT JOIN sessions AS s ON s.session_id = o.session_id
LEFT JOIN session_members AS m ON m.session_id = o.session_id AND m.series_id = o.series_id AND m.segment_id = o.segment_id
LEFT JOIN commits AS c ON c.session_id = o.session_id AND c.sequence = o.sequence AND c.commit_version = o.commit_version
WHERE o.series_id = ?1 AND o.sample_time_ms >= ?2 AND o.sample_time_ms < ?3
GROUP BY bucket
ORDER BY bucket
