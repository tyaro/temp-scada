use std::collections::BTreeMap;
use std::sync::Mutex;

use super::*;
use crate::operation_db::{KeyRef, OperationDb, WriteState};

const HUB: &str = "http://127.0.0.1:8722";
const SECRET: &str = "operation-write-test-only-key";

#[derive(Default)]
struct MemoryStore {
    entries: Mutex<BTreeMap<String, String>>,
    fail: Mutex<bool>,
}

impl MemoryStore {
    fn fail(&self, fail: bool) {
        *self.fail.lock().unwrap() = fail;
    }

    /// The only secret kept, if exactly one entry is there.
    fn only(&self) -> Option<String> {
        let entries = self.entries.lock().unwrap();
        (entries.len() == 1).then(|| entries.values().next().unwrap().clone())
    }

    fn check(&self) -> Result<(), KeyError> {
        if *self.fail.lock().unwrap() {
            Err(KeyError::KeyStore)
        } else {
            Ok(())
        }
    }
}

impl WriteKeyStore for MemoryStore {
    fn get(&self, id: &str) -> Result<Option<String>, KeyError> {
        self.check()?;
        Ok(self.entries.lock().unwrap().get(id).cloned())
    }

    fn set(&self, id: &str, secret: &str) -> Result<(), KeyError> {
        self.check()?;
        self.entries
            .lock()
            .unwrap()
            .insert(id.into(), secret.into());
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<(), KeyError> {
        self.check()?;
        self.entries.lock().unwrap().remove(id);
        Ok(())
    }
}

async fn log() -> (OperationLog, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("operation-key-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("operations.db");
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    (OperationLog::new(db), file)
}

#[tokio::test]
async fn a_registered_key_is_paired_with_the_read_endpoint_and_survives_a_restart() {
    let store = MemoryStore::default();
    let (log, file) = log().await;
    let key = register(&store, &log, SECRET, Some(HUB), 1_000)
        .await
        .unwrap();
    assert_eq!(key.endpoint, HUB);
    assert_eq!(store.only().as_deref(), Some(SECRET));
    assert_eq!(log.write_status().state, WriteState::Ready);
    log.close().await;

    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = OperationLog::new(db);
    let loaded = load(&store, &log).unwrap().unwrap();
    assert_eq!(loaded.endpoint, HUB);
    log.close().await;
}

#[tokio::test]
async fn a_key_is_checked_before_anything_is_kept() {
    let store = MemoryStore::default();
    let (log, _) = log().await;
    for (secret, endpoint, code) in [
        (SECRET, None, "no_hub"),
        ("", Some(HUB), "invalid_secret"),
        ("with space", Some(HUB), "invalid_secret"),
        ("キー", Some(HUB), "invalid_secret"),
        (SECRET, Some("https://127.0.0.1:8722"), "invalid_endpoint"),
        (SECRET, Some("not a url"), "invalid_endpoint"),
    ] {
        let error = register(&store, &log, secret, endpoint, 1_000)
            .await
            .err()
            .unwrap();
        assert_eq!(error.as_str(), code, "{secret:?} {endpoint:?}");
        assert!(store.entries.lock().unwrap().is_empty());
        assert_eq!(log.key_endpoint(), None);
    }
    log.close().await;
}

#[tokio::test]
async fn a_keyring_that_refuses_leaves_no_key() {
    let store = MemoryStore::default();
    let (log, _) = log().await;
    store.fail(true);
    let error = register(&store, &log, SECRET, Some(HUB), 1_000)
        .await
        .err()
        .unwrap();
    assert_eq!(error.as_str(), "key_store");
    assert_eq!(log.key_endpoint(), None);
    store.fail(false);
    assert!(load(&store, &log).unwrap().is_none());
    log.close().await;
}

#[tokio::test]
async fn a_registration_clears_a_stopped_or_invalid_terminal() {
    let store = MemoryStore::default();
    let (log, _) = log().await;
    register(&store, &log, SECRET, Some(HUB), 1_000)
        .await
        .unwrap();
    let id = log
        .begin(&request(), std::time::Duration::ZERO)
        .await
        .unwrap();
    log.complete(
        &id,
        crate::operation_db::Finish {
            outcome: crate::operation_db::Outcome::NotSent,
            reason: Some("unauthorized".into()),
            audit_id: None,
            finished_at_ms: 2_000,
        },
    )
    .await
    .unwrap();
    assert_eq!(log.write_status().state, WriteState::KeyInvalid);
    register(&store, &log, "operation-write-second-key", Some(HUB), 3_000)
        .await
        .unwrap();
    assert_eq!(log.write_status().state, WriteState::Ready);
    log.close().await;
}

#[tokio::test]
async fn a_deleted_key_is_unpaired_first() {
    let store = MemoryStore::default();
    let (log, _) = log().await;
    register(&store, &log, SECRET, Some(HUB), 1_000)
        .await
        .unwrap();
    // The keyring refuses the deletion: the record is already unpaired, so
    // no write finds a key.
    store.fail(true);
    assert_eq!(
        delete(&store, &log).await.err().unwrap().as_str(),
        "key_store"
    );
    store.fail(false);
    assert_eq!(log.key_endpoint(), None);
    assert!(load(&store, &log).unwrap().is_none());
    // The entry the keyring kept is never read again; deleting again is
    // a no-op (the record has no key).
    delete(&store, &log).await.unwrap();
    assert_eq!(store.only().as_deref(), Some(SECRET));
    // A registered key is removed whole.
    register(&store, &log, SECRET, Some(HUB), 2_000)
        .await
        .unwrap();
    delete(&store, &log).await.unwrap();
    assert_eq!(store.only().as_deref(), Some(SECRET));
    assert!(load(&store, &log).unwrap().is_none());
    log.close().await;
}

#[tokio::test]
async fn an_endpoint_without_a_secret_is_no_key() {
    let store = MemoryStore::default();
    let (log, _) = log().await;
    log.key_registered(
        1_000,
        &KeyRef {
            endpoint: HUB.into(),
            id: "missing".into(),
        },
    )
    .await
    .unwrap();
    assert!(load(&store, &log).unwrap().is_none());
    log.close().await;
}

fn request() -> crate::operation_db::RequestRecord {
    crate::operation_db::RequestRecord {
        requested_at_ms: 1_000,
        user: "未ログイン".into(),
        phase: "initializing".into(),
        hub_endpoint: Some(HUB.into()),
        project_id: "p".into(),
        project_digest: "a".repeat(64),
        screen_id: "main".into(),
        object_id: "pump1".into(),
        equipment_id: "eq-1".into(),
        equipment_code: None,
        slot: "command".into(),
        tag: Some("Line1.P101.Command".into()),
        value: serde_json::json!(true),
    }
}

#[tokio::test]
async fn a_replacement_that_fails_keeps_the_previous_key_whole() {
    const OTHER_HUB: &str = "http://127.0.0.1:9999";
    const OTHER: &str = "operation-write-other-hub-key";
    let store = MemoryStore::default();
    let (log, file) = log().await;
    register(&store, &log, SECRET, Some(HUB), 1_000)
        .await
        .unwrap();
    let first = log.key().unwrap();
    // The record refuses the switch after the keyring took the new secret.
    log.db()
        .execute_for_test(
            "CREATE TRIGGER fail_key BEFORE UPDATE ON terminal_write BEGIN SELECT RAISE(ABORT, 'disk full'); END",
        )
        .await;
    let error = register(&store, &log, OTHER, Some(OTHER_HUB), 2_000)
        .await
        .err()
        .unwrap();
    assert_eq!(error.as_str(), "record_failed");
    // The new entry is dropped; the previous key is as it was.
    assert_eq!(store.only().as_deref(), Some(SECRET));
    assert_eq!(log.key(), Some(first.clone()));
    log.close().await;

    // After a restart too: the previous endpoint with its own secret, never
    // the previous endpoint with the new secret.
    let (db, _) = OperationDb::open(&file, 0).await.unwrap();
    let log = OperationLog::new(db);
    assert_eq!(log.key(), Some(first.clone()));
    assert_eq!(store.get(&first.id).unwrap().as_deref(), Some(SECRET));
    assert_eq!(load(&store, &log).unwrap().unwrap().endpoint, HUB);
    log.close().await;
}

#[tokio::test]
async fn an_exit_before_the_switch_never_pairs_the_new_secret() {
    // The process ends after the keyring took the new secret, before the
    // record switched: the new entry is left behind but never read.
    let store = MemoryStore::default();
    let (log, _) = log().await;
    register(&store, &log, SECRET, Some(HUB), 1_000)
        .await
        .unwrap();
    store.set("left-behind", "operation-write-new-key").unwrap();
    let key = log.key().unwrap();
    assert_ne!(key.id, "left-behind");
    assert_eq!(store.get(&key.id).unwrap().as_deref(), Some(SECRET));
    log.close().await;
}

#[tokio::test]
async fn a_replacement_removes_the_previous_entry() {
    let store = MemoryStore::default();
    let (log, _) = log().await;
    register(&store, &log, SECRET, Some(HUB), 1_000)
        .await
        .unwrap();
    register(&store, &log, "operation-write-second-key", Some(HUB), 2_000)
        .await
        .unwrap();
    assert_eq!(store.only().as_deref(), Some("operation-write-second-key"));
    log.close().await;
}
