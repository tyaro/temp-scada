use std::sync::Mutex;

use super::*;
use crate::operation_db::{OperationDb, WriteState};

const HUB: &str = "http://127.0.0.1:8722";
const SECRET: &str = "operation-write-test-only-key";

#[derive(Default)]
struct MemoryStore {
    secret: Mutex<Option<String>>,
    fail: Mutex<bool>,
}

impl MemoryStore {
    fn fail(&self, fail: bool) {
        *self.fail.lock().unwrap() = fail;
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
    fn get(&self) -> Result<Option<String>, KeyError> {
        self.check()?;
        Ok(self.secret.lock().unwrap().clone())
    }

    fn set(&self, secret: &str) -> Result<(), KeyError> {
        self.check()?;
        *self.secret.lock().unwrap() = Some(secret.into());
        Ok(())
    }

    fn delete(&self) -> Result<(), KeyError> {
        self.check()?;
        *self.secret.lock().unwrap() = None;
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
    assert_eq!(store.secret.lock().unwrap().as_deref(), Some(SECRET));
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
        assert!(store.secret.lock().unwrap().is_none());
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
    delete(&store, &log).await.unwrap();
    assert!(store.secret.lock().unwrap().is_none());
    log.close().await;
}

#[tokio::test]
async fn an_endpoint_without_a_secret_is_no_key() {
    let store = MemoryStore::default();
    let (log, _) = log().await;
    log.key_registered(1_000, HUB).await.unwrap();
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
