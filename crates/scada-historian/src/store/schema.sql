PRAGMA application_id = 1396918337;
PRAGMA user_version = 6;
CREATE TABLE store_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    format_version INTEGER NOT NULL CHECK (format_version = 6),
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
CREATE INDEX observation_session_time ON observations (session_id, sample_time_ms);
CREATE TABLE retention_policy_definitions (
    policy_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL CHECK (policy_revision BETWEEN 1 AND 9007199254740991),
    payload_json TEXT NOT NULL,
    created_commit INTEGER NOT NULL CHECK (created_commit > 0),
    PRIMARY KEY (policy_id, policy_revision)
) STRICT;
CREATE TABLE retention_policy_applications (
    request_id TEXT PRIMARY KEY NOT NULL,
    payload_json TEXT NOT NULL,
    applied_revision INTEGER UNIQUE NOT NULL CHECK (applied_revision BETWEEN 1 AND 9007199254740991),
    expected_applied_revision INTEGER REFERENCES retention_policy_applications (applied_revision),
    commit_version INTEGER UNIQUE NOT NULL CHECK (commit_version > 0),
    policy_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL,
    receipt_json TEXT NOT NULL,
    FOREIGN KEY (policy_id, policy_revision) REFERENCES retention_policy_definitions,
    CHECK ((applied_revision = 1) = (expected_applied_revision IS NULL)),
    CHECK ((applied_revision = 1 AND expected_applied_revision IS NULL)
        OR (applied_revision > 1 AND expected_applied_revision = applied_revision - 1))
) STRICT;
CREATE TABLE retention_policy_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    applied_revision INTEGER REFERENCES retention_policy_applications (applied_revision)
) STRICT;
INSERT INTO retention_policy_state VALUES (1, NULL);
CREATE INDEX retention_policy_origin ON retention_policy_applications (policy_id, policy_revision, commit_version);
CREATE TABLE recording_plans (
    plan_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    members_json TEXT NOT NULL,
    created_commit INTEGER NOT NULL CHECK (created_commit > 0),
    PRIMARY KEY (plan_id, revision)
) STRICT;
CREATE TABLE session_evidence (
    session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions,
    plan_id TEXT NOT NULL,
    plan_revision INTEGER NOT NULL,
    clock_epoch TEXT NOT NULL,
    start_ms INTEGER NOT NULL CHECK (start_ms BETWEEN -9007199254740991 AND 9007199254740991),
    observed_frontier_ms INTEGER NOT NULL CHECK (observed_frontier_ms BETWEEN start_ms AND 9007199254740991),
    end_ms INTEGER CHECK (end_ms > start_ms AND end_ms >= observed_frontier_ms AND end_ms <= 9007199254740991),
    FOREIGN KEY (plan_id, plan_revision) REFERENCES recording_plans,
    UNIQUE (session_id, clock_epoch)
) STRICT;
CREATE TABLE recording_gaps (
    session_id TEXT NOT NULL REFERENCES session_evidence,
    gap_id TEXT NOT NULL,
    clock_epoch TEXT NOT NULL,
    from_ms INTEGER NOT NULL,
    to_ms INTEGER NOT NULL,
    observed_at_ms INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('samplingMissed', 'storageLoss')),
    payload_json TEXT NOT NULL,
    commit_version INTEGER NOT NULL CHECK (commit_version > 0),
    PRIMARY KEY (session_id, gap_id),
    FOREIGN KEY (session_id, clock_epoch) REFERENCES session_evidence (session_id, clock_epoch),
    CHECK (from_ms BETWEEN -9007199254740991 AND 9007199254740991),
    CHECK (from_ms < to_ms AND to_ms <= observed_at_ms AND observed_at_ms <= 9007199254740991)
) STRICT;
CREATE INDEX recording_gap_time ON recording_gaps (session_id, from_ms);

