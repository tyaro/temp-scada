//! The mode of this process (Runtime mode design §3, §4, §5): Editor or
//! Runtime, decided once from the command line before the app is built and
//! kept as Tauri state. No command changes it.
//!
//! - no argument: Editor, one `editor` window on `index.html`;
//! - `--runtime <Project file>`: Runtime, one `runtime` window on
//!   `runtime.html`, with the path resolved against the working folder;
//! - anything else: no window; the reason is shown and the process exits.
//!
//! The commands only Editor may serve call [`AppMode::require_editor`]
//! before any other check, so a refused call touches no auth DB, file, alarm
//! or recording DB or Hub. The ACL of the window labels (capabilities
//! `editor.json` / `runtime.json`) refuses them first; this is the host's own
//! second line.
use scada_host::desktop_auth::CommandError;
use scada_host::desktop_recording::RecordingCommandError;
use scada_host::recording_control::ControlError;
use serde::{Serialize, Serializer};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use tauri::{Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};

/// The mode of this process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppMode {
    Editor,
    Runtime { project_path: PathBuf },
}

/// Why the command line was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgError {
    /// `--runtime` without a path.
    MissingPath,
    /// An argument this host does not know.
    Unknown(String),
    /// The path could not be made absolute.
    InvalidPath(String),
}

impl std::fmt::Display for ArgError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingPath => write!(f, "--runtime には Project のファイルを指定してください。"),
            Self::Unknown(arg) => write!(f, "知らない引数です: {arg}"),
            Self::InvalidPath(path) => write!(f, "Project のファイルのパスが不正です: {path}"),
        }
    }
}

/// Usage shown with every refused command line.
pub const USAGE: &str =
    "使い方: banto-scada-desktop（Editor）／ banto-scada-desktop --runtime <Project のファイル>（Runtime）";

/// The mode of the command line `args` (without the program name). A
/// relative path is resolved against `cwd`; the file need not exist yet
/// (the Runtime window reports a Project it cannot read).
pub fn parse_args<I>(args: I, cwd: &Path) -> Result<AppMode, ArgError>
where
    I: IntoIterator<Item = OsString>,
{
    let mut args = args.into_iter();
    let Some(first) = args.next() else {
        return Ok(AppMode::Editor);
    };
    if first != "--runtime" {
        return Err(ArgError::Unknown(first.to_string_lossy().into_owned()));
    }
    let path = match args.next() {
        Some(path) if !path.is_empty() && !path.to_string_lossy().starts_with("--") => path,
        _ => return Err(ArgError::MissingPath),
    };
    if let Some(extra) = args.next() {
        return Err(ArgError::Unknown(extra.to_string_lossy().into_owned()));
    }
    let joined = cwd.join(&path);
    let project_path = std::path::absolute(&joined)
        .map_err(|_| ArgError::InvalidPath(path.to_string_lossy().into_owned()))?;
    Ok(AppMode::Runtime { project_path })
}

/// Shows why the command line was refused (a message box on Windows, and
/// the standard error everywhere). No window of the app is opened.
pub fn report_arg_error(error: &ArgError) {
    let message = format!("{error}\n\n{USAGE}");
    eprintln!("{message}");
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let wide = |text: &str| text.encode_utf16().chain([0]).collect::<Vec<u16>>();
        let text = wide(&message);
        let caption = wide("Banto SCADA");
        // SAFETY: both strings are NUL-terminated UTF-16 buffers that
        // outlive the call; a null owner window is allowed.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                text.as_ptr(),
                caption.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
}

/// A command refused for the mode of this process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModeRefusal {
    EditorOnly,
    #[allow(dead_code)] // The Runtime-only commands come with O0a-2.
    RuntimeOnly,
}

impl ModeRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EditorOnly => "editorOnly",
            Self::RuntimeOnly => "runtimeOnly",
        }
    }
}

impl Serialize for ModeRefusal {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl From<ModeRefusal> for String {
    fn from(refusal: ModeRefusal) -> Self {
        refusal.as_str().to_owned()
    }
}

/// The error of a mode-checked command whose own errors are not strings:
/// a refusal is the plain string `"editorOnly"` / `"runtimeOnly"` like the
/// string-error commands, and any other error is serialized unchanged.
#[derive(Debug)]
pub enum Guarded<E> {
    Mode(ModeRefusal),
    Inner(E),
}

impl<E: Serialize> Serialize for Guarded<E> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Mode(refusal) => refusal.serialize(serializer),
            Self::Inner(error) => error.serialize(serializer),
        }
    }
}

impl<E> From<ModeRefusal> for Guarded<E> {
    fn from(refusal: ModeRefusal) -> Self {
        Self::Mode(refusal)
    }
}

macro_rules! guarded_from {
    ($($error:ty),*) => {$(
        impl From<$error> for Guarded<$error> {
            fn from(error: $error) -> Self {
                Self::Inner(error)
            }
        }
    )*};
}

guarded_from!(CommandError, ControlError, RecordingCommandError);

