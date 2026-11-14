//! Per-Project SQLite ledger for alarm definitions, events, last states and
//! session evidence. No Historian tables or UI lifetime are shared with it.
use std::collections::BTreeMap;
use std::path::Path;
use std::str::FromStr;

use scada_alarm::{
    ConditionSpec, DefineError, Engine, EngineUnavailable, Input, LastState, Now, Session,
    StepError,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

use crate::durable;

const FORMAT: i64 = 1;

#[derive(Debug)]
pub enum AlarmDbError {
    InvalidProjectId,
    Io(std::io::Error),
    Sql(sqlx::Error),
    Json(serde_json::Error),
    UnsupportedFormat,
    InvalidRow,
}

impl From<std::io::Error> for AlarmDbError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}
impl From<sqlx::Error> for AlarmDbError {
    fn from(error: sqlx::Error) -> Self {
        Self::Sql(error)
    }
}
impl From<serde_json::Error> for AlarmDbError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedDefinitions {
    pub project_id: String,
    pub project_revision: u64,
    pub file_hash: String,
    pub endpoint: String,
    pub applied_by: String,
    pub applied_at_ms: i64,
    /// Validated Project alarm definitions; they remain available at startup
    /// even if the Project file was edited or cannot be opened.
    pub definitions: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastRow {
    pub condition_id: String,
    pub evaluation_hash: String,
    pub endpoint: String,
    pub state: LastState,
    pub session_id: String,
    pub last_event_seq: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SessionRecord {
    pub session: Session,
    pub stopped: bool,
    pub engine_unavailable: Option<EngineUnavailable>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EventWrite {
    pub at_ms: i64,
    pub condition_id: Option<String>,
    pub kind: String,
    pub detail: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EventRead {
    pub seq: i64,
    pub session_id: String,
    pub event: EventWrite,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Definition {
    pub spec: ConditionSpec,
    pub evaluation_hash: String,
}

#[derive(Debug)]
pub enum RestoreError {
    Define(DefineError),
    State(StepError),
}

pub struct RestorePlan {
    pub engine: Engine,
    pub restored: Vec<LastRow>,
    pub ended: Vec<EventWrite>,
}

/// Selects only the rows whose evaluation hash and Hub endpoint still match.
/// Reconstructs the pure Engine before the DB session transaction is started.
/// The caller passes `ended` and `restored` to `start_session`; it must not
/// expose this Engine until that transaction succeeds.
pub fn plan_restore(
    session: Session,
    endpoint: &str,
    at_ms: i64,
    definitions: &BTreeMap<String, Definition>,
    previous: &[LastRow],
) -> Result<RestorePlan, RestoreError> {
    let mut engine = Engine::new(session.clone());
    for (id, definition) in definitions {
        engine
            .define(id, definition.spec.clone())
            .map_err(RestoreError::Define)?;
    }
    let mut restored = Vec::new();
    let mut ended = Vec::new();
    for row in previous {
        let definition = definitions.get(&row.condition_id);
        if row.endpoint == endpoint
            && definition
                .is_some_and(|definition| definition.evaluation_hash == row.evaluation_hash)
        {
            let transition = engine
                .step(
                    Now {
                        mono_ms: 0,
                        wall_ms: at_ms,
                    },
                    &Input::Restore {
                        condition: row.condition_id.clone(),
                        row: row.state.clone(),
                    },
                    &mut || unreachable!("restore cannot create an occurrence"),
                )
                .map_err(RestoreError::State)?;
            engine.commit(transition);
            let mut restored_row = row.clone();
            restored_row.session_id = session.id.clone();
            restored.push(restored_row);
        } else {
            let reason = if row.endpoint != endpoint {
                "connectionChanged"
            } else if definition.is_some() {
                "definitionChanged"
            } else {
                "definitionDeleted"
            };
            ended.push(EventWrite {
                at_ms,
                condition_id: Some(row.condition_id.clone()),
                kind: reason.into(),
                detail: json!({"unacked": !row.state.acked, "previous": row.state}),
            });
        }
    }
    Ok(RestorePlan {
        engine,
        restored,
        ended,
    })
}

pub struct AlarmDb {
    pool: SqlitePool,
    project_id: String,
}

impl AlarmDb {
    pub async fn open(data_dir: &Path, project_id: &str) -> Result<Self, AlarmDbError> {
        // A Project id becomes a filename; reject path segments and non-UUIDs.
        let id = uuid::Uuid::parse_str(project_id).map_err(|_| AlarmDbError::InvalidProjectId)?;
        if id.to_string() != project_id {
            return Err(AlarmDbError::InvalidProjectId);
        }
        let dir = data_dir.join("alarms");
        durable::create_dir_durably(&dir)?;
        let options = SqliteConnectOptions::from_str(
            dir.join(format!("{id}.db"))
                .to_str()
                .ok_or(AlarmDbError::InvalidProjectId)?,
        )?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await?;
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&pool)
            .await?;
        if version != 0 && version != FORMAT {
            return Err(AlarmDbError::UnsupportedFormat);
        }
        if version == 0 {
            let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
                .fetch_one(&pool)
                .await?;
            if existing != 0 {
                return Err(AlarmDbError::UnsupportedFormat);
            }
            let mut tx = pool.begin().await?;
            sqlx::raw_sql(
                "CREATE TABLE IF NOT EXISTS applied (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS session (id INTEGER PRIMARY KEY CHECK (id = 1), session_id TEXT NOT NULL, generation INTEGER NOT NULL, stopped INTEGER NOT NULL, engine_unavailable TEXT);
                 CREATE TABLE IF NOT EXISTS last_state (condition_id TEXT PRIMARY KEY CHECK (condition_id <> ''), evaluation_hash TEXT NOT NULL, endpoint TEXT NOT NULL, state TEXT NOT NULL, session_id TEXT NOT NULL, last_event_seq INTEGER);
                 CREATE TABLE IF NOT EXISTS event (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, at_ms INTEGER NOT NULL, condition_id TEXT, kind TEXT NOT NULL, detail TEXT NOT NULL);
                 PRAGMA user_version = 1;",
            )
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
        }
        Ok(Self {
            pool,
            project_id: project_id.into(),
        })
    }

    /// Release SQLite handles before an application shutdown or an isolated
    /// test removes its temporary directory.
    pub async fn close(self) {
        self.pool.close().await;
    }

    pub async fn applied(&self) -> Result<Option<AppliedDefinitions>, AlarmDbError> {
        let body: Option<String> = sqlx::query_scalar("SELECT body FROM applied WHERE id = 1")
            .fetch_optional(&self.pool)
            .await?;
        let applied: Option<AppliedDefinitions> =
            body.map(|body| serde_json::from_str(&body)).transpose()?;
        if applied
            .as_ref()
            .is_some_and(|applied| applied.project_id != self.project_id)
        {
            return Err(AlarmDbError::InvalidRow);
        }
        Ok(applied)
    }

    pub async fn session(&self) -> Result<Option<SessionRecord>, AlarmDbError> {
        let row = sqlx::query(
            "SELECT session_id, generation, stopped, engine_unavailable FROM session WHERE id = 1",
        )
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            let generation: i64 = row.try_get("generation")?;
            if generation < 1 {
                return Err(AlarmDbError::InvalidRow);
            }
            let unavailable: Option<String> = row.try_get("engine_unavailable")?;
            let stopped: i64 = row.try_get("stopped")?;
            if !matches!(stopped, 0 | 1) {
                return Err(AlarmDbError::InvalidRow);
            }
            Ok(SessionRecord {
                session: Session {
                    id: row.try_get("session_id")?,
                    generation: generation as u64,
                },
                stopped: stopped == 1,
                engine_unavailable: unavailable
                    .map(|value| serde_json::from_str::<EngineUnavailable>(&value))
                    .transpose()?,
            })
        })
        .transpose()
    }

    pub async fn last_states(&self) -> Result<Vec<LastRow>, AlarmDbError> {
        let rows = sqlx::query("SELECT condition_id, evaluation_hash, endpoint, state, session_id, last_event_seq FROM last_state ORDER BY condition_id")
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter()
            .map(|row| {
                let state: String = row.try_get("state")?;
                Ok(LastRow {
                    condition_id: row.try_get("condition_id")?,
                    evaluation_hash: row.try_get("evaluation_hash")?,
                    endpoint: row.try_get("endpoint")?,
                    state: serde_json::from_str(&state)?,
                    session_id: row.try_get("session_id")?,
                    last_event_seq: row.try_get("last_event_seq")?,
                })
            })
            .collect()
    }

    /// Atomically writes the applied definition, termination events, and the
    /// complete surviving state set. The caller updates the live Engine only
    /// after this returns successfully.
    pub async fn apply(
        &self,
        applied: &AppliedDefinitions,
        session_id: &str,
        ended: &[EventWrite],
        survivors: &[LastRow],
    ) -> Result<(), AlarmDbError> {
        if applied.project_id != self.project_id {
            return Err(AlarmDbError::InvalidProjectId);
        }
        let mut tx = self.pool.begin().await?;
        for event in ended {
            insert_event(&mut tx, session_id, event).await?;
        }
        sqlx::query("DELETE FROM last_state")
            .execute(&mut *tx)
            .await?;
        for row in survivors {
            insert_state(&mut tx, row).await?;
        }
        sqlx::query("INSERT INTO applied (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body")
            .bind(serde_json::to_string(applied)?)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Start a new session with the rows the caller validated and restored
    /// through `scada-alarm`. Crash evidence and start are in one transaction.
    pub async fn start_session(
        &self,
        session: &Session,
        at_ms: i64,
        ended: &[EventWrite],
        restored: &[LastRow],
    ) -> Result<(), AlarmDbError> {
        let generation = i64::try_from(session.generation).map_err(|_| AlarmDbError::InvalidRow)?;
        let mut tx = self.pool.begin().await?;
        let previous = sqlx::query(
            "SELECT session_id, generation, stopped, engine_unavailable FROM session WHERE id = 1",
        )
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(previous) = previous {
            if generation <= previous.try_get::<i64, _>("generation")? {
                return Err(AlarmDbError::InvalidRow);
            }
            let stopped: i64 = previous.try_get("stopped")?;
            if !matches!(stopped, 0 | 1) {
                return Err(AlarmDbError::InvalidRow);
            }
            if stopped == 0 {
                let old_id: String = previous.try_get("session_id")?;
                let last_at: Option<i64> =
                    sqlx::query_scalar("SELECT MAX(at_ms) FROM event WHERE session_id = ?")
                        .bind(&old_id)
                        .fetch_one(&mut *tx)
                        .await?;
                let rows = sqlx::query("SELECT condition_id, state FROM last_state")
                    .fetch_all(&mut *tx)
                    .await?;
                for row in rows {
                    let state: LastState =
                        serde_json::from_str(&row.try_get::<String, _>("state")?)?;
                    if state.active || !state.acked || state.unavailable.is_some() {
                        insert_event(
                            &mut tx,
                            &old_id,
                            &EventWrite {
                                at_ms,
                                condition_id: Some(row.try_get("condition_id")?),
                                kind: "previousSessionState".into(),
                                detail: serde_json::to_value(state)?,
                            },
                        )
                        .await?;
                    }
                }
                let unavailable: Option<String> = previous.try_get("engine_unavailable")?;
                if let Some(unavailable) = unavailable {
                    insert_event(
                        &mut tx,
                        &old_id,
                        &EventWrite {
                            at_ms,
                            condition_id: None,
                            kind: "previousEngineUnavailable".into(),
                            detail: serde_json::from_str(&unavailable)?,
                        },
                    )
                    .await?;
                }
                insert_event(
                    &mut tx,
                    &old_id,
                    &EventWrite {
                        at_ms,
                        condition_id: None,
                        kind: "unknownPeriod".into(),
                        detail: json!({"fromMs": last_at, "toMs": at_ms}),
                    },
                )
                .await?;
            }
        }
        for event in ended {
            insert_event(&mut tx, &session.id, event).await?;
        }
        sqlx::query("DELETE FROM last_state")
            .execute(&mut *tx)
            .await?;
        for row in restored {
            let mut row = row.clone();
            row.session_id = session.id.clone();
            insert_state(&mut tx, &row).await?;
        }
        insert_event(
            &mut tx,
            &session.id,
            &EventWrite {
                at_ms,
                condition_id: None,
                kind: "engineStarted".into(),
                detail: json!({"generation": session.generation}),
            },
        )
        .await?;
        sqlx::query("INSERT INTO session (id, session_id, generation, stopped, engine_unavailable) VALUES (1, ?, ?, 0, NULL) ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, generation = excluded.generation, stopped = 0, engine_unavailable = NULL")
            .bind(&session.id)
            .bind(generation)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Commits state and events together; an ACK is acknowledged only after
    /// this succeeds. The caller then commits the pure Engine transition.
    pub async fn append(
        &self,
        session: &Session,
        events: &[EventWrite],
        changed: &[LastRow],
        removed: &[String],
        unavailable: Option<EngineUnavailable>,
    ) -> Result<(), AlarmDbError> {
        let mut tx = self.pool.begin().await?;
        require_session(&mut tx, session).await?;
        let mut last_event = std::collections::HashMap::new();
        for event in events {
            let seq = insert_event(&mut tx, &session.id, event).await?;
            if let Some(id) = &event.condition_id {
                last_event.insert(id.clone(), seq);
            }
        }
        for row in changed {
            let mut row = row.clone();
            row.session_id = session.id.clone();
            if let Some(seq) = last_event.get(&row.condition_id) {
                row.last_event_seq = Some(*seq);
            }
            insert_state(&mut tx, &row).await?;
        }
        for id in removed {
            sqlx::query("DELETE FROM last_state WHERE condition_id = ?")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        sqlx::query("UPDATE session SET engine_unavailable = ? WHERE id = 1")
            .bind(
                unavailable
                    .map(|value| serde_json::to_string(&value))
                    .transpose()?,
            )
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn stop_session(&self, session: &Session, at_ms: i64) -> Result<(), AlarmDbError> {
        let mut tx = self.pool.begin().await?;
        require_session(&mut tx, session).await?;
        let rows = sqlx::query("SELECT condition_id, state FROM last_state")
            .fetch_all(&mut *tx)
            .await?;
        for row in rows {
            let state: LastState = serde_json::from_str(&row.try_get::<String, _>("state")?)?;
            if state.active || !state.acked || state.unavailable.is_some() {
                insert_event(
                    &mut tx,
                    &session.id,
                    &EventWrite {
                        at_ms,
                        condition_id: Some(row.try_get("condition_id")?),
                        kind: "stoppedState".into(),
                        detail: serde_json::to_value(state)?,
                    },
                )
                .await?;
            }
        }
        let unavailable: Option<String> =
            sqlx::query_scalar("SELECT engine_unavailable FROM session WHERE id = 1")
                .fetch_one(&mut *tx)
                .await?;
        if let Some(unavailable) = unavailable {
            insert_event(
                &mut tx,
                &session.id,
                &EventWrite {
                    at_ms,
                    condition_id: None,
                    kind: "stoppedEngineUnavailable".into(),
                    detail: serde_json::from_str(&unavailable)?,
                },
            )
            .await?;
        }
        insert_event(
            &mut tx,
            &session.id,
            &EventWrite {
                at_ms,
                condition_id: None,
                kind: "engineStopped".into(),
                detail: Value::Null,
            },
        )
        .await?;
        sqlx::query("UPDATE session SET stopped = 1 WHERE id = 1")
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn events(&self) -> Result<Vec<EventRead>, AlarmDbError> {
        let rows = sqlx::query(
            "SELECT seq, session_id, at_ms, condition_id, kind, detail FROM event ORDER BY seq",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                let detail: String = row.try_get("detail")?;
                Ok(EventRead {
                    seq: row.try_get("seq")?,
                    session_id: row.try_get("session_id")?,
                    event: EventWrite {
                        at_ms: row.try_get("at_ms")?,
                        condition_id: row.try_get("condition_id")?,
                        kind: row.try_get("kind")?,
                        detail: serde_json::from_str(&detail)?,
                    },
                })
            })
            .collect()
    }
}

async fn require_session(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    session: &Session,
) -> Result<(), AlarmDbError> {
    let row = sqlx::query("SELECT session_id, generation, stopped FROM session WHERE id = 1")
        .fetch_optional(&mut **tx)
        .await?;
    let Some(row) = row else {
        return Err(AlarmDbError::InvalidRow);
    };
    let generation = i64::try_from(session.generation).map_err(|_| AlarmDbError::InvalidRow)?;
    if row.try_get::<String, _>("session_id")? != session.id
        || row.try_get::<i64, _>("generation")? != generation
        || row.try_get::<i64, _>("stopped")? != 0
    {
        return Err(AlarmDbError::InvalidRow);
    }
    Ok(())
}

async fn insert_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    session_id: &str,
    event: &EventWrite,
) -> Result<i64, AlarmDbError> {
    let result = sqlx::query(
        "INSERT INTO event (session_id, at_ms, condition_id, kind, detail) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(session_id)
    .bind(event.at_ms)
    .bind(&event.condition_id)
    .bind(&event.kind)
    .bind(serde_json::to_string(&event.detail)?)
    .execute(&mut **tx)
    .await?;
    Ok(result.last_insert_rowid())
}

async fn insert_state(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    row: &LastRow,
) -> Result<(), AlarmDbError> {
    sqlx::query("INSERT INTO last_state (condition_id, evaluation_hash, endpoint, state, session_id, last_event_seq) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(condition_id) DO UPDATE SET evaluation_hash = excluded.evaluation_hash, endpoint = excluded.endpoint, state = excluded.state, session_id = excluded.session_id, last_event_seq = excluded.last_event_seq")
        .bind(&row.condition_id).bind(&row.evaluation_hash).bind(&row.endpoint)
        .bind(serde_json::to_string(&row.state)?).bind(&row.session_id).bind(row.last_event_seq)
        .execute(&mut **tx).await?;
    Ok(())
}

#[cfg(test)]
mod tests;
