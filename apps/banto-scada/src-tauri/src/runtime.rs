//! The Project of Runtime mode (Runtime mode design §5, §6): read once at
//! startup from `--runtime <file>` and never again. The webview never hands
//! Runtime a Project; the `runtime_*` commands use this one.
//!
//! - `runtime_project`: the startup file (the frame of `project_open`) and
//!   its `projectDigest`, or why it could not be read;
//! - `runtime_alarm_status`: the startup Project against the terminal's
//!   applied alarm definitions (§6-3). Nothing is applied.
use std::path::Path;

use scada_host::alarm_project::{
    compare_with_applied, file_hash, project_document, AlarmDefinitionMatch, SavedAlarmProject,
};
use scada_host::operation_write::AppliedProject;
use scada_host::project_file::{frame, FileError, ProjectFiles};
use scada_model::Project;
use serde::Serialize;
use serde_json::json;
use tauri::ipc::Response;
use tauri::State;

use crate::alarm::{self, AlarmState};
use crate::app_mode::AppMode;

/// The error of a `runtime_*` command when the startup Project failed.
pub const PROJECT_UNAVAILABLE: &str = "projectUnavailable";

/// The Project this process runs with.
pub enum StartupProject {
    /// Editor mode: the webview opens Projects itself.
    Editor,
    Loaded(Box<LoadedProject>),
    Failed(LoadFailure),
}

/// The startup file, kept as read.
pub struct LoadedProject {
    file_name: String,
    bytes: Vec<u8>,
    /// Lowercase hex SHA-256 of `bytes`: the `file_hash` of the alarm apply.
    digest: String,
    project: Project,
    /// The alarm part of the file, or why it is not valid.
    alarms: Result<SavedAlarmProject, String>,
}

/// Why the startup file could not be used: its name and `unreadable` (the
/// file system refused) or `invalidFormat` (not a Project file), with the
/// host's reason as `detail`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadFailure {
    pub file_name: String,
    pub reason: &'static str,
    pub detail: String,
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

impl StartupProject {
    /// Reads the Project of `mode` with the read and checks of
    /// `project_open` (`*.json` or `*.bantoscada`). A failure is kept, not
    /// raised: the Runtime window shows it.
    pub fn load(mode: &AppMode) -> Self {
        match mode {
            AppMode::Editor => Self::Editor,
            AppMode::Runtime { project_path } => match Self::read(project_path) {
                Ok(loaded) => Self::Loaded(Box::new(loaded)),
                Err(failure) => {
                    eprintln!(
                        "[banto-scada] the Runtime Project could not be read: {} ({})",
                        failure.reason, failure.detail
                    );
                    Self::Failed(failure)
                }
            },
        }
    }

    fn read(path: &Path) -> Result<LoadedProject, LoadFailure> {
        let failure = |reason, detail: String| LoadFailure {
            file_name: file_name(path),
            reason,
            detail,
        };
        let opened = ProjectFiles::default()
            .read(path)
            .map_err(|error| match error {
                FileError::Io(_) => failure("unreadable", error.reason()),
                _ => failure("invalidFormat", error.reason()),
            })?;
        let document = project_document(path, &opened.bytes)
            .map_err(|_| failure("invalidFormat", "invalid_file".into()))?;
        let project = Project::from_json(&document.to_string())
            .map_err(|_| failure("invalidFormat", "invalid_project".into()))?;
        let alarms = SavedAlarmProject::from_bytes(path, &opened.bytes)
            .map_err(|_| "invalidAlarms".to_owned());
        Ok(LoadedProject {
            file_name: opened.file_name,
            digest: file_hash(&opened.bytes),
            bytes: opened.bytes,
            project,
            alarms,
        })
    }

    /// The applied Project of the operation write (operation stage-3 design
    /// §4-3): the startup file's id, digest and Project; `None` in Editor
    /// mode or when the file could not be read (`project_changed`).
    pub fn applied(&self) -> Option<AppliedProject<'_>> {
        match self {
            Self::Loaded(loaded) => Some(AppliedProject {
                id: loaded.project.id(),
                digest: &loaded.digest,
                project: &loaded.project,
            }),
            _ => None,
        }
    }

    /// The startup Project, or [`PROJECT_UNAVAILABLE`].
    pub fn project(&self) -> Result<&Project, &'static str> {
        match self {
            Self::Loaded(loaded) => Ok(&loaded.project),
            _ => Err(PROJECT_UNAVAILABLE),
        }
    }
}

/// `runtime_project`: the frame of `project_open` for the startup file, its
/// header `{"status": "opened", "fileName", "projectDigest"}` (no `fileId`:
/// Runtime saves nothing). A file that could not be read answers `{"status":
/// "failed", "fileName", "reason", "detail"}` with no body. The same answer
/// for the whole run, whatever happens to the file on disk.
#[tauri::command]
pub fn runtime_project(
    mode: State<'_, AppMode>,
    startup: State<'_, StartupProject>,
) -> Result<Response, String> {
    mode.require_runtime()?;
    match startup.inner() {
        StartupProject::Loaded(loaded) => Ok(Response::new(frame(
            &json!({
                "status": "opened",
                "fileName": loaded.file_name,
                "projectDigest": loaded.digest,
            }),
            &loaded.bytes,
        ))),
        StartupProject::Failed(failure) => {
            let mut header = serde_json::to_value(failure).map_err(|_| "internal")?;
            header["status"] = json!("failed");
            Ok(Response::new(frame(&header, &[])))
        }
        StartupProject::Editor => Err(PROJECT_UNAVAILABLE.into()),
    }
}

/// `runtime_alarm_status`: `notApplied`, `otherProject`, `differs` or
/// `same` (design §6-3). Errors: `projectUnavailable`, `invalidAlarms` (the
/// startup file's alarms are not valid), or why the alarm store is not.
#[tauri::command]
pub async fn runtime_alarm_status(
    mode: State<'_, AppMode>,
    startup: State<'_, StartupProject>,
    alarm: State<'_, AlarmState>,
) -> Result<AlarmDefinitionMatch, String> {
    mode.require_runtime()?;
    let StartupProject::Loaded(loaded) = startup.inner() else {
        return Err(PROJECT_UNAVAILABLE.into());
    };
    let saved = loaded.alarms.as_ref().map_err(Clone::clone)?;
    let applied = alarm
        .get()?
        .applied()
        .await
        .map_err(|error| alarm::reason(&error))?;
    compare_with_applied(saved, applied.as_ref()).map_err(|_| "invalidAppliedRecord".into())
}
