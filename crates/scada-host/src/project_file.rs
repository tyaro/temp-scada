//! The desktop's Project files (alarm design §5.2, 3-C1).
//!
//! The host, not the webview, reads and writes the Project file, so it knows
//! which file holds the saved definitions and that a save reached the disk.
//! The webview never sends a path: the host hands out a `fileId` for each
//! file the user picked (open or save dialog) and later saves overwrite only
//! a file named by such an id.
//!
//! Between the host and the webview the file travels as raw IPC bytes,
//! framed as `[u32 LE: header length][header JSON][file bytes]` (see
//! [`frame`] / [`unframe`]), so an 80 MiB package is not inflated into JSON.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::durable;

/// The largest Project file the host reads or writes: the webview's
/// `PACKAGE_LIMIT` (`project-package.ts`).
pub const FILE_LIMIT: u64 = 80 * 1024 * 1024;

/// The two Project file kinds the Designer writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectFormat {
    /// `*.json`: a Project without images.
    Json,
    /// `*.bantoscada`: the ZIP package with images.
    Package,
}

impl ProjectFormat {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Json => "json",
            Self::Package => "bantoscada",
        }
    }

    /// The format of `path` by its extension (case-insensitive).
    pub fn of(path: &Path) -> Option<Self> {
        let extension = path.extension()?.to_str()?.to_ascii_lowercase();
        match extension.as_str() {
            "json" => Some(Self::Json),
            "bantoscada" => Some(Self::Package),
            _ => None,
        }
    }

    /// Whether `bytes` look like this format: a package is a ZIP (`PK`), a
    /// JSON Project is not.
    fn matches(self, bytes: &[u8]) -> bool {
        bytes.starts_with(b"PK") == (self == Self::Package)
    }
}

/// Why a Project file could not be read or written. The wire form is the
/// `reason` string of [`FileError::reason`].
#[derive(Debug, PartialEq, Eq)]
pub enum FileError {
    /// Larger than [`FILE_LIMIT`].
    TooLarge,
    /// Neither `.json` nor `.bantoscada`.
    UnknownFormat,
    /// The bytes do not match the format the webview declared.
    FormatMismatch,
    /// The file system refused (missing file, no permission, disk full...).
    Io(std::io::ErrorKind),
}

impl FileError {
    pub fn reason(&self) -> String {
        match self {
            Self::TooLarge => "too_large".into(),
            Self::UnknownFormat => "unknown_format".into(),
            Self::FormatMismatch => "format_mismatch".into(),
            Self::Io(std::io::ErrorKind::NotFound) => "not_found".into(),
            Self::Io(std::io::ErrorKind::PermissionDenied) => "permission_denied".into(),
            Self::Io(kind) => format!("io:{kind:?}"),
        }
    }
}

impl From<std::io::Error> for FileError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.kind())
    }
}

/// A file the user opened.
#[derive(Debug)]
pub struct Opened {
    pub file_id: u64,
    pub file_name: String,
    pub bytes: Vec<u8>,
}

/// A file the host wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub file_id: u64,
    pub file_name: String,
}

/// The files the user picked in this process, by `fileId`.
#[derive(Default)]
pub struct ProjectFiles {
    known: Mutex<Known>,
    /// Held while a file is written, so two saves of one file land in order.
    writing: Mutex<()>,
}

#[derive(Default)]
struct Known {
    next: u64,
    files: HashMap<u64, PathBuf>,
}

