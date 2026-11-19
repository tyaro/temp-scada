//! The terminal's operation record `operations.db` (operation stage-3 design
//! §9): one row per write request, kept across Projects. A row is written as
//! `pending` before anything is sent (log-before-write, §11-2) and finished
//! with the outcome of §5. The file sits directly in the terminal data dir,
//! not in `alarms/`, whose `.db` files are all read as alarm DBs.
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use banto_tagclient::ErrorKind;
use serde::Serialize;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

use crate::durable;

mod terminal_settings;
#[cfg(test)]
mod tests;
mod write_state;

pub use terminal_settings::{
    valid_min_interval, DEFAULT_MIN_INTERVAL_MS, MIN_INTERVAL_RANGE_MS, MIN_INTERVAL_STEP_MS,
};
pub use write_state::{KeyRef, WriteState, WriteStatus};

/// Format 2 added `terminal_write` (O2c-2), format 3 its write key
/// (`key_endpoint`, `key_id`; O2c-3a), format 4 `terminal_settings` (the
/// minimum interval; O2c-4b); an older file is brought up to date when
/// opened.
const FORMAT: i64 = 4;
const PENDING: &str = "pending";

/// Identical refusals of a slot are one row for this long after the row's
/// first request (§7, after upstream #711's folding).
pub const FOLD_WINDOW_MS: i64 = 60_000;

/// The reason of a row left `pending` by an earlier process (§9).
pub const INTERRUPTED: &str = "interrupted";

#[derive(Debug)]
pub enum OperationDbError {
    Io(std::io::Error),
    Sql(sqlx::Error),
    Json(serde_json::Error),
    UnsupportedFormat,
    /// A finish for a row that is not `pending` (or not there).
    InvalidRow,
    /// A terminal setting out of its range (`set_min_interval`).
    InvalidSetting,
}

impl From<std::io::Error> for OperationDbError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<sqlx::Error> for OperationDbError {
    fn from(error: sqlx::Error) -> Self {
        Self::Sql(error)
    }
}
impl From<serde_json::Error> for OperationDbError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

/// The finished outcome of a request (§5). `pending` is not one: it is the
/// state of a row before its outcome is known.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Ok,
    Refused,
    NotSent,
    Stopped,
    Failed,
    Uncertain,
}

impl Outcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Refused => "refused",
            Self::NotSent => "not_sent",
            Self::Stopped => "stopped",
            Self::Failed => "failed",
            Self::Uncertain => "uncertain",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "ok" => Self::Ok,
            "refused" => Self::Refused,
            "not_sent" => Self::NotSent,
            "stopped" => Self::Stopped,
            "failed" => Self::Failed,
            "uncertain" => Self::Uncertain,
            _ => return None,
        })
    }
}

/// The outcome of a `write_tag` error (§5). `WriteRejected` mixes a refusal
/// before sending with a 502 `write_failed`, so it is `failed` ("not
/// effected"), never "not sent". A kind this table does not know, including
/// one a later tagclient adds, is `uncertain` (fail-closed: the operator
/// checks the current value).
pub fn classify_write_error(kind: ErrorKind) -> Outcome {
    match kind {
        ErrorKind::Unauthorized
        | ErrorKind::WriteForbidden
        | ErrorKind::WriteUnavailable
        | ErrorKind::Transport
        | ErrorKind::InvalidEndpoint
        | ErrorKind::InvalidWriteOptions
        | ErrorKind::InvalidTagSelection => Outcome::NotSent,
        ErrorKind::KeyTripped => Outcome::Stopped,
        ErrorKind::WriteRejected => Outcome::Failed,
        _ => Outcome::Uncertain,
    }
}

/// What a request was about, written when the row is created. The host
/// fills it from the checked request and the applied Project (§4); `tag` is
/// `None` when the request stopped before the external name was resolved.
#[derive(Clone, Debug, PartialEq)]
pub struct RequestRecord {
    pub requested_at_ms: i64,
    /// The user name, or 「未ログイン」 in the development / setup phases.
    pub user: String,
    pub phase: String,
    pub hub_endpoint: Option<String>,
    pub project_id: String,
    pub project_digest: String,
    pub screen_id: String,
    pub object_id: String,
    pub equipment_id: String,
    pub equipment_code: Option<String>,
    pub slot: String,
    pub tag: Option<String>,
    /// The value to write; for an input, with the typed text (§9).
    pub value: Value,
}

/// The end of a request.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finish {
    pub outcome: Outcome,
    /// A §4 refusal code, or `ErrorKind::as_str()` for a Hub error.
    pub reason: Option<String>,
    pub audit_id: Option<i64>,
    pub finished_at_ms: i64,
}

