use std::path::PathBuf;

use super::*;

/// A fresh app data dir under the OS temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("scada-host-epoch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn file(&self) -> PathBuf {
        self.0.join(RECORDING_EPOCH_FILE)
    }

    fn saved(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.file()).unwrap()).unwrap()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Replays fixed 16-byte draws in order.
fn scripted(draws: Vec<[u8; 16]>) -> impl FnMut(&mut [u8]) -> Result<(), GenerationError> {
    let mut draws = draws.into_iter();
    move |bytes| {
        bytes.copy_from_slice(&draws.next().expect("unexpected draw"));
        Ok(())
    }
}

fn hex(byte: u8) -> String {
    format!("{byte:02x}").repeat(16)
}

#[test]
fn draws_two_fresh_lowercase_hex_ids_and_saves_them() {
    let dir = TempDir::new();
    let generation = next_generation(&dir.0).unwrap();
    assert!(is_id(generation.owner_ref()) && is_id(generation.owner_epoch()));
    assert_ne!(generation.owner_ref(), generation.owner_epoch());
    assert_eq!(
        dir.saved(),
        json!({"version":1, "ownerRef":generation.owner_ref(), "ownerEpoch":generation.owner_epoch()})
    );
    assert!(!temp_path(&dir.file()).exists());

    let next = next_generation(&dir.0).unwrap();
    assert_ne!(next.owner_ref(), generation.owner_ref());
    assert_ne!(next.owner_epoch(), generation.owner_epoch());
    assert_eq!(dir.saved()["ownerEpoch"], json!(next.owner_epoch()));
}

#[test]
fn scope_carries_the_generation_and_context() {
    let dir = TempDir::new();
    let mut random = scripted(vec![[1; 16], [2; 16]]);
    let generation = next_generation_with(&dir.0, &mut random).unwrap();
    assert_eq!(
        generation.scope(json!({"k":1})),
        json!({"ownerRef":hex(1), "ownerEpoch":hex(2), "context":{"k":1}})
    );
}

#[test]
fn redraws_when_a_value_repeats_the_previous_pair_or_its_sibling() {
    let dir = TempDir::new();
    next_generation_with(&dir.0, &mut scripted(vec![[1; 16], [2; 16]])).unwrap();
    // ref repeats the previous epoch; then ref == epoch; then epoch repeats
    // the previous ref; then a fresh pair.
    let mut random = scripted(vec![
        [2; 16], [3; 16], //
        [4; 16], [4; 16], //
        [5; 16], [1; 16], //
        [6; 16], [7; 16],
    ]);
    let generation = next_generation_with(&dir.0, &mut random).unwrap();
    assert_eq!(generation.owner_ref(), hex(6));
    assert_eq!(generation.owner_epoch(), hex(7));
    assert_eq!(dir.saved()["ownerRef"], json!(hex(6)));
}

#[test]
fn a_source_that_keeps_repeating_fails_without_saving() {
    let dir = TempDir::new();
    next_generation_with(&dir.0, &mut scripted(vec![[1; 16], [2; 16]])).unwrap();
    let before = std::fs::read(dir.file()).unwrap();
    let mut random = |bytes: &mut [u8]| {
        bytes.fill(1);
        Ok(())
    };
    assert_eq!(
        next_generation_with(&dir.0, &mut random),
        Err(GenerationError::Collision)
    );
    assert_eq!(std::fs::read(dir.file()).unwrap(), before);
}

#[test]
fn a_random_source_failure_saves_nothing() {
    let dir = TempDir::new();
    let mut random = |_: &mut [u8]| Err(GenerationError::Random);
    assert_eq!(
        next_generation_with(&dir.0, &mut random),
        Err(GenerationError::Random)
    );
    assert!(!dir.file().exists());
}

#[test]
fn a_corrupt_previous_pair_is_refused_and_kept() {
    let cases = [
        "not json".to_owned(),
        json!([]).to_string(),
        json!({"version":2, "ownerRef":hex(1), "ownerEpoch":hex(2)}).to_string(),
        json!({"version":1, "ownerRef":hex(1)}).to_string(),
        json!({"version":1, "ownerRef":hex(0xab).to_uppercase(), "ownerEpoch":hex(2)}).to_string(),
        json!({"version":1, "ownerRef":&hex(1)[1..], "ownerEpoch":hex(2)}).to_string(),
        json!({"version":1, "ownerRef":hex(1), "ownerEpoch":hex(2), "x":1}).to_string(),
    ];
    for body in cases {
        let dir = TempDir::new();
        std::fs::write(dir.file(), &body).unwrap();
        assert_eq!(
            next_generation(&dir.0),
            Err(GenerationError::Corrupt),
            "{body}"
        );
        assert_eq!(std::fs::read_to_string(dir.file()).unwrap(), body);
    }
}

#[test]
fn an_unreadable_previous_pair_is_refused() {
    let dir = TempDir::new();
    std::fs::create_dir(dir.file()).unwrap();
    assert_eq!(next_generation(&dir.0), Err(GenerationError::Unreadable));
}

#[test]
fn a_failed_save_is_reported() {
    let dir = TempDir::new();
    // A directory in the temp file's place makes the write fail.
    std::fs::create_dir(temp_path(&dir.file())).unwrap();
    assert_eq!(next_generation(&dir.0), Err(GenerationError::Save));
    assert!(!dir.file().exists());
}

#[test]
fn the_data_dir_is_created_when_missing() {
    let dir = TempDir::new();
    let nested = dir.0.join("a").join("b");
    next_generation(&nested).unwrap();
    assert!(nested.join(RECORDING_EPOCH_FILE).is_file());
}
