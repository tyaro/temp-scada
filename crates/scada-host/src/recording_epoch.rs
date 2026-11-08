//! Per-generation `ownerRef` / `ownerEpoch` of the recording registry root
//! (host-gate design §7).
//!
//! Every root creation draws both values fresh from the OS CSPRNG (128 bit,
//! 32 lowercase hex digits). The previous pair is kept in
//! `recording-epoch.json`; a draw that repeats any previous value is redrawn,
//! which only guards against a broken random source. The new pair is saved
//! durably before the root exists, and [`create_recording_root`] refuses to
//! build a root when that save fails.
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use scada_runtime::recording_registry::{
    RecordingRegistryOwnerSeed, RecordingRegistryRoot, RecordingSessionIssuer,
    RegistryRootInitFailure,
};
use serde_json::{json, Value};

/// File name of the saved previous generation inside the app data dir.
pub const RECORDING_EPOCH_FILE: &str = "recording-epoch.json";
/// Lock file serializing generation changes in one data dir, across processes.
pub const RECORDING_EPOCH_LOCK_FILE: &str = "recording-epoch.lock";

const FILE_VERSION: u64 = 1;
const ID_BYTES: usize = 16;
/// Draws before the random source is declared broken. Two independent
/// 128-bit draws collide with negligible probability, so one redraw already
/// means the source is failing.
const MAX_DRAWS: usize = 4;

/// One root generation's identifiers. They are not secrets, only fresh.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordingGeneration {
    owner_ref: String,
    owner_epoch: String,
}

impl RecordingGeneration {
    pub fn owner_ref(&self) -> &str {
        &self.owner_ref
    }

    pub fn owner_epoch(&self) -> &str {
        &self.owner_epoch
    }

    /// The wire `Scope` of a root of this generation.
    pub fn scope(&self, context: Value) -> Value {
        json!({"ownerRef": self.owner_ref, "ownerEpoch": self.owner_epoch, "context": context})
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenerationError {
    /// The previous generation exists but cannot be read.
    Unreadable,
    /// The previous generation is not a valid saved pair. It is not
    /// overwritten, since the comparison it guards could not be made.
    Corrupt,
    /// The data dir's generation lock could not be taken.
    Lock,
    /// The OS random source failed.
    Random,
    /// Every draw repeated a previous or sibling value.
    Collision,
    /// The new generation could not be saved durably.
    Save,
}

/// Draws and durably saves the next generation (design §7).
pub fn next_generation(data_dir: &Path) -> Result<RecordingGeneration, GenerationError> {
    next_generation_with(data_dir, &mut |bytes| {
        getrandom::fill(bytes).map_err(|_| GenerationError::Random)
    })
}

pub(crate) fn next_generation_with(
    data_dir: &Path,
    random: &mut dyn FnMut(&mut [u8]) -> Result<(), GenerationError>,
) -> Result<RecordingGeneration, GenerationError> {
    let _lock = lock(data_dir)?;
    let path = data_dir.join(RECORDING_EPOCH_FILE);
    let previous = load(&path)?;
    let generation = draw(previous.as_ref(), random)?;
    save(&path, &generation)?;
    Ok(generation)
}

/// Holds the data dir's exclusive lock from reading the previous pair until
/// the new pair is renamed into place, so concurrent callers (another
/// process included) neither share the temp file nor return a pair other
/// than the saved one. The OS releases the lock when the file is closed.
fn lock(data_dir: &Path) -> Result<fs::File, GenerationError> {
    fs::create_dir_all(data_dir).map_err(|_| GenerationError::Lock)?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data_dir.join(RECORDING_EPOCH_LOCK_FILE))
        .map_err(|_| GenerationError::Lock)?;
    file.lock().map_err(|_| GenerationError::Lock)?;
    Ok(file)
}

pub enum RootCreateError {
    /// No root was built; the seed is returned untouched.
    Generation {
        error: GenerationError,
        seed: RecordingRegistryOwnerSeed,
    },
    /// The generation was saved (and is spent) but the root refused the seed.
    Root(RegistryRootInitFailure),
}

impl std::fmt::Debug for RootCreateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Generation { error, .. } => f
                .debug_struct("Generation")
                .field("error", error)
                .field("seed", &"RecordingRegistryOwnerSeed(..)")
                .finish(),
            Self::Root(failure) => f.debug_tuple("Root").field(failure).finish(),
        }
    }
}