impl Finish {
    /// The finish of a `write_tag` result.
    pub fn of_write(
        result: &Result<banto_tagclient::WriteReceipt, banto_tagclient::Error>,
        finished_at_ms: i64,
    ) -> Self {
        match result {
            Ok(receipt) => Self {
                outcome: Outcome::Ok,
                reason: None,
                audit_id: receipt.audit_id(),
                finished_at_ms,
            },
            Err(error) => Self {
                outcome: classify_write_error(error.kind()),
                reason: Some(error.kind().as_str().into()),
                audit_id: None,
                finished_at_ms,
            },
        }
    }
}

/// A row as stored. `finish` is `None` while the row is `pending`.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredRow {
    pub id: String,
    pub request: RequestRecord,
    pub repeat_count: i64,
    pub finish: Option<Finish>,
}

pub struct OperationDb {
    pool: SqlitePool,
    /// The write state as the file had it when opened (§7).
    write_status: WriteStatus,
    /// The registered write key when opened (§7).
    key: Option<KeyRef>,
    /// The saved minimum interval when opened (§7, §11-10).
    min_interval_ms: i64,
}

/// Finish a `pending` row; `InvalidRow` when it is not `pending`.
async fn finish_row<'e, E>(executor: E, id: &str, finish: &Finish) -> Result<(), OperationDbError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let updated = sqlx::query(
        "UPDATE operation SET outcome = ?, reason = ?, audit_id = ?, finished_at_ms = ? WHERE id = ? AND outcome = 'pending'",
    )
    .bind(finish.outcome.as_str())
    .bind(finish.reason.as_deref())
    .bind(finish.audit_id)
    .bind(finish.finished_at_ms)
    .bind(id)
    .execute(executor)
    .await?
    .rows_affected();
    if updated == 1 {
        Ok(())
    } else {
        Err(OperationDbError::InvalidRow)
    }
}

/// Bring a format 0 (just created), 1, 2 or 3 file to [`FORMAT`]: the
/// write state's table (O2c-2) or its write key (O2c-3a), then the
/// terminal settings (O2c-4b).
async fn upgrade(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    version: i64,
) -> Result<(), OperationDbError> {
    if version <= 1 {
        sqlx::raw_sql(write_state::CREATE_TABLE)
            .execute(&mut **tx)
            .await?;
    } else if version == 2 {
        sqlx::raw_sql(write_state::ADD_KEY)
            .execute(&mut **tx)
            .await?;
    }
    if version <= 3 {
        sqlx::raw_sql(terminal_settings::CREATE_TABLE)
            .execute(&mut **tx)
            .await?;
    }
    sqlx::raw_sql("PRAGMA user_version = 4;")
        .execute(&mut **tx)
        .await?;
    Ok(())
}

