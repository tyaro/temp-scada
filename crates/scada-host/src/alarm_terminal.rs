//! The alarm Engine's terminal-wide lock and durable session generation.
//! A generation is spent before a session can be inserted in a Project DB.
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};

use crate::durable;

const SETTINGS_FILE: &str = "alarm-terminal.json";
const LOCK_FILE: &str = "alarm-terminal.lock";
const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MonitoredProject {
    pub project_id: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingSwitch {
    pub target: MonitoredProject,
    pub file_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    version: u32,
    last_generation: u64,
    #[serde(skip)]
    pending_generation: Option<u64>,
    monitored: Option<MonitoredProject>,
    switching: Option<PendingSwitch>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalError {
    InUse,
    Unreadable,
    Corrupt,
    Lost,
    Save,
    Exhausted,
}

/// One process owns alarm monitoring for this data directory until dropped.
pub struct AlarmTerminal {
    data_dir: PathBuf,
    _lock: fs::File,
    settings: Mutex<Settings>,
}

impl AlarmTerminal {
    pub async fn open(data_dir: &Path) -> Result<Self, TerminalError> {
        let lock =
            durable::open_lock_file(data_dir, LOCK_FILE).map_err(|_| TerminalError::Unreadable)?;
        lock.try_lock().map_err(|_| TerminalError::InUse)?;
        let path = data_dir.join(SETTINGS_FILE);
        let max_generation = max_db_generation(data_dir).await?;
        let settings = match durable::read_optional(&path).map_err(|_| TerminalError::Unreadable)? {
            Some(bytes) => {
                let settings: Settings =
                    serde_json::from_slice(&bytes).map_err(|_| TerminalError::Corrupt)?;
                if settings.version != VERSION {
                    return Err(TerminalError::Corrupt);
                }
                if max_generation.is_some_and(|max| max > settings.last_generation) {
                    return Err(TerminalError::Lost);
                }
                settings
            }
            None if max_generation.is_some() => return Err(TerminalError::Lost),
            None => Settings {
                version: VERSION,
                last_generation: 0,
                pending_generation: None,
                monitored: None,
                switching: None,
            },
        };
        Ok(Self {
            data_dir: data_dir.to_owned(),
            _lock: lock,
            settings: Mutex::new(settings),
        })
    }

    /// Persist the next number before writing a session to its Project DB.
    /// A DB failure after this call leaves a harmless gap. This performs a
    /// synchronous durable write; async callers run it on a blocking thread.
    pub fn reserve_generation(&self) -> Result<u64, TerminalError> {
        let mut settings = self.settings.lock().map_err(|_| TerminalError::Corrupt)?;
        let next = settings
            .last_generation
            .checked_add(1)
            .ok_or(TerminalError::Exhausted)?;
        let mut updated = settings.clone();
        updated.last_generation = next;
        updated.pending_generation = Some(next);
        let bytes = serde_json::to_vec(&updated).map_err(|_| TerminalError::Save)?;
        durable::replace(&self.data_dir.join(SETTINGS_FILE), &bytes)
            .map_err(|_| TerminalError::Save)?;
        *settings = updated;
        Ok(next)
    }

    pub fn monitored(&self) -> Result<Option<MonitoredProject>, TerminalError> {
        Ok(self
            .settings
            .lock()
            .map_err(|_| TerminalError::Corrupt)?
            .monitored
            .clone())
    }

    pub fn switching(&self) -> Result<Option<PendingSwitch>, TerminalError> {
        Ok(self
            .settings
            .lock()
            .map_err(|_| TerminalError::Corrupt)?
            .switching
            .clone())
    }

    pub(crate) fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Spend a number reserved by this process exactly once. A failed DB
    /// transaction leaves a gap; a restarted process must reserve again.
    pub(crate) fn claim_generation(&self, generation: u64) -> Result<(), TerminalError> {
        let mut settings = self.settings.lock().map_err(|_| TerminalError::Corrupt)?;
        if settings.pending_generation != Some(generation) {
            return Err(TerminalError::Lost);
        }
        settings.pending_generation = None;
        Ok(())
    }

    /// The later apply boundary uses this to publish an A→B decision.
    /// This performs a synchronous durable write; async callers run it on a
    /// blocking thread.
    pub fn set_switching(&self, switching: Option<PendingSwitch>) -> Result<(), TerminalError> {
        self.save(|next| next.switching = switching)
    }

    /// Confirm the monitored Project only after its DB has committed the apply.
    /// This performs a synchronous durable write; async callers run it on a
    /// blocking thread.
    pub fn set_monitored(&self, monitored: Option<MonitoredProject>) -> Result<(), TerminalError> {
        self.save(|next| {
            next.monitored = monitored;
            next.switching = None;
        })
    }

    fn save(&self, update: impl FnOnce(&mut Settings)) -> Result<(), TerminalError> {
        let mut settings = self.settings.lock().map_err(|_| TerminalError::Corrupt)?;
        let mut next = settings.clone();
        update(&mut next);
        // Initial creation is allowed before any session has been reserved.
        let bytes = serde_json::to_vec(&next).map_err(|_| TerminalError::Save)?;
        durable::replace(&self.data_dir.join(SETTINGS_FILE), &bytes)
            .map_err(|_| TerminalError::Save)?;
        *settings = next;
        Ok(())
    }
}

async fn max_db_generation(data_dir: &Path) -> Result<Option<u64>, TerminalError> {
    let dir = data_dir.join("alarms");
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(TerminalError::Unreadable),
    };
    let mut max = None;
    for entry in entries {
        let entry = entry.map_err(|_| TerminalError::Unreadable)?;
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "db") {
            let options = SqliteConnectOptions::new().filename(&path).read_only(true);
            let mut connection = SqliteConnection::connect_with(&options)
                .await
                .map_err(|_| TerminalError::Corrupt)?;
            let version: i64 = sqlx::query_scalar("PRAGMA user_version")
                .fetch_one(&mut connection)
                .await
                .map_err(|_| TerminalError::Corrupt)?;
            if version == 0 {
                let tables: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
                    .fetch_one(&mut connection)
                    .await
                    .map_err(|_| TerminalError::Corrupt)?;
                if tables == 0 {
                    connection
                        .close()
                        .await
                        .map_err(|_| TerminalError::Unreadable)?;
                    continue;
                }
            }
            if version != 1 {
                return Err(TerminalError::Corrupt);
            }
            let row = sqlx::query("SELECT MAX(generation) AS max_generation FROM session")
                .fetch_one(&mut connection)
                .await
                .map_err(|_| TerminalError::Corrupt)?;
            let generation: Option<i64> = row
                .try_get("max_generation")
                .map_err(|_| TerminalError::Corrupt)?;
            if let Some(generation) = generation {
                let generation = u64::try_from(generation)
                    .ok()
                    .filter(|generation| *generation > 0)
                    .ok_or(TerminalError::Corrupt)?;
                max = Some(max.map_or(generation, |current: u64| current.max(generation)));
            }
            connection
                .close()
                .await
                .map_err(|_| TerminalError::Unreadable)?;
        }
    }
    Ok(max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alarm_db::AlarmDb;
    use scada_alarm::Session;

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("alarm-terminal-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn generations_are_saved_before_their_sessions_and_never_reused() {
        let dir = temp_dir();
        let terminal = std::sync::Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        assert_eq!(terminal.reserve_generation().unwrap(), 1);
        let db = AlarmDb::open(terminal.clone(), &uuid::Uuid::new_v4().to_string())
            .await
            .unwrap();
        db.start_session(
            &Session {
                id: "first".into(),
                generation: 1,
            },
            100,
            &[],
            &[],
        )
        .await
        .unwrap();
        db.close().await;
        assert_eq!(terminal.reserve_generation().unwrap(), 2); // DB write failed: gap is spent.
        drop(terminal);
        let reopened = AlarmTerminal::open(&dir).await.unwrap();
        assert_eq!(reopened.reserve_generation().unwrap(), 3);
        drop(reopened);
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn lost_or_corrupt_settings_stop_monitoring() {
        let dir = temp_dir();
        let terminal = std::sync::Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        let generation = terminal.reserve_generation().unwrap();
        let db = AlarmDb::open(terminal.clone(), &uuid::Uuid::new_v4().to_string())
            .await
            .unwrap();
        db.start_session(
            &Session {
                id: "first".into(),
                generation,
            },
            100,
            &[],
            &[],
        )
        .await
        .unwrap();
        db.close().await;
        drop(terminal);
        fs::remove_file(dir.join(SETTINGS_FILE)).unwrap();
        assert!(matches!(
            AlarmTerminal::open(&dir).await,
            Err(TerminalError::Lost)
        ));
        fs::write(dir.join(SETTINGS_FILE), b"garbled").unwrap();
        assert!(matches!(
            AlarmTerminal::open(&dir).await,
            Err(TerminalError::Corrupt)
        ));
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn an_applied_db_without_a_session_does_not_claim_generation_loss() {
        let dir = temp_dir();
        let terminal = std::sync::Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        terminal.set_monitored(None).unwrap(); // an initial settings file
        drop(terminal);
        let terminal = std::sync::Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        let db = AlarmDb::open(terminal.clone(), &uuid::Uuid::new_v4().to_string())
            .await
            .unwrap();
        db.close().await;
        drop(terminal);
        let terminal = std::sync::Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        drop(terminal);
        fs::remove_file(dir.join(SETTINGS_FILE)).unwrap();
        let terminal = std::sync::Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        drop(terminal);
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn an_empty_db_created_before_schema_commit_does_not_block_first_start() {
        let dir = temp_dir();
        let id = uuid::Uuid::new_v4().to_string();
        fs::create_dir_all(dir.join("alarms")).unwrap();
        fs::File::create(dir.join("alarms").join(format!("{id}.db"))).unwrap();
        let terminal = std::sync::Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        drop(terminal);
        let terminal = std::sync::Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        let db = AlarmDb::open(terminal.clone(), &id).await.unwrap();
        db.close().await;
        drop(terminal);
        let terminal = std::sync::Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        drop(terminal);
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_restored_older_settings_file_cannot_reuse_a_db_generation() {
        let dir = temp_dir();
        let terminal = std::sync::Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        let first = terminal.reserve_generation().unwrap();
        let backup = fs::read(dir.join(SETTINGS_FILE)).unwrap();
        let db = AlarmDb::open(terminal.clone(), &uuid::Uuid::new_v4().to_string())
            .await
            .unwrap();
        db.start_session(
            &Session {
                id: "first".into(),
                generation: first,
            },
            100,
            &[],
            &[],
        )
        .await
        .unwrap();
        let second = terminal.reserve_generation().unwrap();
        db.start_session(
            &Session {
                id: "second".into(),
                generation: second,
            },
            200,
            &[],
            &[],
        )
        .await
        .unwrap();
        db.close().await;
        drop(terminal);
        fs::write(dir.join(SETTINGS_FILE), backup).unwrap();
        assert!(matches!(
            AlarmTerminal::open(&dir).await,
            Err(TerminalError::Lost)
        ));
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn switching_and_monitor_are_durable_under_one_terminal_lock() {
        let dir = temp_dir();
        let terminal = std::sync::Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        let monitored = MonitoredProject {
            project_id: uuid::Uuid::new_v4().to_string(),
            path: dir.join("b.json"),
        };
        terminal
            .set_switching(Some(PendingSwitch {
                target: monitored.clone(),
                file_hash: "sha256".into(),
            }))
            .unwrap();
        assert!(matches!(
            AlarmTerminal::open(&dir).await,
            Err(TerminalError::InUse)
        ));
        drop(terminal);
        let terminal = std::sync::Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        assert_eq!(terminal.switching().unwrap().unwrap().target, monitored);
        terminal.set_monitored(Some(monitored.clone())).unwrap();
        drop(terminal);
        let terminal = std::sync::Arc::new(AlarmTerminal::open(&dir).await.unwrap());
        assert_eq!(terminal.monitored().unwrap(), Some(monitored.clone()));
        assert!(terminal.switching().unwrap().is_none());
        drop(terminal);
        fs::remove_dir_all(dir).unwrap();
    }
}
