//! The write key of the terminal (operation stage-3 design §7; O2c-3a).
//!
//! - The secret is kept in the OS keyring under its own service
//!   ([`WRITE_KEY_SERVICE`], apart from the read key). Each registration
//!   gets a new entry id, so a new secret never overwrites the entry the
//!   record points at. It never goes back to the webview.
//! - The record (`operations.db`, with the write state) keeps the Hub
//!   endpoint the key was registered for and its entry id
//!   (`OperationLog::key`), changed together in one statement. A write to
//!   another endpoint than the read connection's is `hub_mismatch`: a key
//!   is never used against a Hub it was not registered for.
//! - Registering puts the secret under a new entry, then switches the
//!   record to it, then removes the previous entry. A failure or an exit
//!   before the switch leaves the previous key as it was (its endpoint with
//!   its own secret); the new entry is removed or simply never read.
//!   Deleting drops the key from the record first, then its entry.
//! - The write key has the write scope only, so it cannot be checked by
//!   reading the Hub; the first write checks it (a 401 is `key_invalid`).
use std::sync::Arc;

use banto_tagclient::{Endpoint, RestClient, SecretApiKey};

use crate::operation_db::{KeyRef, OperationDbError, OperationLog};
use crate::operation_write::WRITE_TIMEOUT;

/// The keyring service of the write key (§7).
pub const WRITE_KEY_SERVICE: &str = "temp-scada-hub-write";

/// Where the secrets are kept, one entry per registration id. The
/// product's is the Windows credential store; tests use memory.
pub trait WriteKeyStore: Send + Sync {
    fn get(&self, id: &str) -> Result<Option<String>, KeyError>;
    fn set(&self, id: &str, secret: &str) -> Result<(), KeyError>;
    /// Removing a missing entry is not an error.
    fn delete(&self, id: &str) -> Result<(), KeyError>;
}

/// The registered write key: the endpoint it was registered for and the
/// client that writes with it (bounded by [`WRITE_TIMEOUT`]).
#[derive(Clone)]
pub struct WriteKey {
    pub endpoint: String,
    /// The keyring entry id (`KeyRef::id`): the generation of the key, so
    /// an outcome of a key registered again meanwhile is told apart (§7).
    pub id: String,
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
/// connection's, `None` when there is none): checked, put in the keyring
/// under a new entry, then switched to in the record, which also makes the
/// state `ready` (§7); the previous entry is removed last. The caller
/// checks the permission first.
pub async fn register(
    store: &dyn WriteKeyStore,
    log: &OperationLog,
    secret: &str,
    endpoint: Option<&str>,
    now_ms: i64,
) -> Result<WriteKey, KeyError> {
    let endpoint = endpoint.ok_or(KeyError::NoHub)?;
    let client = write_client(endpoint, secret)?;
    let key = KeyRef {
        endpoint: endpoint.into(),
        id: uuid::Uuid::new_v4().to_string(),
    };
    store.set(&key.id, secret)?;
    let previous = log.key();
    if let Err(error) = log.key_registered(now_ms, &key).await {
        // The record still points at the previous key: drop the new entry
        // (left behind, it is never read).
        let _ = store.delete(&key.id);
        return Err(error.into());
    }
    if let Some(previous) = previous.filter(|previous| previous.id != key.id) {
        if store.delete(&previous.id).is_err() {
            eprintln!("operation key: the previous entry could not be removed");
        }
    }
    Ok(WriteKey {
        endpoint: key.endpoint,
        id: key.id,
        client: Arc::new(client),
    })
}

/// Delete the write key: dropped from the record first (so no write finds
/// it), then its entry removed from the keyring. The caller checks the
/// permission.
pub async fn delete(store: &dyn WriteKeyStore, log: &OperationLog) -> Result<(), KeyError> {
    match log.key_deleted().await? {
        Some(key) => store.delete(&key.id),
        None => Ok(()),
    }
}

/// The registered key, or `None` when the record has none or its entry has
/// no secret (one without the other is no key).
pub fn load(store: &dyn WriteKeyStore, log: &OperationLog) -> Result<Option<WriteKey>, KeyError> {
    let Some(key) = log.key() else {
        return Ok(None);
    };
    let Some(secret) = store.get(&key.id)? else {
        return Ok(None);
    };
    let client = write_client(&key.endpoint, &secret)?;
    Ok(Some(WriteKey {
        endpoint: key.endpoint,
        id: key.id,
        client: Arc::new(client),
    }))
}

#[cfg(test)]
mod tests;