impl OperationDb {
    /// Open (or create) the record. A row an earlier process left `pending`
    /// is finished as `uncertain` / `interrupted` at `now_ms` (§9): this
    /// process cannot know whether it was sent. Returns the DB and the count
    /// of rows it finished so.
    pub async fn open(file: &Path, now_ms: i64) -> Result<(Self, u64), OperationDbError> {
        if let Some(parent) = file.parent() {
            durable::create_dir_durably(parent)?;
        }
        // No journal mode yet: WAL is persistent in the file, so it is set
        // only after the file is accepted, never on a foreign one we refuse.
        let options = SqliteConnectOptions::new()
            .filename(file)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&pool)
            .await?;
        if !(0..=FORMAT).contains(&version) {
            pool.close().await;
            return Err(OperationDbError::UnsupportedFormat);
        }
        if version == 0 {
            let existing: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .fetch_one(&pool)
            .await?;
            if existing != 0 {
                pool.close().await;
                return Err(OperationDbError::UnsupportedFormat);
            }
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
            sqlx::raw_sql(
                "CREATE TABLE operation (
                   seq INTEGER PRIMARY KEY AUTOINCREMENT,
                   id TEXT NOT NULL UNIQUE CHECK (id <> ''),
                   requested_at_ms INTEGER NOT NULL,
                   finished_at_ms INTEGER,
                   user TEXT NOT NULL,
                   phase TEXT NOT NULL,
                   hub_endpoint TEXT,
                   project_id TEXT NOT NULL,
                   project_digest TEXT NOT NULL,
                   screen_id TEXT NOT NULL,
                   object_id TEXT NOT NULL,
                   equipment_id TEXT NOT NULL,
                   equipment_code TEXT,
                   slot TEXT NOT NULL,
                   tag TEXT,
                   value TEXT NOT NULL,
                   outcome TEXT NOT NULL CHECK (outcome IN ('pending','ok','refused','not_sent','stopped','failed','uncertain')),
                   reason TEXT,
                   repeat_count INTEGER NOT NULL DEFAULT 1 CHECK (repeat_count >= 1),
                   audit_id INTEGER,
                   CHECK ((outcome = 'pending') = (finished_at_ms IS NULL))
                 );
                 CREATE INDEX operation_slot_seq ON operation(project_id, equipment_id, slot, seq DESC);",
            )
            .execute(&mut *tx)
            .await?;
            upgrade(&mut tx, 0).await?;
            tx.commit().await?;
        } else if version < FORMAT {
            let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
            upgrade(&mut tx, version).await?;
            tx.commit().await?;
        }
        sqlx::query("PRAGMA journal_mode = WAL")
            .execute(&pool)
            .await?;
        let recovered = sqlx::query(
            "UPDATE operation SET outcome = 'uncertain', reason = ?, finished_at_ms = ? WHERE outcome = 'pending'",
        )
        .bind(INTERRUPTED)
        .bind(now_ms)
        .execute(&pool)
        .await?
        .rows_affected();
        let (write_status, key) = write_state::load(&pool).await?;
        let min_interval_ms = terminal_settings::load_min_interval(&pool).await?;
        Ok((
            Self {
                pool,
                write_status,
                key,
                min_interval_ms,
            },
            recovered,
        ))
    }

    /// Run raw SQL against the record (tests make writes fail with it).
    #[cfg(test)]
    pub(crate) async fn execute_for_test(&self, sql: &'static str) {
        sqlx::query(sql).execute(&self.pool).await.unwrap();
    }

    /// Hold the pool's only connection (tests stop a write at its next
    /// statement with it).
    #[cfg(test)]
    pub(crate) async fn hold_for_test(&self) -> sqlx::pool::PoolConnection<sqlx::Sqlite> {
        self.pool.acquire().await.unwrap()
    }

    /// Release the SQLite handles (shutdown, or a test removing its dir).
    pub async fn close(self) {
        self.pool.close().await;
    }

    /// Write a `pending` row before sending.
    pub async fn insert_pending(
        &self,
        id: &str,
        request: &RequestRecord,
    ) -> Result<(), OperationDbError> {
        self.insert(id, request, None).await
    }

    /// Fold a refusal into the slot's newest row when that row is a
    /// `refused` with the very same content (§7: every field of the request,
    /// the value with its typed text, and the reason) requested less than
    /// [`FOLD_WINDOW_MS`] before it: `repeat_count` goes up by one and
    /// `finished_at_ms` becomes this refusal's. A refusal that ends before
    /// the row's end (a clock that went back) is a new row, so the row's
    /// end never moves back. Only the slot's newest row
    /// is a candidate, so the slot's last row stays the last request.
    /// Returns the folded row's id, or `None` when a new row is needed. One
    /// statement, so two refusals never fold into a row that changed.
    pub async fn fold_refusal(
        &self,
        request: &RequestRecord,
        finish: &Finish,
    ) -> Result<Option<String>, OperationDbError> {
        let id = sqlx::query_scalar(
            "UPDATE operation SET repeat_count = repeat_count + 1, finished_at_ms = ?
             WHERE seq = (SELECT max(seq) FROM operation
                          WHERE project_id = ? AND equipment_id = ? AND slot = ?)
               AND outcome = 'refused' AND reason IS ?
               AND user = ? AND phase = ? AND hub_endpoint IS ? AND project_digest = ?
               AND screen_id = ? AND object_id = ? AND equipment_code IS ?
               AND tag IS ? AND value = ?
               AND requested_at_ms <= ? AND ? - requested_at_ms < ?
               AND finished_at_ms <= ?
             RETURNING id",
        )
        .bind(finish.finished_at_ms)
        .bind(&request.project_id)
        .bind(&request.equipment_id)
        .bind(&request.slot)
        .bind(finish.reason.as_deref())
        .bind(&request.user)
        .bind(&request.phase)
        .bind(&request.hub_endpoint)
        .bind(&request.project_digest)
        .bind(&request.screen_id)
        .bind(&request.object_id)
        .bind(&request.equipment_code)
        .bind(&request.tag)
        .bind(serde_json::to_string(&request.value)?)
        .bind(request.requested_at_ms)
        .bind(request.requested_at_ms)
        .bind(FOLD_WINDOW_MS)
        .bind(finish.finished_at_ms)
        .fetch_optional(&self.pool)
        .await?;
        Ok(id)
    }

    /// Write a row finished at once (a §4 refusal: nothing is sent).
    pub async fn insert_finished(
        &self,
        id: &str,
        request: &RequestRecord,
        finish: &Finish,
    ) -> Result<(), OperationDbError> {
        self.insert(id, request, Some(finish)).await
    }

    async fn insert(
        &self,
        id: &str,
        request: &RequestRecord,
        finish: Option<&Finish>,
    ) -> Result<(), OperationDbError> {
        sqlx::query(
            "INSERT INTO operation (id, requested_at_ms, finished_at_ms, user, phase, hub_endpoint, project_id, project_digest, screen_id, object_id, equipment_id, equipment_code, slot, tag, value, outcome, reason, audit_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(request.requested_at_ms)
        .bind(finish.map(|finish| finish.finished_at_ms))
        .bind(&request.user)
        .bind(&request.phase)
        .bind(&request.hub_endpoint)
        .bind(&request.project_id)
        .bind(&request.project_digest)
        .bind(&request.screen_id)
        .bind(&request.object_id)
        .bind(&request.equipment_id)
        .bind(&request.equipment_code)
        .bind(&request.slot)
        .bind(&request.tag)
        .bind(serde_json::to_string(&request.value)?)
        .bind(finish.map_or(PENDING, |finish| finish.outcome.as_str()))
        .bind(finish.and_then(|finish| finish.reason.as_deref()))
        .bind(finish.and_then(|finish| finish.audit_id))
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Finish a `pending` row. Fails with `InvalidRow` when the row is not
    /// `pending`: an outcome is written once.
    pub async fn finish(&self, id: &str, finish: &Finish) -> Result<(), OperationDbError> {
        finish_row(&self.pool, id, finish).await
    }

    /// Finish a `pending` row and save the write state its outcome moved the
    /// terminal to, in one transaction (§7): a process that ends between
    /// them never leaves a tripped key in the record with `ready` in the
    /// file. Neither is written when either fails.
    pub async fn finish_with_state(
        &self,
        id: &str,
        finish: &Finish,
        status: WriteStatus,
    ) -> Result<(), OperationDbError> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        finish_row(&mut *tx, id, finish).await?;
        write_state::save(
            &mut *tx,
            status.state,
            status.changed_at_ms.unwrap_or_default(),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// The newest row of one slot of one equipment of a Project (§8: the
    /// operation row shows the last one).
    pub async fn latest(
        &self,
        project_id: &str,
        equipment_id: &str,
        slot: &str,
    ) -> Result<Option<StoredRow>, OperationDbError> {
        let row = sqlx::query(
            "SELECT * FROM operation WHERE project_id = ? AND equipment_id = ? AND slot = ? ORDER BY seq DESC LIMIT 1",
        )
        .bind(project_id)
        .bind(equipment_id)
        .bind(slot)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| stored_row(&row)).transpose()
    }

    async fn row(&self, id: &str) -> Result<Option<StoredRow>, OperationDbError> {
        let row = sqlx::query("SELECT * FROM operation WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        row.map(|row| stored_row(&row)).transpose()
    }
}

fn stored_row(row: &sqlx::sqlite::SqliteRow) -> Result<StoredRow, OperationDbError> {
    let outcome: String = row.try_get("outcome")?;
    let finish = if outcome == PENDING {
        None
    } else {
        Some(Finish {
            outcome: Outcome::parse(&outcome).ok_or(OperationDbError::InvalidRow)?,
            reason: row.try_get("reason")?,
            audit_id: row.try_get("audit_id")?,
            finished_at_ms: row
                .try_get::<Option<i64>, _>("finished_at_ms")?
                .ok_or(OperationDbError::InvalidRow)?,
        })
    };
    let value: String = row.try_get("value")?;
    Ok(StoredRow {
        id: row.try_get("id")?,
        request: RequestRecord {
            requested_at_ms: row.try_get("requested_at_ms")?,
            user: row.try_get("user")?,
            phase: row.try_get("phase")?,
            hub_endpoint: row.try_get("hub_endpoint")?,
            project_id: row.try_get("project_id")?,
            project_digest: row.try_get("project_digest")?,
            screen_id: row.try_get("screen_id")?,
            object_id: row.try_get("object_id")?,
            equipment_id: row.try_get("equipment_id")?,
            equipment_code: row.try_get("equipment_code")?,
            slot: row.try_get("slot")?,
            tag: row.try_get("tag")?,
            value: serde_json::from_str(&value)?,
        },
        repeat_count: row.try_get("repeat_count")?,
        finish,
    })
}

/// The last request of a slot as the screen shows it (§8, §9). The webview
/// never reads `pending` as "sending" by itself: the host says which.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum RecordState {
    Finished(Finish),
    /// The row this process is sending now.
    Sending,
    /// The send ended but its outcome could not be written; `finish` is the
    /// outcome when this process still has it (a row of an earlier process
    /// has none).
    Unrecorded {
        finish: Option<Finish>,
    },
}

/// Why the terminal may not send now (§7), before the send slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    /// `write_stopped`: the Hub tripped the write key.
    Stopped,
    /// `key_invalid`: the Hub refused the write key.
    KeyInvalid,
    /// `too_soon`: within the minimum interval after the last send slot.
    TooSoon,
}

