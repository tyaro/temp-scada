//! The terminal's operation record `operations.db` (operation stage-3 design
//! §9): one row per write request, kept across Projects. A row is written as
//! `pending` before anything is sent (log-before-write, §11-2) and finished
//! with the outcome of §5. The file sits directly in the terminal data dir,
//! not in `alarms/`, whose `.db` files are all read as alarm DBs.
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use banto_tagclient::ErrorKind;
use serde::Serialize;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

use crate::durable;

#[cfg(test)]
mod tests;

const FORMAT: i64 = 1;
const PENDING: &str = "pending";
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
        if version != 0 && version != FORMAT {
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
                 CREATE INDEX operation_slot_seq ON operation(project_id, equipment_id, slot, seq DESC);
                 PRAGMA user_version = 1;",
            )
            .execute(&mut *tx)
            .await?;
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
        Ok((Self { pool }, recovered))
    }

    /// Run raw SQL against the record (tests make writes fail with it).
    #[cfg(test)]
    pub(crate) async fn execute_for_test(&self, sql: &'static str) {
        sqlx::query(sql).execute(&self.pool).await.unwrap();
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
        let updated = sqlx::query(
            "UPDATE operation SET outcome = ?, reason = ?, audit_id = ?, finished_at_ms = ? WHERE id = ? AND outcome = 'pending'",
        )
        .bind(finish.outcome.as_str())
        .bind(finish.reason.as_deref())
        .bind(finish.audit_id)
        .bind(finish.finished_at_ms)
        .bind(id)
        .execute(&self.pool)
        .await?
        .rows_affected();
        if updated == 1 {
            Ok(())
        } else {
            Err(OperationDbError::InvalidRow)
        }
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

/// A request could not start.
#[derive(Debug)]
pub enum BeginError {
    /// Another write of this terminal is in flight (`busy`, §4).
    Busy,
    /// The `pending` row could not be written: nothing may be sent
    /// (`record_failed`, §4-6).
    Record(OperationDbError),
}

#[derive(Default)]
struct InFlight {
    sending: Option<String>,
    /// Rows whose outcome this process knows but could not write.
    unrecorded: BTreeMap<String, Finish>,
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
        }
    }
}

/// The record plus what only this process knows: the row it is sending (at
/// most one per terminal, §4) and the outcomes it could not write (§9).
pub struct OperationLog {
    db: OperationDb,
    in_flight: Mutex<InFlight>,
}

impl OperationLog {
    pub fn new(db: OperationDb) -> Self {
        Self {
            db,
            in_flight: Mutex::new(InFlight::default()),
        }
    }

    pub async fn close(self) {
        self.db.close().await;
    }

    /// Reserve the terminal's single send slot and write the `pending` row
    /// (log-before-write). Returns the row id, which is also the Hub's
    /// `correlation_id` (UUID v7, 36 chars). On `Record` the slot is free
    /// again and nothing may be sent. When the future is dropped before it
    /// returns, the slot is freed too (the caller never got the id, so it
    /// cannot send); a row it already wrote reads as `unrecorded`.
    pub async fn begin(&self, request: &RequestRecord) -> Result<String, BeginError> {
        let id = uuid::Uuid::now_v7().to_string();
        {
            let mut in_flight = self.in_flight.lock().expect("operation log lock");
            if in_flight.sending.is_some() {
                return Err(BeginError::Busy);
            }
            in_flight.sending = Some(id.clone());
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

    /// Write a refusal that never reserved the send slot (§4 2–5).
    pub async fn refuse(
        &self,
        request: &RequestRecord,
        reason: &str,
        finished_at_ms: i64,
    ) -> Result<String, OperationDbError> {
        let id = uuid::Uuid::now_v7().to_string();
        let finish = Finish {
            outcome: Outcome::Refused,
            reason: Some(reason.into()),
            audit_id: None,
            finished_at_ms,
        };
        self.db.insert_finished(&id, request, &finish).await?;
        self.retry_unrecorded().await;
        Ok(id)
    }

    /// Finish the row `begin` returned and free the send slot. When the
    /// outcome cannot be written, the row stays `pending`, this process keeps
    /// the outcome (shown as `unrecorded`, rewritten on the next successful
    /// write — never re-sent) and the error is returned so the screen adds
    /// 「記録に失敗」 to the actual outcome.
    pub async fn complete(&self, id: &str, finish: Finish) -> Result<(), OperationDbError> {
        let result = self.db.finish(id, &finish).await;
        {
            let mut in_flight = self.in_flight.lock().expect("operation log lock");
            if in_flight.sending.as_deref() == Some(id) {
                in_flight.sending = None;
            }
            if let Err(error) = result {
                // `InvalidRow` means the row is no longer pending: nothing to keep.
                if !matches!(error, OperationDbError::InvalidRow) {
                    in_flight.unrecorded.insert(id.into(), finish);
                }
                return Err(error);
            }
        }
        // The DB took a write again: rewrite the outcomes kept earlier, so
        // they are not lost to `interrupted` if the process ends before the
        // next request.
        self.retry_unrecorded().await;
        Ok(())
    }

    /// Rewrite outcomes this process could not write. Kept for a later try
    /// when the DB is still failing; dropped once the row is no longer
    /// `pending`.
    async fn retry_unrecorded(&self) {
        let pending: Vec<(String, Finish)> = {
            let in_flight = self.in_flight.lock().expect("operation log lock");
            in_flight
                .unrecorded
                .iter()
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