/// Saves a new generation, then builds the root with it. The order is the
/// design §7 rule: a root never exists under an unsaved generation.
pub fn create_recording_root(
    data_dir: &Path,
    seed: RecordingRegistryOwnerSeed,
    context: Value,
) -> Result<
    (
        RecordingRegistryRoot,
        RecordingSessionIssuer,
        RecordingGeneration,
    ),
    RootCreateError,
> {
    let generation = match next_generation(data_dir) {
        Ok(generation) => generation,
        Err(error) => return Err(RootCreateError::Generation { error, seed }),
    };
    let (root, issuer) = RecordingRegistryRoot::try_new(seed, generation.scope(context))
        .map_err(RootCreateError::Root)?;
    Ok((root, issuer, generation))
}

fn draw(
    previous: Option<&RecordingGeneration>,
    random: &mut dyn FnMut(&mut [u8]) -> Result<(), GenerationError>,
) -> Result<RecordingGeneration, GenerationError> {
    let used =
        |value: &str| previous.is_some_and(|p| p.owner_ref == value || p.owner_epoch == value);
    for _ in 0..MAX_DRAWS {
        let owner_ref = random_id(random)?;
        let owner_epoch = random_id(random)?;
        if owner_ref != owner_epoch && !used(&owner_ref) && !used(&owner_epoch) {
            return Ok(RecordingGeneration {
                owner_ref,
                owner_epoch,
            });
        }
    }
    Err(GenerationError::Collision)
}

fn random_id(
    random: &mut dyn FnMut(&mut [u8]) -> Result<(), GenerationError>,
) -> Result<String, GenerationError> {
    let mut bytes = [0u8; ID_BYTES];
    random(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn is_id(value: &str) -> bool {
    value.len() == ID_BYTES * 2
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn load(path: &Path) -> Result<Option<RecordingGeneration>, GenerationError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(GenerationError::Unreadable),
    };
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| GenerationError::Corrupt)?;
    let object = value.as_object().ok_or(GenerationError::Corrupt)?;
    let field = |name: &str| {
        object
            .get(name)
            .and_then(Value::as_str)
            .filter(|v| is_id(v))
            .map(str::to_owned)
            .ok_or(GenerationError::Corrupt)
    };
    if object.len() != 3 || object.get("version").and_then(Value::as_u64) != Some(FILE_VERSION) {
        return Err(GenerationError::Corrupt);
    }
    Ok(Some(RecordingGeneration {
        owner_ref: field("ownerRef")?,
        owner_epoch: field("ownerEpoch")?,
    }))
}

/// Writes a sibling temp file, syncs it, and renames it over the old pair, so
/// a crash leaves either the old or the new pair, never a torn one.
fn save(path: &Path, generation: &RecordingGeneration) -> Result<(), GenerationError> {
    let dir = path.parent().ok_or(GenerationError::Save)?;
    fs::create_dir_all(dir).map_err(|_| GenerationError::Save)?;
    let body = serde_json::to_vec(&json!({
        "version": FILE_VERSION,
        "ownerRef": generation.owner_ref,
        "ownerEpoch": generation.owner_epoch,
    }))
    .map_err(|_| GenerationError::Save)?;
    let temp = temp_path(path);
    let written = (|| {
        let mut file = fs::File::create(&temp)?;
        file.write_all(&body)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        sync_dir(dir)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
        return Err(GenerationError::Save);
    }
    Ok(())
}

fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_owned();
    name.push(".tmp");
    path.with_file_name(name)
}

#[cfg(unix)]
fn sync_dir(dir: &Path) -> std::io::Result<()> {
    fs::File::open(dir)?.sync_all()
}

/// Windows has no directory handle sync through `std`; `rename` there is
/// `MoveFileEx` with replace, and the file data itself was already synced.
#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests;