/// A request could not start.
#[derive(Debug)]
pub enum BeginError {
    /// Another write of this terminal is in flight (`busy`, §4).
    Busy,
    /// The write key the request was checked with is no longer the
    /// registered one (registered again or deleted meanwhile, §7): nothing
    /// is sent with a key the record no longer points at (`key_changed`).
    KeyChanged,
    /// The write state or the minimum interval refused it (§7), checked
    /// again with the send slot taken.
    Gate(Gate),
    /// The `pending` row could not be written: nothing may be sent
    /// (`record_failed`, §4-6).
    Record(OperationDbError),
}

#[derive(Default)]
struct InFlight {
    sending: Option<String>,
    /// The keyring entry id of the write key `sending` was sent with
    /// (`KeyRef::id`): its outcome moves the write state only while that
    /// key is still the registered one (§7).
    sending_key: Option<String>,
    /// Rows whose outcome this process knows but could not write.
    unrecorded: BTreeMap<String, Finish>,
    /// The terminal's write state (§7); the file follows it.
    write: WriteStatus,
    /// The write state moved but the file does not have it yet; saved
    /// again after the next write the DB takes.
    write_unsaved: bool,
    /// When the last send slot was taken, on the monotonic clock (a wall
    /// clock that goes back must not hold writes back).
    last_begin: Option<Instant>,
    /// The registered write key; `None` when no key is registered (§7).
    key: Option<KeyRef>,
}

