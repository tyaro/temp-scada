//! Native settings and protected read credential for the embedded SCADA host.
//! Neither the Project nor the UI receives an API key.
pub mod auth;
pub mod auth_phase;
pub mod desktop_auth;
pub mod desktop_recording;
mod durable;
pub mod recording_epoch;
pub mod recording_gate;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use banto_hub_bootstrap::{BootstrapState, Error, ErrorKind, HubRecord, KeyStore};
pub use banto_hub_bootstrap::{Bootstrapper, HubStatus};

pub const DEFAULT_HUB_ENDPOINT: &str = "http://127.0.0.1:8722";

/// The app data dir of the embedded host: the Hub read record, the
/// installation ID, and the auth phase, auth DB and recording epoch
/// (host-gate design §2, §6, §7).
pub fn local_data_dir() -> Result<PathBuf, &'static str> {
    Ok(
        PathBuf::from(std::env::var("LOCALAPPDATA").map_err(|_| "no app data directory")?)
            .join("temp-scada"),
    )
}

pub fn local_bootstrap() -> Result<Bootstrapper, &'static str> {
    let root = local_data_dir()?;
    let id = installation_id(&root)?;
    Ok(Bootstrapper::new(
        "temp-scada",
        id,
        Arc::new(WindowsKeys),
        Arc::new(FileState(root.join("hub-read.json"))),
    ))
}

fn installation_id(root: &Path) -> Result<String, &'static str> {
    let path = root.join("installation-id");
    match fs::read_to_string(&path) {
        Ok(id) => {
            return uuid::Uuid::parse_str(id.trim())
                .map(|id| id.to_string())
                .map_err(|_| "invalid installation id");
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("cannot read installation id"),
    }
    fs::create_dir_all(root).map_err(|_| "cannot create settings directory")?;
    let id = uuid::Uuid::new_v4().to_string();
    fs::write(&path, &id).map_err(|_| "cannot save installation id")?;
    Ok(id)
}

struct FileState(PathBuf);

impl BootstrapState for FileState {
    fn load(&self) -> banto_hub_bootstrap::Result<Option<HubRecord>> {
        match fs::read(&self.0) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| Error::new(ErrorKind::State)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(Error::new(ErrorKind::State)),
        }
    }

    fn save(&self, record: &HubRecord) -> banto_hub_bootstrap::Result<()> {
        let bytes = serde_json::to_vec(record).map_err(|_| Error::new(ErrorKind::State))?;
        let parent = self
            .0
            .parent()
            .ok_or_else(|| Error::new(ErrorKind::State))?;
        fs::create_dir_all(parent).map_err(|_| Error::new(ErrorKind::State))?;
        fs::write(&self.0, bytes).map_err(|_| Error::new(ErrorKind::State))
    }

    fn clear(&self) -> banto_hub_bootstrap::Result<()> {
        match fs::remove_file(&self.0) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(Error::new(ErrorKind::State)),
        }
    }
}

struct WindowsKeys;

#[cfg(windows)]
impl KeyStore for WindowsKeys {
    fn get(&self, account: &str) -> banto_hub_bootstrap::Result<Option<String>> {
        let entry = keyring::Entry::new("temp-scada-hub-read", account)
            .map_err(|_| Error::new(ErrorKind::KeyStore))?;
        match entry.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(Error::new(ErrorKind::KeyStore)),
        }
    }

    fn set(&self, account: &str, secret: &str) -> banto_hub_bootstrap::Result<()> {
        keyring::Entry::new("temp-scada-hub-read", account)
            .and_then(|entry| entry.set_password(secret))
            .map_err(|_| Error::new(ErrorKind::KeyStore))
    }

    fn delete(&self, account: &str) -> banto_hub_bootstrap::Result<()> {
        let entry = keyring::Entry::new("temp-scada-hub-read", account)
            .map_err(|_| Error::new(ErrorKind::KeyStore))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(Error::new(ErrorKind::KeyStore)),
        }
    }
}

#[cfg(not(windows))]
impl KeyStore for WindowsKeys {
    fn get(&self, _: &str) -> banto_hub_bootstrap::Result<Option<String>> {
        Err(Error::new(ErrorKind::KeyStore))
    }
    fn set(&self, _: &str, _: &str) -> banto_hub_bootstrap::Result<()> {
        Err(Error::new(ErrorKind::KeyStore))
    }
    fn delete(&self, _: &str) -> banto_hub_bootstrap::Result<()> {
        Err(Error::new(ErrorKind::KeyStore))
    }
}
