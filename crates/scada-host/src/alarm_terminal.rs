//! The alarm Engine's terminal-wide lock and durable session generation.
//! A generation is spent before a session can be inserted in a Project DB.
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

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
    settings: Settings,
}

impl AlarmTerminal {
    pub fn open(data_dir: &Path) -> Result<Self, TerminalError> {
        let lock =
            durable::open_lock_file(data_dir, LOCK_FILE).map_err(|_| TerminalError::InUse)?;
        lock.try_lock().map_err(|_| TerminalError::InUse)?;
        let path = data_dir.join(SETTINGS_FILE);
        let settings = match durable::read_optional(&path).map_err(|_| TerminalError::Unreadable)? {
            Some(bytes) => {
                let settings: Settings =
                    serde_json::from_slice(&bytes).map_err(|_| TerminalError::Corrupt)?;
                if settings.version != VERSION {
                    return Err(TerminalError::Corrupt);
                }
                if settings.last_generation == 0 && has_alarm_db(data_dir)? {
                    return Err(TerminalError::Lost);
                }
                settings
            }
            None if has_alarm_db(data_dir)? => return Err(TerminalError::Lost),
            None => Settings {
                version: VERSION,
                last_generation: 0,
                monitored: None,
                switching: None,
            },
        };
        Ok(Self {
            data_dir: data_dir.to_owned(),
            _lock: lock,
            settings,
        })
    }

    /// Persist the next number before writing a session to its Project DB.
    /// A DB failure after this call leaves a harmless gap.
    pub fn reserve_generation(&mut self) -> Result<u64, TerminalError> {
        let next = self
            .settings
            .last_generation
            .checked_add(1)
            .ok_or(TerminalError::Exhausted)?;
        let mut settings = self.settings.clone();
        settings.last_generation = next;
        let bytes = serde_json::to_vec(&settings).map_err(|_| TerminalError::Save)?;
        durable::replace(&self.data_dir.join(SETTINGS_FILE), &bytes)
            .map_err(|_| TerminalError::Save)?;
        self.settings = settings;
        Ok(next)
    }

    pub fn monitored(&self) -> Option<&MonitoredProject> {
        self.settings.monitored.as_ref()
    }

    pub fn switching(&self) -> Option<&PendingSwitch> {
        self.settings.switching.as_ref()
    }

    /// The later apply boundary uses this to publish an A→B decision.
    pub fn set_switching(&mut self, switching: Option<PendingSwitch>) -> Result<(), TerminalError> {
        let mut next = self.settings.clone();
        next.switching = switching;
        self.save(next)
    }

    /// Confirm the monitored Project only after its DB has committed the apply.
    pub fn set_monitored(
        &mut self,
        monitored: Option<MonitoredProject>,
    ) -> Result<(), TerminalError> {
        let mut next = self.settings.clone();
        next.monitored = monitored;
        next.switching = None;
        self.save(next)
    }

    fn save(&mut self, next: Settings) -> Result<(), TerminalError> {
        // Initial creation is allowed before any session has been reserved.
        let bytes = serde_json::to_vec(&next).map_err(|_| TerminalError::Save)?;
        durable::replace(&self.data_dir.join(SETTINGS_FILE), &bytes)
            .map_err(|_| TerminalError::Save)?;
        self.settings = next;
        Ok(())
    }
}

fn has_alarm_db(data_dir: &Path) -> Result<bool, TerminalError> {
    let dir = data_dir.join("alarms");
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(TerminalError::Unreadable),
    };
    for entry in entries {
        let entry = entry.map_err(|_| TerminalError::Unreadable)?;
        if entry.path().extension().is_some_and(|ext| ext == "db") {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("alarm-terminal-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn generations_are_saved_before_their_sessions_and_never_reused() {
        let dir = temp_dir();
        let mut terminal = AlarmTerminal::open(&dir).unwrap();
        assert_eq!(terminal.reserve_generation().unwrap(), 1);
        assert_eq!(terminal.reserve_generation().unwrap(), 2); // DB write failed: gap is spent.
        drop(terminal);
        let mut reopened = AlarmTerminal::open(&dir).unwrap();
        assert_eq!(reopened.reserve_generation().unwrap(), 3);
        drop(reopened);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn lost_or_corrupt_settings_stop_monitoring() {
        let dir = temp_dir();
        let mut terminal = AlarmTerminal::open(&dir).unwrap();
        terminal.reserve_generation().unwrap();
        drop(terminal);
        fs::create_dir_all(dir.join("alarms")).unwrap();
        fs::write(dir.join("alarms").join("project.db"), b"db").unwrap();
        fs::remove_file(dir.join(SETTINGS_FILE)).unwrap();
        assert!(matches!(
            AlarmTerminal::open(&dir),
            Err(TerminalError::Lost)
        ));
        fs::write(dir.join(SETTINGS_FILE), b"garbled").unwrap();
        assert!(matches!(
            AlarmTerminal::open(&dir),
            Err(TerminalError::Corrupt)
        ));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn zero_generation_cannot_be_reopened_with_an_alarm_db() {
        let dir = temp_dir();
        let mut terminal = AlarmTerminal::open(&dir).unwrap();
        terminal.set_monitored(None).unwrap(); // an initial settings file
        drop(terminal);
        fs::create_dir_all(dir.join("alarms")).unwrap();
        fs::write(dir.join("alarms").join("project.db"), b"db").unwrap();
        assert!(matches!(
            AlarmTerminal::open(&dir),
            Err(TerminalError::Lost)
        ));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn switching_and_monitor_are_durable_under_one_terminal_lock() {
        let dir = temp_dir();
        let mut terminal = AlarmTerminal::open(&dir).unwrap();
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
            AlarmTerminal::open(&dir),
            Err(TerminalError::InUse)
        ));
        drop(terminal);
        let mut terminal = AlarmTerminal::open(&dir).unwrap();
        assert_eq!(terminal.switching().unwrap().target, monitored);
        terminal.set_monitored(Some(monitored.clone())).unwrap();
        drop(terminal);
        let terminal = AlarmTerminal::open(&dir).unwrap();
        assert_eq!(terminal.monitored(), Some(&monitored));
        assert!(terminal.switching().is_none());
        drop(terminal);
        fs::remove_dir_all(dir).unwrap();
    }
}