impl InFlight {
    /// Whether the row `id` holds the send slot with the key registered now.
    fn sent_with_current_key(&self, id: &str) -> bool {
        self.sending.as_deref() == Some(id)
            && self.sending_key.is_some()
            && self.sending_key.as_deref() == self.key.as_ref().map(|key| key.id.as_str())
    }

    fn gate(&self, min_interval: Duration) -> Result<(), Gate> {
        match self.write.state {
            WriteState::Stopped => return Err(Gate::Stopped),
            WriteState::KeyInvalid => return Err(Gate::KeyInvalid),
            WriteState::Ready => {}
        }
        match self.last_begin {
            Some(last) if last.elapsed() < min_interval => Err(Gate::TooSoon),
            _ => Ok(()),
        }
    }
}

/// The send slot `begin` took, freed on drop unless `keep` hands it to the
/// caller (an error return or a dropped `begin` future).
struct Reservation<'a> {
    in_flight: &'a Mutex<InFlight>,
    id: &'a str,
    armed: bool,
}

impl Reservation<'_> {
    fn keep(mut self) {
        self.armed = false;
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        if in_flight.sending.as_deref() == Some(self.id) {
            in_flight.sending = None;
            in_flight.sending_key = None;
        }
    }
}

/// The record plus what only this process knows: the row it is sending (at
/// most one per terminal, §4) and the outcomes it could not write (§9).
pub struct OperationLog {
    db: OperationDb,
    in_flight: Mutex<InFlight>,
    /// Held across every save of the write state and the change of the
    /// in-memory copy that goes with it (a trip, a retried save, a resume,
    /// a registration), so an older snapshot is never saved over a newer
    /// state.
    state_lock: tokio::sync::Mutex<()>,
    /// The minimum interval between writes, in milliseconds (§7, §11-10):
    /// the saved one, changed only after the file has the new one.
    min_interval_ms: std::sync::atomic::AtomicI64,
    /// Held across a save of the minimum interval and the change of the
    /// in-memory copy, so two saves never end in the older value.
    settings_lock: tokio::sync::Mutex<()>,
}

