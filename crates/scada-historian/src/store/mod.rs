//! Synchronous atomic append core and bounded raw snapshot reader.
//! No recorder or product History API is connected.
mod types;
pub use types::*;
pub mod evidence;
pub mod query;

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{atomic::AtomicUsize, Arc};
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};

pub type StoreResult<T> = Result<T, StoreError>;
pub const STORE_FORMAT_VERSION: i64 = 2;

#[derive(Debug)]
pub enum StoreError {
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    Contract(crate::ContractError),
    Busy,
    UnsupportedStore,
    IdentityMismatch,
    Conflict,
    SessionInactive,
    NeedsReopen,
    Sequence { expected: u64 },
    Invalid(&'static str),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Do not forward file paths, SQLite messages or input payloads to a UI.
        write!(
            f,
            "Historian store: {}",
            match self {
                Self::Io(_) => "I/O failure",
                Self::Sqlite(_) => "database failure",
                Self::Json(_) => "serialization failure",
                Self::Contract(_) => "contract violation",
                Self::Busy => "writer busy",
                Self::UnsupportedStore => "unsupported store",
                Self::IdentityMismatch => "store identity mismatch",
                Self::Conflict => "immutable payload conflict",
                Self::SessionInactive => "session inactive",
                Self::Sequence { .. } => "non-contiguous sequence",
                Self::NeedsReopen => "reopen required after database failure",
                Self::Invalid(message) => message,
            }
        )
    }
}
impl std::error::Error for StoreError {}
impl From<std::io::Error> for StoreError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}
impl From<rusqlite::Error> for StoreError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Sqlite(value)
    }
}
impl From<serde_json::Error> for StoreError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}
impl From<crate::ContractError> for StoreError {
    fn from(value: crate::ContractError) -> Self {
        Self::Contract(value)
    }
}
fn invalid<T>(message: &'static str) -> StoreResult<T> {
    Err(StoreError::Invalid(message))
}

/// Owns a dedicated local directory. Connections close before the OS lock drops.
pub struct SqliteStore {
    connection: Connection,
    ownership: Arc<WriterOwnership>,
    database_path: PathBuf,
    needs_reopen: bool,
}

struct WriterOwnership {
    _writer_lock: File,
    readers: AtomicUsize,
}

