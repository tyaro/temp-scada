//! Crash-safe small-file storage shared by the host's state files
//! (`recording-epoch.json`, `auth-phase.json`).
//!
//! A file is replaced by writing a sibling temp file, syncing it, and
//! renaming it over the old one, so a crash leaves either the old or the new
//! content, never a torn one. On unix the directory entry is synced after
//! the rename; on Windows the replace is best effort (host-gate design §7).
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Reads `path`. `Ok(None)` only when nothing exists at that name at all: a
/// dangling symlink exists but cannot be read, so it is an error.
pub(crate) fn read_optional(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && fs::symlink_metadata(path)
                    .is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

/// Whether anything (a file, a directory, a dangling link) is at `path`.
/// Only a definite "not found" is `Ok(false)`.
pub(crate) fn exists(path: &Path) -> std::io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Replaces `path` with `body` durably (see the module docs). On failure the
/// temp file is removed and the old content stays.
pub(crate) fn replace(path: &Path, body: &[u8]) -> std::io::Result<()> {
    let temp = temp_path(path);
    let written = (|| {
        let mut file = fs::File::create(&temp)?;
        file.write_all(body)?;
        file.sync_all()?;
        replace_durably(&temp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

/// Replaces `path` with `body` like [`replace`], through a temp file of a
/// unique name that this call creates exclusively, for a path the user
/// picked: a neighbouring file is never truncated or removed, whatever its
/// name. On failure only the temp file of this call is removed.
pub(crate) fn replace_unique(path: &Path, body: &[u8]) -> std::io::Result<()> {
    let mut name = std::ffi::OsString::from(".");
    name.push(path.file_name().ok_or(std::io::ErrorKind::InvalidInput)?);
    name.push(format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
    let temp = path.with_file_name(name);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let written = (|| {
        file.write_all(body)?;
        file.sync_all()?;
        drop(file);
        replace_durably(&temp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

pub(crate) fn temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_owned();
    name.push(".tmp");
    path.with_file_name(name)
}

/// Opens (creating) the lock file `name` in `dir`, creating `dir` durably.
pub(crate) fn open_lock_file(dir: &Path, name: &str) -> std::io::Result<fs::File> {
    create_dir_durably(dir)?;
    fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(name))
}

/// Creates `dir` and its missing ancestors. On unix the parent of every
/// directory created here is synced, so the new names survive a power loss
/// along with the files saved inside them.
pub(crate) fn create_dir_durably(dir: &Path) -> std::io::Result<()> {
    let mut missing = Vec::new();
    let mut cursor = Some(dir);
    while let Some(path) = cursor.filter(|path| !path.as_os_str().is_empty() && !path.exists()) {
        missing.push(path);
        cursor = path.parent();
    }
    fs::create_dir_all(dir)?;
    for created in missing.iter().rev() {
        sync_parent(created)?;
    }
    Ok(())
}

#[cfg(unix)]
fn sync_parent(path: &Path) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    fs::File::open(parent)?.sync_all()
}

/// `std` cannot sync a directory on Windows; durability of the parent's new
/// entry is left to the NTFS metadata journal.
#[cfg(not(unix))]
fn sync_parent(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Renames `from` over `to` and returns only once the new name is durable:
/// the directory entry is synced after the rename.
#[cfg(unix)]
fn replace_durably(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)?;
    let dir = to.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    fs::File::open(dir)?.sync_all()
}

/// Best effort on Windows (design §7, user decision 2026-11-08): the flush
/// `MOVEFILE_WRITE_THROUGH` documents covers copy-and-delete moves only, and
/// `std` cannot sync a directory, so a same-volume rename is not guaranteed
/// to survive a power loss.
#[cfg(windows)]
fn replace_durably(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let wide =
        |path: &Path| -> Vec<u16> { path.as_os_str().encode_wide().chain(Some(0)).collect() };
    let (from, to) = (wide(from), wide(to));
    // SAFETY: both pointers are NUL-terminated UTF-16 buffers that outlive the call.
    let moved = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
