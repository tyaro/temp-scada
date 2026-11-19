//! The write key of the terminal (operation stage-3 design §7; O2c-3a).
//!
//! - The secret is kept in the OS keyring under its own service
//!   ([`WRITE_KEY_SERVICE`], apart from the read key), one per installation.
//!   It never goes back to the webview.
//! - The Hub endpoint the key was registered for is kept with the write
//!   state in `operations.db` (`OperationLog::key_endpoint`). A write to
//!   another endpoint than the read connection's is `hub_mismatch`: a key
//!   is never used against a Hub it was not registered for.
//! - Registering writes the keyring first, then the record (endpoint and
//!   `ready`); deleting drops the endpoint from the record first, then the
//!   secret. Either half failing leaves the terminal without a usable key,
//!   never with a key paired to the wrong Hub.
//! - The write key has the write scope only, so it cannot be checked by
//!   reading the Hub; the first write checks it (a 401 is `key_invalid`).
use std::sync::Arc;

use banto_tagclient::{Endpoint, RestClient, SecretApiKey};

use crate::operation_db::{OperationDbError, OperationLog};
use crate::operation_write::WRITE_TIMEOUT;

/// The keyring service of the write key (§7).
pub const WRITE_KEY_SERVICE: &str = "temp-scada-hub-write";

/// Where the secret is kept. The product's is the Windows credential store;
/// tests use memory.
pub trait WriteKeyStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, KeyError>;
    fn set(&self, secret: &str) -> Result<(), KeyError>;
    /// Removing a missing secret is not an error.
    fn delete(&self) -> Result<(), KeyError>;
}

/// The registered write key: the endpoint it was registered for and the
/// client that writes with it (bounded by [`WRITE_TIMEOUT`]).
#[derive(Clone)]
pub struct WriteKey {
    pub endpoint: String,
    pub client: Arc<RestClient>,
}

/// Why the key could not be registered, deleted or read.
#[derive(Debug)]
pub enum KeyError {
    /// No Hub is connected for reading: there is no endpoint to pair with.
    NoHub,
    /// The secret is empty or not a header-safe ASCII value.
    InvalidSecret,
    /// The endpoint cannot be written to (only plain `http` Hubs are
    /// supported: the product's read connection has no pinned TLS either).
    InvalidEndpoint,
    /// The keyring refused.
    KeyStore,
    /// The record could not be written or read.
    Record(OperationDbError),
}

impl KeyError {
    /// The code the screen maps to its sentence.
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::NoHub => "no_hub",
            Self::InvalidSecret => "invalid_secret",
            Self::InvalidEndpoint => "invalid_endpoint",
            Self::KeyStore => "key_store",
            Self::Record(_) => "record_failed",
        }
    }
}

impl From<OperationDbError> for KeyError {
    fn from(error: OperationDbError) -> Self {
        Self::Record(error)
    }
}

/// The write client for `endpoint` with `secret`.
pub fn write_client(endpoint: &str, secret: &str) -> Result<RestClient, KeyError> {
    let parsed = Endpoint::new(endpoint).map_err(|_| KeyError::InvalidEndpoint)?;
    if !endpoint.starts_with("http://") {
        return Err(KeyError::InvalidEndpoint);
    }
    let secret = SecretApiKey::new(secret.to_owned()).map_err(|_| KeyError::InvalidSecret)?;
    RestClient::with_request_timeout(parsed, secret, WRITE_TIMEOUT)
        .map_err(|_| KeyError::InvalidEndpoint)
}

/// Register `secret` as the write key for `endpoint` (the read
/// connection's, `None` when there is none): checked, put in the keyring,
/// then paired in the record, which also makes the state `ready` (§7). The
/// caller checks the permission first.
pub async fn register(
    store: &dyn WriteKeyStore,
    log: &OperationLog,
    secret: &str,
    endpoint: Option<&str>,
    now_ms: i64,
) -> Result<WriteKey, KeyError> {
    let endpoint = endpoint.ok_or(KeyError::NoHub)?;
    let client = write_client(endpoint, secret)?;
    store.set(secret)?;
    log.key_registered(now_ms, endpoint).await?;
    Ok(WriteKey {
        endpoint: endpoint.into(),
        client: Arc::new(client),
    })
}

/// Delete the write key: unpaired in the record first (so no write finds
/// it), then removed from the keyring. The caller checks the permission.
pub async fn delete(store: &dyn WriteKeyStore, log: &OperationLog) -> Result<(), KeyError> {
    log.key_deleted().await?;
    store.delete()
}

/// The registered key, or `None` when the record has no endpoint or the
/// keyring no secret (one without the other is no key).
pub fn load(store: &dyn WriteKeyStore, log: &OperationLog) -> Result<Option<WriteKey>, KeyError> {
    let Some(endpoint) = log.key_endpoint() else {
        return Ok(None);
    };
    let Some(secret) = store.get()? else {
        return Ok(None);
    };
    let client = write_client(&endpoint, &secret)?;
    Ok(Some(WriteKey {
        endpoint,
        client: Arc::new(client),
    }))
}

#[cfg(test)]
mod tests;