CREATE INDEX observation_tick ON observations (session_id, sequence, series_id);
CREATE INDEX observation_retention_time ON observations (sample_time_ms, session_id, sequence);
CREATE TABLE retention_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    cutoff_ms INTEGER CHECK (cutoff_ms BETWEEN -9007199254740991 AND 9007199254740991),
    revision_commit INTEGER NOT NULL CHECK (revision_commit >= 0),
    CHECK ((cutoff_ms IS NULL) = (revision_commit = 0))
) STRICT;
INSERT INTO retention_state VALUES (1, NULL, 0);
CREATE TABLE retention_operations (
    request_id TEXT PRIMARY KEY NOT NULL,
    payload_json TEXT NOT NULL,
    cutoff_ms INTEGER NOT NULL CHECK (cutoff_ms BETWEEN -9007199254740991 AND 9007199254740991),
    commit_version INTEGER UNIQUE NOT NULL CHECK (commit_version > 0),
    deleted_ticks INTEGER NOT NULL CHECK (deleted_ticks BETWEEN 0 AND 1024),
    deleted_observations INTEGER NOT NULL CHECK (deleted_observations BETWEEN 0 AND 8192)
) STRICT;
CREATE TABLE expired_samples (
    series_id TEXT NOT NULL REFERENCES series,
    sample_time_ms INTEGER NOT NULL CHECK (sample_time_ms BETWEEN -9007199254740991 AND 9007199254740990),
    operation_id TEXT NOT NULL REFERENCES retention_operations (request_id),
    deleted_records INTEGER NOT NULL CHECK (deleted_records > 0),
    PRIMARY KEY (series_id, sample_time_ms)
) STRICT;

