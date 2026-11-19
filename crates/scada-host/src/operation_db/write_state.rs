//! The terminal's write state (operation stage-3 design §7, §11-6; O2c-2):
//! `ready`, `stopped` after the Hub tripped the write key (403
//! `key_tripped`) and `key_invalid` after it refused the key (401). Kept in
//! `operations.db` (table `terminal_write`, one row) so a restart does not
//! resume writes; the in-memory copy lives in `OperationLog`.
use banto_tagclient::ErrorKind;
use serde::Serialize;
use sqlx::{Row, Sqlite, SqlitePool};

use super::{Finish, OperationDbError, Outcome};

/// The table of the state, created with the record (format 2) or added to
/// a format-1 file.
pub(super) const CREATE_TABLE: &str = "CREATE TABLE terminal_write (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       state TEXT NOT NULL CHECK (state IN ('ready','stopped','key_invalid')),
       changed_at_ms INTEGER NOT NULL
     );";

/// Whether this terminal may send writes (§7).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteState {
    #[default]
    Ready,
    /// The Hub tripped the write key (403 `key_tripped`). Writes are refused
    /// with `write_stopped` until the screen resumes them or the key is
    /// registered again.
    Stopped,
    /// The Hub refused the write key (401: revoked or deleted). Writes are
    /// refused with `key_invalid` until the key is registered again.
    KeyInvalid,
}

impl WriteState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Stopped => "stopped",
            Self::KeyInvalid => "key_invalid",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "ready" => Self::Ready,
            "stopped" => Self::Stopped,
            "key_invalid" => Self::KeyInvalid,
            _ => return None,
        })
    }

    /// The state a sent write's outcome moves the terminal to, if any: a
    /// tripped key stops it, a refused key makes it `key_invalid`.
    pub fn after(finish: &Finish) -> Option<Self> {
        let reason = finish.reason.as_deref()?;
        if finish.outcome == Outcome::Stopped && reason == ErrorKind::KeyTripped.as_str() {
            Some(Self::Stopped)
        } else if reason == ErrorKind::Unauthorized.as_str() {
            Some(Self::KeyInvalid)
        } else {
            None
        }
    }
}

/// The state and when it last changed (`None`: never, the file's default).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteStatus {
    pub state: WriteState,
    pub changed_at_ms: Option<i64>,
}

pub(super) async fn load(pool: &SqlitePool) -> Result<WriteStatus, OperationDbError> {
    let row = sqlx::query("SELECT state, changed_at_ms FROM terminal_write WHERE id = 1")
        .fetch_optional(pool)
        .await?;
    let Some(row) = row else {
        return Ok(WriteStatus::default());
    };
    let state: String = row.try_get("state")?;
    Ok(WriteStatus {
        state: WriteState::parse(&state).ok_or(OperationDbError::InvalidRow)?,
        changed_at_ms: Some(row.try_get("changed_at_ms")?),
    })
}

/// Save the state with `executor`: the pool, or the transaction that also
/// finishes the row whose outcome moved it.
pub(super) async fn save<'e, E>(
    executor: E,
    state: WriteState,
    changed_at_ms: i64,
) -> Result<(), OperationDbError>
where
    E: sqlx::Executor<'e, Database = Sqlite>,
{
    sqlx::query(
        "INSERT INTO terminal_write (id, state, changed_at_ms) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, changed_at_ms = excluded.changed_at_ms",
    )
    .bind(state.as_str())
    .bind(changed_at_ms)
    .execute(executor)
    .await?;
    Ok(())
}