impl Known {
    /// The id of `path`, registering it on first sight.
    fn id_of(&mut self, path: &Path) -> u64 {
        if let Some((&id, _)) = self.files.iter().find(|(_, known)| *known == path) {
            return id;
        }
        self.next += 1;
        self.files.insert(self.next, path.to_owned());
        self.next
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

impl ProjectFiles {
    /// Reads `path`, which the user picked, and remembers it.
    pub fn read(&self, path: &Path) -> Result<Opened, FileError> {
        ProjectFormat::of(path).ok_or(FileError::UnknownFormat)?;
        if std::fs::metadata(path)?.len() > FILE_LIMIT {
            return Err(FileError::TooLarge);
        }
        let bytes = std::fs::read(path)?;
        if bytes.len() as u64 > FILE_LIMIT {
            return Err(FileError::TooLarge);
        }
        let file_id = self.known.lock().unwrap().id_of(path);
        Ok(Opened {
            file_id,
            file_name: file_name(path),
            bytes,
        })
    }

    /// The file a plain save of `format` overwrites: the file of `file_id`
    /// when it is known and has that format. `None` asks the user where to
    /// save (a new Project, a sample, or an image added to a JSON Project).
    pub fn target(&self, file_id: Option<u64>, format: ProjectFormat) -> Option<PathBuf> {
        let known = self.known.lock().unwrap();
        let path = known.files.get(&file_id?)?;
        (ProjectFormat::of(path) == Some(format)).then(|| path.clone())
    }

    /// The path of `file_id` (the Project the alarm definitions are applied
    /// from, 3-C2).
    pub fn path(&self, file_id: u64) -> Option<PathBuf> {
        self.known.lock().unwrap().files.get(&file_id).cloned()
    }

    /// Replaces `path` with `bytes` (a new uniquely named sibling temp file
    /// renamed over it, so a failed write leaves the old file) and remembers
    /// it.
    pub fn write(
        &self,
        path: &Path,
        format: ProjectFormat,
        bytes: &[u8],
    ) -> Result<Saved, FileError> {
        if ProjectFormat::of(path) != Some(format) {
            return Err(FileError::UnknownFormat);
        }
        if !format.matches(bytes) {
            return Err(FileError::FormatMismatch);
        }
        if bytes.len() as u64 > FILE_LIMIT {
            return Err(FileError::TooLarge);
        }
        {
            let _writing = self.writing.lock().unwrap();
            durable::replace_unique(path, bytes)?;
        }
        let file_id = self.known.lock().unwrap().id_of(path);
        Ok(Saved {
            file_id,
            file_name: file_name(path),
        })
    }
}

/// `path` with the extension of `format`, appended when the user typed a
/// name without it (or with another one) in the save dialog.
pub fn with_extension(path: PathBuf, format: ProjectFormat) -> PathBuf {
    if ProjectFormat::of(&path) == Some(format) {
        return path;
    }
    let mut name = path.file_name().unwrap_or_default().to_owned();
    name.push(".");
    name.push(format.extension());
    path.with_file_name(name)
}

/// A file name for the save dialog from the Project's name: characters
/// Windows forbids become `_`, and an empty name becomes `project`.
pub fn suggested_file_name(name: &str, format: ProjectFormat) -> String {
    let stem: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let stem = stem.trim_end_matches(['.', ' ']);
    let stem = if stem.is_empty() { "project" } else { stem };
    format!("{stem}.{}", format.extension())
}

/// `[u32 LE: header length][header JSON][body]`.
pub fn frame(header: &impl Serialize, body: &[u8]) -> Vec<u8> {
    let header = serde_json::to_vec(header).expect("a header serializes");
    let mut out = Vec::with_capacity(4 + header.len() + body.len());
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    out.extend_from_slice(body);
    out
}

/// The header and body of a [`frame`]. `None` when the frame is cut short or
/// the header is not the expected JSON.
pub fn unframe<T: DeserializeOwned>(bytes: &[u8]) -> Option<(T, &[u8])> {
    let length = u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
    let header = bytes.get(4..4usize.checked_add(length)?)?;
    let header = serde_json::from_slice(header).ok()?;
    Some((header, &bytes[4 + length..]))
}

/// The header of a `project_save` request.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveRequest {
    /// The file the webview's Project came from or was last saved to;
    /// `None` for a new Project or a sample.
    pub file_id: Option<u64>,
    pub format: ProjectFormat,
    /// The Project's name, for the save dialog's file name.
    pub name: String,
    /// "Save as": always ask where to save.
    pub save_as: bool,
}

#[cfg(test)]
#[path = "project_file_tests.rs"]
mod tests;