impl WriterOwnership {
    fn new(file: File) -> Arc<Self> {
        Arc::new(Self {
            _writer_lock: file,
            readers: AtomicUsize::new(0),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Boundary {
    Metadata,
    Observation,
    Watermark,
    BeforeCommit,
    AfterCommit,
}

impl SqliteStore {
    /// Creates a new directory and DB. Existing directories are never initialized.
    pub fn create(directory: impl AsRef<Path>, identity: StoreIdentity) -> StoreResult<Self> {
        check_identity(&identity)?;
        fs::create_dir(directory.as_ref())?;
        let directory = fs::canonicalize(directory)?;
        let writer_lock = lock(&directory, true)?;
        let path = directory.join("store.sqlite3");
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        let mut connection = connect(&path)?;
        configure(&connection)?;
        let tx = connection.transaction()?;
        tx.execute_batch(include_str!("schema.sql"))?;
        tx.execute(
            "INSERT INTO store_meta VALUES (1, ?1, ?2, ?3, 0)",
            params![
                STORE_FORMAT_VERSION,
                identity.store_id,
                identity.deployment_id
            ],
        )?;
        tx.commit()?;
        Ok(Self {
            connection,
            ownership: WriterOwnership::new(writer_lock),
            database_path: path,
            needs_reopen: false,
        })
    }

    /// Never creates or migrates a DB. Interrupted sessions cannot accept new ticks.
    pub fn open_existing(
        directory: impl AsRef<Path>,
        expected: &StoreIdentity,
    ) -> StoreResult<Self> {
        check_identity(expected)?;
        let directory = fs::canonicalize(directory)?;
        let writer_lock = lock(&directory, false)?;
        let path = directory.join("store.sqlite3");
        regular_file(&path)?;
        let mut connection = connect(&path)?;
        let application: i64 = connection.query_row("PRAGMA application_id", [], |r| r.get(0))?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if application != 1_396_918_337 || version != STORE_FORMAT_VERSION {
            return Err(StoreError::UnsupportedStore);
        }
        let (format, store, deployment): (i64, String, String) = connection.query_row(
            "SELECT format_version, store_id, deployment_id FROM store_meta WHERE singleton = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        if format != STORE_FORMAT_VERSION {
            return Err(StoreError::UnsupportedStore);
        }
        if store != expected.store_id || deployment != expected.deployment_id {
            return Err(StoreError::IdentityMismatch);
        }
        let integrity: String = connection.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if integrity != "ok" {
            return Err(StoreError::UnsupportedStore);
        }
        let foreign_key_failure = connection.prepare("PRAGMA foreign_key_check")?.exists([])?;
        if foreign_key_failure {
            return Err(StoreError::UnsupportedStore);
        }
        configure(&connection)?;
        let tx = connection.transaction()?;
        if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE state = 'active')",
            [],
            |r| r.get::<_, bool>(0),
        )? {
            let commit = next_commit(&tx)?;
            tx.execute(
                "UPDATE sessions SET state = 'interrupted', end_commit = ?1 WHERE state = 'active'",
                [commit],
            )?;
        }
        tx.commit()?;
        Ok(Self {
            connection,
            ownership: WriterOwnership::new(writer_lock),
            database_path: path,
            needs_reopen: false,
        })
    }

    pub fn session_status(&self, session_id: &str) -> StoreResult<Option<SessionStatus>> {
        status(&self.connection, session_id)
    }

    /// A repeated spec returns its original session, including its terminal state.
    pub fn begin_session(&mut self, spec: SessionSpec) -> StoreResult<SessionStatus> {
        self.check_writable()?;
        let result = self.begin_with_hook(spec, &mut |_| Ok(()));
        self.after_write(result)
    }

    fn begin_with_hook(
        &mut self,
        spec: SessionSpec,
        hook: &mut impl FnMut(Boundary) -> StoreResult<()>,
    ) -> StoreResult<SessionStatus> {
        self.begin_evidence_with_hook(spec, None, hook)
    }

    fn begin_evidence_with_hook(
        &mut self,
        spec: SessionSpec,
        start: Option<evidence::TimedStart>,
        hook: &mut impl FnMut(Boundary) -> StoreResult<()>,
    ) -> StoreResult<SessionStatus> {
        let spec = spec.validated()?;
        if let Some(start) = &start {
            start.validate()?;
        }
        let encoded = serde_json::to_string(&spec)?;
        let tx = self.connection.transaction()?;
        if let Some(existing) = status(&tx, &spec.session_id)? {
            let saved_start = evidence::load(&tx, &spec.session_id)?.map(|e| e.start);
            return if existing.spec == spec && saved_start == start {
                Ok(existing)
            } else {
                Err(StoreError::Conflict)
            };
        }
        if tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE state = 'active')",
            [],
            |r| r.get::<_, bool>(0),
        )? {
            return Err(StoreError::Busy);
        }
        let commit = next_commit(&tx)?;
        for member in &spec.members {
            let identity: Option<(String, String)> = tx
                .query_row(
                    "SELECT hub_id, incarnation_id FROM series WHERE series_id = ?1",
                    [&member.series_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            match identity {
                Some((hub, incarnation))
                    if hub != member.hub_instance_id || incarnation != member.incarnation_id =>
                {
                    return Err(StoreError::Conflict)
                }
                Some(_) => {}
                None => {
                    if tx.query_row("SELECT EXISTS(SELECT 1 FROM series WHERE hub_id = ?1 AND incarnation_id = ?2)",
                        params![member.hub_instance_id, member.incarnation_id], |r| r.get::<_, bool>(0))? {
                        return Err(StoreError::Conflict);
                    }
                    tx.execute(
                        "INSERT INTO series VALUES (?1, ?2, ?3)",
                        params![
                            member.series_id,
                            member.hub_instance_id,
                            member.incarnation_id
                        ],
                    )?;
                }
            }
            let descriptor = serde_json::to_string(member)?;
            let old: Option<String> = tx
                .query_row(
                    "SELECT descriptor_json FROM segments WHERE series_id = ?1 AND segment_id = ?2",
                    params![member.series_id, member.segment_id],
                    |r| r.get(0),
                )
                .optional()?;
            match old {
                Some(old) if old != descriptor => return Err(StoreError::Conflict),
                Some(_) => {}
                None => {
                    tx.execute(
                        "INSERT INTO segments VALUES (?1, ?2, ?3)",
                        params![member.series_id, member.segment_id, descriptor],
                    )?;
                }
            }
        }
        tx.execute(
            "INSERT INTO sessions VALUES (?1, 'active', ?2, 0, ?3, NULL)",
            params![spec.session_id, encoded, commit],
        )?;
        for member in &spec.members {
            tx.execute(
                "INSERT INTO session_members VALUES (?1, ?2, ?3)",
                params![spec.session_id, member.series_id, member.segment_id],
            )?;
        }
        if let Some(start) = &start {
            evidence::save_start(&tx, &spec, start, commit)?;
        }
        hook(Boundary::Metadata)?;
        hook(Boundary::BeforeCommit)?;
        tx.commit()?;
        hook(Boundary::AfterCommit)?;
        Ok(SessionStatus {
            spec,
            state: SessionState::Active,
            committed_through: 0,
            begin_commit_version: commit as u64,
            end_commit_version: None,
        })
    }

    pub fn close_session(&mut self, session_id: &str) -> StoreResult<SessionStatus> {
        self.check_writable()?;
        let result = self.close_inner(session_id);
        self.after_write(result)
    }

    fn close_inner(&mut self, session_id: &str) -> StoreResult<SessionStatus> {
        self.close_evidence_with_hook(session_id, None, &mut |_| Ok(()))
    }

    fn close_evidence_with_hook(
        &mut self,
        session_id: &str,
        stamp: Option<evidence::ClockStamp>,
        hook: &mut impl FnMut(Boundary) -> StoreResult<()>,
    ) -> StoreResult<SessionStatus> {
        let tx = self.connection.transaction()?;
        let Some(mut existing) = status(&tx, session_id)? else {
            return invalid("unknown session");
        };
        evidence::check_close(&tx, &existing, stamp.as_ref())?;
        if existing.state != SessionState::Active {
            return Ok(existing);
        }
        let commit = next_commit(&tx)?;
        tx.execute(
            "UPDATE sessions SET state = 'closed', end_commit = ?1 WHERE session_id = ?2",
            params![commit, session_id],
        )?;
        if let Some(stamp) = &stamp {
            tx.execute("UPDATE session_evidence SET end_ms = ?1, observed_frontier_ms = ?1 WHERE session_id = ?2", params![stamp.at_ms, session_id])?;
        }
        hook(Boundary::Metadata)?;
        hook(Boundary::BeforeCommit)?;
        tx.commit()?;
        hook(Boundary::AfterCommit)?;
        existing.state = SessionState::Closed;
        existing.end_commit_version = Some(commit as u64);
        Ok(existing)
    }

    pub fn append_tick(&mut self, tick: Tick) -> StoreResult<CommitReceipt> {
        self.check_writable()?;
        let result = self.append_with_hook(tick, &mut |_| Ok(()));
        self.after_write(result)
    }

    fn check_writable(&self) -> StoreResult<()> {
        if self.needs_reopen {
            Err(StoreError::NeedsReopen)
        } else {
            Ok(())
        }
    }

    fn after_write<T>(&mut self, result: StoreResult<T>) -> StoreResult<T> {
        if matches!(result, Err(StoreError::Sqlite(_) | StoreError::Io(_))) {
            self.needs_reopen = true;
        }
        result
    }

    fn append_with_hook(
        &mut self,
        tick: Tick,
        hook: &mut impl FnMut(Boundary) -> StoreResult<()>,
    ) -> StoreResult<CommitReceipt> {
        let tx = self.connection.transaction()?;
        let Some(session) = status(&tx, &tick.session_id)? else {
            return invalid("unknown session");
        };
        let (tick, payload) = tick.validated(&session.spec)?;
        let sequence = tick.sequence as i64; // H1 validation bounded this safe integer.
        let previous: Option<(i64, String)> = tx.query_row("SELECT commit_version, payload_json FROM commits WHERE session_id = ?1 AND sequence = ?2",
            params![tick.session_id, sequence], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        if let Some((commit, old_payload)) = previous {
            return if old_payload == payload {
                Ok(receipt(&tick, commit))
            } else {
                Err(StoreError::Conflict)
            };
        }
        if session.state != SessionState::Active {
            return Err(StoreError::SessionInactive);
        }
        if session.committed_through == MAX_SAFE {
            return invalid("session sequence exhausted");
        }
        let expected = session.committed_through + 1;
        if tick.sequence != expected {
            return Err(StoreError::Sequence { expected });
        }
        evidence::advance_tick(&tx, &tick)?;
        let commit = next_commit(&tx)?;
        tx.execute(
            "INSERT INTO commits VALUES (?1, ?2, ?3, ?4)",
            params![commit, tick.session_id, sequence, payload],
        )?;
        for (observation, member) in tick.observations.iter().zip(&session.spec.members) {
            let epoch = if let Some(epoch) = &observation.source_epoch {
                let encoded = serde_json::to_string(&epoch.canonical())?;
                tx.execute("INSERT INTO source_epochs (hub_id, run_id, catalog_revision, sdk_generation, payload_json) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (payload_json) DO NOTHING",
                    params![epoch.hub_instance_id, epoch.run_id.map(|n| n.to_string()), epoch.catalog_revision.to_string(), epoch.sdk_generation.to_string(), encoded])?;
                Some(tx.query_row(
                    "SELECT epoch_id FROM source_epochs WHERE payload_json = ?1",
                    [&encoded],
                    |r| r.get::<_, i64>(0),
                )?)
            } else {
                None
            };
            hook(Boundary::Metadata)?;
            let (number, boolean) = match observation.value {
                Some(ObservationValue::Number(n)) => (Some(n), None),
                Some(ObservationValue::Bool(b)) => (None, Some(i64::from(b))),
                None => (None, None),
            };
            tx.execute("INSERT INTO observations VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![member.series_id, tick.session_id, sequence, member.segment_id, tick.clock_epoch,
                    tick.sample_time_ms, observation.source_time_ms, tick.ingested_at_ms,
                    enum_text(observation.quality)?, enum_text(observation.source)?, number, boolean,
                    enum_text(observation.reason)?, epoch, commit])?;
            hook(Boundary::Observation)?;
        }
        tx.execute(
            "UPDATE sessions SET last_sequence = ?1 WHERE session_id = ?2",
            params![sequence, tick.session_id],
        )?;
        hook(Boundary::Watermark)?;
        hook(Boundary::BeforeCommit)?;
        tx.commit()?;
        hook(Boundary::AfterCommit)?;
        Ok(receipt(&tick, commit))
    }
}

fn receipt(tick: &Tick, commit: i64) -> CommitReceipt {
    CommitReceipt {
        session_id: tick.session_id.clone(),
        committed_through: tick.sequence,
        commit_version: commit as u64,
    }
}
fn enum_text<T: serde::Serialize>(value: Option<T>) -> StoreResult<Option<String>> {
    value
        .map(|v| {
            Ok(serde_json::to_value(v)?
                .as_str()
                .expect("serialized enum")
                .to_owned())
        })
        .transpose()
}
fn check_identity(identity: &StoreIdentity) -> StoreResult<()> {
    if !id(&identity.store_id) || !id(&identity.deployment_id) {
        return invalid("invalid store identity");
    }
    Ok(())
}
fn regular_file(path: &Path) -> StoreResult<()> {
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return invalid("store file must be a regular file");
    }
    Ok(())
}
fn lock(directory: &Path, create: bool) -> StoreResult<File> {
    let path = directory.join("writer.lock");
    if !create {
        regular_file(&path)?;
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(create)
        .open(&path)?;
    file.try_lock().map_err(|e| match e {
        std::fs::TryLockError::WouldBlock => StoreError::Busy,
        std::fs::TryLockError::Error(error) => StoreError::Io(error),
    })?;
    Ok(file)
}
fn connect(path: &PathBuf) -> StoreResult<Connection> {
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?)
}
fn configure(connection: &Connection) -> StoreResult<()> {
    connection.busy_timeout(Duration::ZERO)?;
    connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA wal_autocheckpoint = 1000;")?;
    Ok(())
}
fn next_commit(tx: &Transaction<'_>) -> StoreResult<i64> {
    let current: i64 = tx.query_row(
        "SELECT last_commit FROM store_meta WHERE singleton = 1",
        [],
        |r| r.get(0),
    )?;
    let Some(next) = current.checked_add(1) else {
        return invalid("store commit version exhausted");
    };
    tx.execute(
        "UPDATE store_meta SET last_commit = ?1 WHERE singleton = 1",
        [next],
    )?;
    Ok(next)
}
fn status(connection: &Connection, session_id: &str) -> StoreResult<Option<SessionStatus>> {
    type StatusRow = (String, String, i64, i64, Option<i64>);
    let row: Option<StatusRow> = connection.query_row(
        "SELECT spec_json, state, last_sequence, begin_commit, end_commit FROM sessions WHERE session_id = ?1", [session_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).optional()?;
    row.map(
        |(spec, state, committed_through, begin_commit_version, end_commit_version)| {
            Ok(SessionStatus {
                spec: serde_json::from_str(&spec)?,
                state: match state.as_str() {
                    "active" => SessionState::Active,
                    "closed" => SessionState::Closed,
                    "interrupted" => SessionState::Interrupted,
                    _ => return Err(StoreError::UnsupportedStore),
                },
                committed_through: committed_through as u64,
                begin_commit_version: begin_commit_version as u64,
                end_commit_version: end_commit_version.map(|v| v as u64),
            })
        },
    )
    .transpose()
}

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