impl OperationLog {
    pub fn new(db: OperationDb) -> Self {
        let write = db.write_status;
        let key = db.key.clone();
        let min_interval_ms = std::sync::atomic::AtomicI64::new(db.min_interval_ms);
        Self {
            min_interval_ms,
            settings_lock: tokio::sync::Mutex::new(()),
            db,
            in_flight: Mutex::new(InFlight {
                write,
                key,
                ..InFlight::default()
            }),
            state_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// The terminal's write state (§7).
    pub fn write_status(&self) -> WriteStatus {
        self.in_flight.lock().expect("operation log lock").write
    }

    /// Whether a write may start now as far as the write state and the
    /// minimum interval since the last send slot go (§7). `begin` checks
    /// again with the slot taken.
    pub fn gate(&self, min_interval: Duration) -> Result<(), Gate> {
        self.in_flight
            .lock()
            .expect("operation log lock")
            .gate(min_interval)
    }

    /// The Hub endpoint the write key was registered for (§7), `None`
    /// when no key is registered.
    pub fn key_endpoint(&self) -> Option<String> {
        self.key().map(|key| key.endpoint)
    }

    /// The registered write key (§7).
    pub fn key(&self) -> Option<KeyRef> {
        self.in_flight
            .lock()
            .expect("operation log lock")
            .key
            .clone()
    }

    /// A write key was registered (§7): the key (endpoint and keyring
    /// entry) replaces the previous one and any state becomes `ready`, once
    /// the file has them in one statement. Called by
    /// `operation_key::register` after the keyring took the secret under
    /// the new entry.
    pub async fn key_registered(&self, now_ms: i64, key: &KeyRef) -> Result<(), OperationDbError> {
        let _state = self.state_lock.lock().await;
        write_state::save_key(&self.db.pool, WriteState::Ready, now_ms, Some(key)).await?;
        let mut in_flight = self.in_flight.lock().expect("operation log lock");
        in_flight.write = WriteStatus {
            state: WriteState::Ready,
            changed_at_ms: Some(now_ms),
        };
        in_flight.write_unsaved = false;
        in_flight.key = Some(key.clone());
        Ok(())
    }

    /// The write key is being deleted (§7): the key is dropped once the file
    /// has it, so no write finds a key even if the keyring still holds the
    /// secret. The state is kept (a new key makes it `ready`). Returns the
    /// key that was registered, whose keyring entry the caller removes.
    pub async fn key_deleted(&self) -> Result<Option<KeyRef>, OperationDbError> {
        let _state = self.state_lock.lock().await;
        let status = self.write_status();
        write_state::save_key(
            &self.db.pool,
            status.state,
            status.changed_at_ms.unwrap_or_default(),
            None,
        )
        .await?;
        let mut in_flight = self.in_flight.lock().expect("operation log lock");
        in_flight.write_unsaved = false;
        Ok(in_flight.key.take())
    }

    /// Resume a stopped terminal (§7 「書込みを再開」): `stopped` becomes
    /// `ready` once the file has it, so a failed save leaves it stopped.
    /// Returns whether it changed; a `key_invalid` terminal is not resumed
    /// (only registering the key again clears it).
    pub async fn resume(&self, now_ms: i64) -> Result<bool, OperationDbError> {
        let _state = self.state_lock.lock().await;
        if self.write_status().state != WriteState::Stopped {
            return Ok(false);
        }
        write_state::save(&self.db.pool, WriteState::Ready, now_ms).await?;
        let mut in_flight = self.in_flight.lock().expect("operation log lock");
        // Nothing can be sent while stopped, so nothing moved it meanwhile.
        in_flight.write = WriteStatus {
            state: WriteState::Ready,
            changed_at_ms: Some(now_ms),
        };
        in_flight.write_unsaved = false;
        Ok(true)
    }

    /// The minimum interval between writes (§7, §11-10).
    pub fn min_interval(&self) -> Duration {
        let ms = self
            .min_interval_ms
            .load(std::sync::atomic::Ordering::Acquire);
        Duration::from_millis(u64::try_from(ms).unwrap_or(0))
    }

    /// Save `ms` as the minimum interval (O2c-4b). Out of the range (or off
    /// its step) is `InvalidSetting` and changes nothing; the in-memory
    /// interval changes only once the file has it. A write already past the
    /// check keeps the interval it was checked with.
    pub async fn set_min_interval(&self, ms: i64) -> Result<(), OperationDbError> {
        if !valid_min_interval(ms) {
            return Err(OperationDbError::InvalidSetting);
        }
        let _settings = self.settings_lock.lock().await;
        terminal_settings::save_min_interval(&self.db.pool, ms).await?;
        self.min_interval_ms
            .store(ms, std::sync::atomic::Ordering::Release);
        Ok(())
    }

    pub async fn close(self) {
        self.db.close().await;
    }

    /// Reserve the terminal's single send slot and write the `pending` row
    /// (log-before-write). `key_id` is the keyring entry id of the write key
    /// the request was checked with (`KeyRef::id`); when the record points
    /// at another key now (registered again or deleted since), nothing
    /// starts (`KeyChanged`). Returns the row id, which is also the Hub's
    /// `correlation_id` (UUID v7, 36 chars). On `Record` the slot is free
    /// again and nothing may be sent. When the future is dropped before it
    /// returns, the slot is freed too (the caller never got the id, so it
    /// cannot send); a row it already wrote reads as `unrecorded`.
    pub async fn begin(
        &self,
        request: &RequestRecord,
        min_interval: Duration,
        key_id: &str,
    ) -> Result<String, BeginError> {
        let id = uuid::Uuid::now_v7().to_string();
        {
            let mut in_flight = self.in_flight.lock().expect("operation log lock");
            if in_flight.sending.is_some() {
                return Err(BeginError::Busy);
            }
            if in_flight.key.as_ref().map(|key| key.id.as_str()) != Some(key_id) {
                return Err(BeginError::KeyChanged);
            }
            in_flight.gate(min_interval).map_err(BeginError::Gate)?;
            in_flight.sending = Some(id.clone());
            in_flight.sending_key = Some(key_id.into());
            in_flight.last_begin = Some(Instant::now());
        }
        let reservation = Reservation {
            in_flight: &self.in_flight,
            id: &id,
            armed: true,
        };
        if let Err(error) = self.db.insert_pending(&id, request).await {
            return Err(BeginError::Record(error));
        }
        self.retry_unrecorded().await;
        reservation.keep();
        Ok(id)
    }

    /// Start the send of the row `begin` returned (§4-8): `start` runs (and
    /// spawns the send task) only while the key the row was checked with is
    /// still the registered one, under the same lock a registration and a
    /// deletion take. So a key registered again or deleted after `begin`
    /// never sends, and one changed after the start is ordered after it (the
    /// send is not taken back). Never waits for the Hub: `start` only
    /// spawns. `KeyChanged` when the key changed; the caller finishes the
    /// row `refused` (`key_changed`).
    pub async fn start_send<T>(
        &self,
        id: &str,
        start: impl FnOnce() -> T,
    ) -> Result<T, BeginError> {
        let _state = self.state_lock.lock().await;
        if !self
            .in_flight
            .lock()
            .expect("operation log lock")
            .sent_with_current_key(id)
        {
            return Err(BeginError::KeyChanged);
        }
        Ok(start())
    }

    /// Write a refusal that never reserved the send slot (§4 2–5). A
    /// repeat of the slot's last refusal within [`FOLD_WINDOW_MS`] is folded
    /// into that row (`repeat_count`, §7) and its id returned.
    pub async fn refuse(
        &self,
        request: &RequestRecord,
        reason: &str,
        finished_at_ms: i64,
    ) -> Result<String, OperationDbError> {
        let finish = Finish {
            outcome: Outcome::Refused,
            reason: Some(reason.into()),
            audit_id: None,
            finished_at_ms,
        };
        let id = match self.db.fold_refusal(request, &finish).await? {
            Some(id) => id,
            None => {
                let id = uuid::Uuid::now_v7().to_string();
                self.db.insert_finished(&id, request, &finish).await?;
                id
            }
        };
        self.retry_unrecorded().await;
        Ok(id)
    }

    /// Finish the row `begin` returned and free the send slot. When the
    /// outcome cannot be written, the row stays `pending`, this process keeps
    /// the outcome (shown as `unrecorded`, rewritten on the next successful
    /// write — never re-sent) and the error is returned so the screen adds
    /// 「記録に失敗」 to the actual outcome.
    ///
    /// A tripped or refused key moves the write state (§7) before the slot
    /// is freed, so the next write already sees it — only when the key the
    /// row was sent with is still the registered one. An outcome of a key
    /// registered again or deleted while it was in flight is recorded as it
    /// is but leaves the state alone: a late 401 or trip of the previous
    /// key never stops the terminal the new key made `ready`. The row and the state
    /// are one transaction; when it fails, the state still holds in this
    /// process and is saved on its own again, now and after the next write
    /// the DB takes.
    pub async fn complete(&self, id: &str, finish: Finish) -> Result<(), OperationDbError> {
        let candidate = WriteState::after(&finish);
        // Under the state lock: a registration or deletion (which take it
        // too) is ordered before or after this check, never in between.
        let state_guard = match candidate {
            Some(_) => Some(self.state_lock.lock().await),
            None => None,
        };
        let moved = candidate
            .filter(|_| {
                self.in_flight
                    .lock()
                    .expect("operation log lock")
                    .sent_with_current_key(id)
            })
            .map(|state| WriteStatus {
                state,
                changed_at_ms: Some(finish.finished_at_ms),
            });
        let result = match moved {
            Some(status) => self.db.finish_with_state(id, &finish, status).await,
            None => self.db.finish(id, &finish).await,
        };
        let result = {
            let mut in_flight = self.in_flight.lock().expect("operation log lock");
            if let Some(status) = moved {
                in_flight.write = status;
                in_flight.write_unsaved = result.is_err();
            }
            if in_flight.sending.as_deref() == Some(id) {
                in_flight.sending = None;
                in_flight.sending_key = None;
            }
            match result {
                // `InvalidRow` means the row is no longer pending: nothing to keep.
                Err(error) if !matches!(error, OperationDbError::InvalidRow) => {
                    in_flight.unrecorded.insert(id.into(), finish);
                    Err(error)
                }
                other => other,
            }
        };
        drop(state_guard);
        if moved.is_some() && result.is_err() {
            // The row could not be finished (or was finished already): the
            // state alone.
            self.save_write_state().await;
        }
        result?;
        // The DB took a write again: rewrite the outcomes kept earlier, so
        // they are not lost to `interrupted` if the process ends before the
        // next request.
        self.retry_unrecorded().await;
        Ok(())
    }

    /// Save the write state when the file does not have it yet. A failure
    /// is logged and kept for the next try; the state holds in this
    /// process either way.
    async fn save_write_state(&self) {
        let _state = self.state_lock.lock().await;
        let status = {
            let in_flight = self.in_flight.lock().expect("operation log lock");
            if !in_flight.write_unsaved {
                return;
            }
            in_flight.write
        };
        let at = status.changed_at_ms.unwrap_or_default();
        match write_state::save(&self.db.pool, status.state, at).await {
            Ok(()) => {
                let mut in_flight = self.in_flight.lock().expect("operation log lock");
                if in_flight.write == status {
                    in_flight.write_unsaved = false;
                }
            }
            Err(error) => {
                eprintln!("operation log: the write state could not be saved: {error:?}");
            }
        }
    }

    /// Rewrite outcomes this process could not write. Kept for a later try
    /// when the DB is still failing; dropped once the row is no longer
    /// `pending`.
    ///
    /// An outcome that moves the write state (a trip, a refused key) stays
    /// `pending` while the state is not saved yet: the record never has the
    /// trip with `ready` in the file. Once the state is saved, or a later
    /// resume or registration saved a newer one, the row is finished.
    async fn retry_unrecorded(&self) {
        self.save_write_state().await;
        let pending: Vec<(String, Finish)> = {
            let in_flight = self.in_flight.lock().expect("operation log lock");
            let state_saved = !in_flight.write_unsaved;
            in_flight
                .unrecorded
                .iter()
                .filter(|(_, finish)| state_saved || WriteState::after(finish).is_none())
                .map(|(id, finish)| (id.clone(), finish.clone()))
                .collect()
        };
        for (id, finish) in pending {
            match self.db.finish(&id, &finish).await {
                Ok(()) | Err(OperationDbError::InvalidRow) => {
                    self.in_flight
                        .lock()
                        .expect("operation log lock")
                        .unrecorded
                        .remove(&id);
                }
                Err(_) => {}
            }
        }
    }

    /// Whether a write of this terminal holds the send slot now (`busy`,
    /// §4-6). A read for the screen; `begin` decides under the same lock.
    pub fn is_sending(&self) -> bool {
        self.in_flight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sending
            .is_some()
    }

    /// The last request of one slot, with its `pending` state resolved (§9).
    pub async fn latest(
        &self,
        project_id: &str,
        equipment_id: &str,
        slot: &str,
    ) -> Result<Option<(StoredRow, RecordState)>, OperationDbError> {
        let Some(row) = self.db.latest(project_id, equipment_id, slot).await? else {
            return Ok(None);
        };
        self.resolve(row).await.map(Some)
    }

    /// The state of a row read from the DB. A `pending` row that this
    /// process neither sends nor holds an outcome for is read again: the
    /// row's `complete` (or a rewrite) may have finished it between the read
    /// and the lock. Both write the DB before they release the row in memory,
    /// so the second read sees the outcome; a row still `pending` then is
    /// one of an earlier process.
    async fn resolve(&self, row: StoredRow) -> Result<(StoredRow, RecordState), OperationDbError> {
        if let Some(finish) = &row.finish {
            let state = RecordState::Finished(finish.clone());
            return Ok((row, state));
        }
        {
            let in_flight = self.in_flight.lock().expect("operation log lock");
            if in_flight.sending.as_deref() == Some(row.id.as_str()) {
                return Ok((row, RecordState::Sending));
            }
            if let Some(finish) = in_flight.unrecorded.get(&row.id) {
                let state = RecordState::Unrecorded {
                    finish: Some(finish.clone()),
                };
                return Ok((row, state));
            }
        }
        let row = self.db.row(&row.id).await?.unwrap_or(row);
        let state = match &row.finish {
            Some(finish) => RecordState::Finished(finish.clone()),
            None => RecordState::Unrecorded { finish: None },
        };
        Ok((row, state))
    }

    #[cfg(test)]
    pub(crate) fn db(&self) -> &OperationDb {
        &self.db
    }
}
