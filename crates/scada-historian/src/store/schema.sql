PRAGMA application_id = 1396918337;
PRAGMA user_version = 1;
CREATE TABLE store_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    format_version INTEGER NOT NULL CHECK (format_version = 1),
    store_id TEXT NOT NULL,
    deployment_id TEXT NOT NULL,
    last_commit INTEGER NOT NULL CHECK (last_commit >= 0)
) STRICT;
CREATE TABLE series (
    series_id TEXT PRIMARY KEY NOT NULL,
    hub_id TEXT NOT NULL,
    incarnation_id TEXT NOT NULL,
    UNIQUE (hub_id, incarnation_id)
) STRICT;
CREATE TABLE segments (
    series_id TEXT NOT NULL REFERENCES series,
    segment_id TEXT NOT NULL,
    descriptor_json TEXT NOT NULL,
    PRIMARY KEY (series_id, segment_id)
) STRICT;
CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'closed', 'interrupted')),
    spec_json TEXT NOT NULL,
    last_sequence INTEGER NOT NULL CHECK (last_sequence BETWEEN 0 AND 9007199254740991),
    begin_commit INTEGER NOT NULL CHECK (begin_commit > 0),
    end_commit INTEGER CHECK (end_commit > begin_commit),
    CHECK ((state = 'active') = (end_commit IS NULL))
) STRICT;
CREATE UNIQUE INDEX one_active_session ON sessions ((1)) WHERE state = 'active';
CREATE TABLE session_members (
    session_id TEXT NOT NULL REFERENCES sessions,
    series_id TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    PRIMARY KEY (session_id, series_id),
    UNIQUE (session_id, series_id, segment_id),
    FOREIGN KEY (series_id, segment_id) REFERENCES segments
) STRICT;
CREATE TABLE source_epochs (
    epoch_id INTEGER PRIMARY KEY,
    hub_id TEXT NOT NULL,
    run_id TEXT,
    catalog_revision TEXT NOT NULL,
    sdk_generation TEXT NOT NULL,
    payload_json TEXT NOT NULL UNIQUE
) STRICT;
CREATE TABLE commits (
    commit_version INTEGER PRIMARY KEY CHECK (commit_version > 0),
    session_id TEXT NOT NULL REFERENCES sessions,
    sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
    payload_json TEXT NOT NULL,
    UNIQUE (session_id, sequence),
    UNIQUE (session_id, sequence, commit_version)
) STRICT;
CREATE TABLE observations (
    series_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    segment_id TEXT NOT NULL,
    clock_epoch TEXT NOT NULL,
    sample_time_ms INTEGER NOT NULL CHECK (sample_time_ms BETWEEN -9007199254740991 AND 9007199254740991),
    source_time_ms INTEGER CHECK (source_time_ms BETWEEN -9007199254740991 AND 9007199254740991),
    ingested_at_ms INTEGER NOT NULL CHECK (ingested_at_ms BETWEEN -9007199254740991 AND 9007199254740991),
    quality TEXT CHECK (quality IN ('good', 'bad', 'stale', 'unknown')),
    source TEXT CHECK (source IN ('real', 'computed', 'internal', 'db', 'simulation', 'derivedSimulation', 'unknown')),
    number_value REAL CHECK (number_value BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308),
    bool_value INTEGER CHECK (bool_value IN (0, 1)),
    reason TEXT CHECK (reason IN ('bad', 'stale', 'unknownQuality', 'simulationExcluded', 'unknownSource', 'sourceUnavailable', 'unresolved', 'identityPending', 'missingValue', 'nonFinite', 'typeMismatch')),
    source_epoch_id INTEGER REFERENCES source_epochs,
    commit_version INTEGER NOT NULL,
    PRIMARY KEY (series_id, session_id, sequence),
    FOREIGN KEY (session_id, series_id, segment_id) REFERENCES session_members (session_id, series_id, segment_id),
    FOREIGN KEY (session_id, sequence, commit_version) REFERENCES commits (session_id, sequence, commit_version),
    CHECK (number_value IS NULL OR bool_value IS NULL),
    CHECK (
        (number_value IS NULL AND bool_value IS NULL AND reason IS NOT NULL)
        OR ((number_value IS NOT NULL OR bool_value IS NOT NULL)
            AND quality IS 'good' AND source IS NOT NULL
            AND source IN ('real', 'computed', 'internal', 'db')
            AND source_time_ms IS NOT NULL AND reason IS NULL)
    ),
    CHECK ((quality IS NULL AND source IS NULL AND source_time_ms IS NULL) OR source_epoch_id IS NOT NULL)
) STRICT;
CREATE INDEX observation_time ON observations (series_id, sample_time_ms, session_id, sequence);
CREATE INDEX observation_commit ON observations (commit_version);