/// The auth's error of a recording control command, as `ControlError` does.
impl From<CommandError> for Guarded<ControlError> {
    fn from(error: CommandError) -> Self {
        Self::Inner(ControlError::from(error))
    }
}

impl AppMode {
    /// Refuses a command only Editor serves, and logs the refusal (not
    /// audited, design §10-5).
    pub fn require_editor(&self) -> Result<(), ModeRefusal> {
        match self {
            Self::Editor => Ok(()),
            Self::Runtime { .. } => {
                eprintln!("[banto-scada] refused an Editor-only command in Runtime mode");
                Err(ModeRefusal::EditorOnly)
            }
        }
    }

    /// Refuses a command only Runtime serves, and logs the refusal.
    #[allow(dead_code)] // The Runtime-only commands come with O0a-2.
    pub fn require_runtime(&self) -> Result<(), ModeRefusal> {
        match self {
            Self::Runtime { .. } => Ok(()),
            Self::Editor => {
                eprintln!("[banto-scada] refused a Runtime-only command in Editor mode");
                Err(ModeRefusal::RuntimeOnly)
            }
        }
    }

    /// The window label: `editor` or `runtime`. The capabilities are bound
    /// to these labels.
    pub fn window_label(&self) -> &'static str {
        match self {
            Self::Editor => "editor",
            Self::Runtime { .. } => "runtime",
        }
    }

    fn page(&self) -> &'static str {
        match self {
            Self::Editor => "index.html",
            Self::Runtime { .. } => "runtime.html",
        }
    }

    fn name(&self) -> &'static str {
        self.window_label()
    }
}

/// The one window of this process (design §4).
pub fn create_window<R: Runtime, M: Manager<R>>(manager: &M, mode: &AppMode) -> tauri::Result<()> {
    WebviewWindowBuilder::new(
        manager,
        mode.window_label(),
        WebviewUrl::App(mode.page().into()),
    )
    .title("Banto SCADA")
    .inner_size(1440.0, 900.0)
    .min_inner_size(960.0, 600.0)
    .build()?;
    Ok(())
}

/// `app_mode`: `"editor"` or `"runtime"`, for the webview to pick its screen.
#[tauri::command]
pub fn app_mode(mode: State<'_, AppMode>) -> &'static str {
    mode.name()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    fn cwd() -> PathBuf {
        std::env::temp_dir()
    }

    #[test]
    fn no_argument_is_editor() {
        assert_eq!(parse_args(args(&[]), &cwd()), Ok(AppMode::Editor));
    }

    #[test]
    fn runtime_with_an_absolute_path() {
        let path = cwd().join("plant.scada.json");
        let mode = parse_args(
            vec![OsString::from("--runtime"), path.clone().into_os_string()],
            &cwd(),
        );
        assert_eq!(mode, Ok(AppMode::Runtime { project_path: path }));
    }

    #[test]
    fn runtime_resolves_a_relative_path_against_the_working_folder() {
        let base = cwd().join("plant");
        let mode = parse_args(args(&["--runtime", "sub/../line.json"]), &base).unwrap();
        let AppMode::Runtime { project_path } = mode else {
            panic!("not runtime");
        };
        assert!(project_path.is_absolute());
        assert!(project_path.starts_with(&base));
        assert!(project_path.ends_with("line.json"));
    }

    #[test]
    fn runtime_without_a_path_is_refused() {
        assert_eq!(
            parse_args(args(&["--runtime"]), &cwd()),
            Err(ArgError::MissingPath)
        );
        assert_eq!(
            parse_args(args(&["--runtime", ""]), &cwd()),
            Err(ArgError::MissingPath)
        );
        assert_eq!(
            parse_args(args(&["--runtime", "--editor"]), &cwd()),
            Err(ArgError::MissingPath)
        );
    }

    #[test]
    fn an_unknown_argument_is_refused() {
        assert_eq!(
            parse_args(args(&["--editor"]), &cwd()),
            Err(ArgError::Unknown("--editor".into()))
        );
        assert_eq!(
            parse_args(args(&["plant.json"]), &cwd()),
            Err(ArgError::Unknown("plant.json".into()))
        );
        assert_eq!(
            parse_args(args(&["--runtime", "a.json", "b.json"]), &cwd()),
            Err(ArgError::Unknown("b.json".into()))
        );
    }

    #[test]
    fn the_guards_refuse_the_other_mode() {
        let runtime = AppMode::Runtime {
            project_path: cwd().join("a.json"),
        };
        assert_eq!(runtime.require_editor(), Err(ModeRefusal::EditorOnly));
        assert_eq!(runtime.require_runtime(), Ok(()));
        assert_eq!(AppMode::Editor.require_editor(), Ok(()));
        assert_eq!(
            AppMode::Editor.require_runtime(),
            Err(ModeRefusal::RuntimeOnly)
        );
        assert_eq!(
            serde_json::to_value(Guarded::<ControlError>::from(ModeRefusal::EditorOnly)).unwrap(),
            serde_json::json!("editorOnly")
        );
    }
}