CREATE TABLE retention_jobs (
    job_id TEXT PRIMARY KEY NOT NULL,
    payload_json TEXT NOT NULL,
    cutoff_ms INTEGER NOT NULL CHECK (cutoff_ms BETWEEN -9007199254740991 AND 9007199254740991),
    expected_cutoff_ms INTEGER,
    state TEXT NOT NULL CHECK (state IN ('active', 'complete')),
    begin_commit INTEGER UNIQUE NOT NULL CHECK (begin_commit > 0),
    last_step INTEGER NOT NULL CHECK (last_step BETWEEN 0 AND 9007199254740991),
    deleted_ticks INTEGER NOT NULL CHECK (deleted_ticks BETWEEN 0 AND 9007199254740991),
    deleted_observations INTEGER NOT NULL CHECK (deleted_observations BETWEEN 0 AND 9007199254740991),
    completion_commit INTEGER UNIQUE CHECK (completion_commit > begin_commit),
    policy_applied_revision INTEGER REFERENCES retention_policy_applications (applied_revision),
    CHECK ((state = 'complete') = (completion_commit IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_active_retention_job ON retention_jobs ((1)) WHERE state = 'active';
CREATE TABLE retention_job_steps (
    job_id TEXT NOT NULL REFERENCES retention_jobs,
    step INTEGER NOT NULL CHECK (step BETWEEN 1 AND 9007199254740991),
    payload_json TEXT NOT NULL,
    commit_version INTEGER UNIQUE NOT NULL CHECK (commit_version > 0),
    deleted_ticks INTEGER NOT NULL CHECK (deleted_ticks BETWEEN 0 AND 1024),
    deleted_observations INTEGER NOT NULL CHECK (deleted_observations BETWEEN 0 AND 8192),
    completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
    PRIMARY KEY (job_id, step)
) STRICT;
CREATE TABLE retention_job_pending (
    job_id TEXT NOT NULL REFERENCES retention_jobs,
    series_id TEXT NOT NULL REFERENCES series,
    sample_time_ms INTEGER NOT NULL CHECK (sample_time_ms BETWEEN -9007199254740991 AND 9007199254740990),
    deleted_records INTEGER NOT NULL CHECK (deleted_records BETWEEN 1 AND 9007199254740991),
    PRIMARY KEY (job_id, series_id, sample_time_ms)
) STRICT;
CREATE TABLE job_expired_samples (
    series_id TEXT NOT NULL REFERENCES series,
    sample_time_ms INTEGER NOT NULL CHECK (sample_time_ms BETWEEN -9007199254740991 AND 9007199254740990),
    job_id TEXT NOT NULL,
    published_step INTEGER NOT NULL,
    deleted_records INTEGER NOT NULL CHECK (deleted_records BETWEEN 1 AND 9007199254740991),
    PRIMARY KEY (series_id, sample_time_ms),
    FOREIGN KEY (job_id, published_step) REFERENCES retention_job_steps
) STRICT;

-- H5b1 managed configuration; commit numbers share store_meta, not tick commits.
CREATE TABLE recording_mapping_revisions (
 mapping_revision INTEGER PRIMARY KEY CHECK (mapping_revision BETWEEN 1 AND 4096),
 request_id TEXT UNIQUE NOT NULL,
 expected_revision INTEGER REFERENCES recording_mapping_revisions(mapping_revision),
 request_json TEXT NOT NULL, mapping_hash TEXT NOT NULL CHECK(length(mapping_hash)=64 AND mapping_hash NOT GLOB '*[^0-9a-f]*'),
 commit_version INTEGER UNIQUE NOT NULL CHECK(commit_version>0), receipt_json TEXT NOT NULL,
 CHECK ((mapping_revision=1)=(expected_revision IS NULL)),
 CHECK ((mapping_revision=1 AND expected_revision IS NULL) OR expected_revision=mapping_revision-1)
) STRICT;
CREATE TABLE recording_mapping_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 mapping_revision INTEGER REFERENCES recording_mapping_revisions(mapping_revision),
 revision_count INTEGER NOT NULL CHECK(revision_count BETWEEN 0 AND 4096)
) STRICT;
INSERT INTO recording_mapping_state VALUES(1,NULL,0);
CREATE TABLE recording_desired_definitions (
 plan_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
 desired_json TEXT NOT NULL, desired_hash TEXT NOT NULL CHECK(length(desired_hash)=64 AND desired_hash NOT GLOB '*[^0-9a-f]*'),
 created_commit INTEGER NOT NULL CHECK(created_commit>0), PRIMARY KEY(plan_id,revision)
) STRICT;
CREATE TABLE recording_plan_applications (
 applied_revision INTEGER PRIMARY KEY CHECK(applied_revision BETWEEN 1 AND 4096),
 request_id TEXT UNIQUE NOT NULL, expected_revision INTEGER REFERENCES recording_plan_applications(applied_revision),
 request_json TEXT NOT NULL, plan_id TEXT NOT NULL, desired_revision INTEGER NOT NULL,
 mapping_revision INTEGER REFERENCES recording_mapping_revisions(mapping_revision),
 retention_revision INTEGER REFERENCES retention_policy_applications(applied_revision),
 resolved_json TEXT NOT NULL, resolved_hash TEXT NOT NULL CHECK(length(resolved_hash)=64 AND resolved_hash NOT GLOB '*[^0-9a-f]*'),
 commit_version INTEGER UNIQUE NOT NULL CHECK(commit_version>0), receipt_json TEXT NOT NULL,
 FOREIGN KEY(plan_id,desired_revision) REFERENCES recording_desired_definitions,
 CHECK((applied_revision=1)=(expected_revision IS NULL)),
 CHECK((applied_revision=1 AND expected_revision IS NULL) OR expected_revision=applied_revision-1)
) STRICT;
CREATE TABLE recording_plan_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), ledger_plan_id TEXT,
 applied_revision INTEGER REFERENCES recording_plan_applications(applied_revision),
 application_count INTEGER NOT NULL CHECK(application_count BETWEEN 0 AND 4096),
 definition_count INTEGER NOT NULL CHECK(definition_count BETWEEN 0 AND 4096),
 CHECK((applied_revision IS NULL)=(ledger_plan_id IS NULL))
) STRICT;
INSERT INTO recording_plan_state VALUES(1,NULL,NULL,0,0);
CREATE TABLE recording_series_reservations (
 series_id TEXT PRIMARY KEY, hub_id TEXT NOT NULL, incarnation_id TEXT NOT NULL,
 first_revision INTEGER NOT NULL REFERENCES recording_plan_applications(applied_revision),
 UNIQUE(hub_id,incarnation_id)
) STRICT;
CREATE TABLE recording_segment_reservations (
 series_id TEXT NOT NULL REFERENCES recording_series_reservations(series_id), segment_id TEXT NOT NULL,
 descriptor_json TEXT NOT NULL, descriptor_hash TEXT NOT NULL CHECK(length(descriptor_hash)=64 AND descriptor_hash NOT GLOB '*[^0-9a-f]*'), first_revision INTEGER NOT NULL REFERENCES recording_plan_applications(applied_revision),
 PRIMARY KEY(series_id,segment_id)
) STRICT;

CREATE INDEX recording_application_definition ON recording_plan_applications(plan_id,desired_revision,commit_version);
CREATE TABLE recording_application_members (
 applied_revision INTEGER NOT NULL REFERENCES recording_plan_applications(applied_revision),
 series_id TEXT NOT NULL, segment_id TEXT NOT NULL,
 PRIMARY KEY(applied_revision,series_id,segment_id),
 FOREIGN KEY(series_id,segment_id) REFERENCES recording_segment_reservations
) STRICT;
CREATE INDEX recording_reserved_first_use ON recording_application_members(series_id,segment_id,applied_revision);
CREATE INDEX recording_series_first_use ON recording_application_members(series_id,applied_revision);
