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
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};

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

/// The event the window of the first process gets when a second launch
/// asked for another mode or another Project (design §7). Its screen comes
/// with O0b.
pub const SECOND_INSTANCE_EVENT: &str = "scada:second-instance";

/// Why a second launch is worth telling the first process about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SecondInstance {
    /// Editor while Runtime runs, or Runtime while Editor runs.
    OtherMode,
    /// Runtime with another Project file.
    OtherProject,
}

/// What a second launch with `args` (its whole command line, program
/// first) from the working folder `cwd` asked for that this process does
/// not serve, if anything. The second launch checked its own arguments
/// before it reached the first (design §3), so arguments that do not parse
/// here only bring the first window forward.
pub fn second_instance(first: &AppMode, args: &[String], cwd: &Path) -> Option<SecondInstance> {
    let second = parse_args(args.iter().skip(1).map(OsString::from), cwd).ok()?;
    match (first, &second) {
        (AppMode::Editor, AppMode::Editor) => None,
        (AppMode::Runtime { project_path: a }, AppMode::Runtime { project_path: b }) => {
            (!same_file(a, b)).then_some(SecondInstance::OtherProject)
        }
        _ => Some(SecondInstance::OtherMode),
    }
}

/// Whether two absolute paths name one file: by the file system when both
/// exist, else by the normalized path (case-insensitive on Windows).
fn same_file(a: &Path, b: &Path) -> bool {
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        return a == b;
    }
    let (a, b) = (lexical(a), lexical(b));
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

/// `path` with `.` dropped and each `..` taking its parent away, without
/// touching the file system (`std::path::absolute` keeps `..` on Unix).
fn lexical(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    // At the root (or prefix) `..` stays where it is.
                    if out.as_os_str().is_empty() {
                        out.push(component);
                    }
                } else {
                    out.pop();
                }
            }
            other => out.push(other),
        }
    }
    out
}

/// The single-instance callback in the first process: its window comes
/// forward, and its mode and Project stay as they are (design §7).
pub fn on_second_instance<R: Runtime>(app: &AppHandle<R>, args: Vec<String>, cwd: String) {
    let mode = app.state::<AppMode>();
    let label = mode.window_label();
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Some(reason) = second_instance(&mode, &args, Path::new(&cwd)) {
        let _ = app.emit_to(
            label,
            SECOND_INSTANCE_EVENT,
            serde_json::json!({ "reason": reason }),
        );
    }
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

    fn launch(list: &[&str]) -> Vec<String> {
        std::iter::once("banto-scada-desktop")
            .chain(list.iter().copied())
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn lexical_drops_dot_and_folds_parent_components() {
        let root = cwd();
        assert_eq!(
            lexical(
                &root
                    .join("a")
                    .join(".")
                    .join("sub")
                    .join("..")
                    .join("plant.json")
            ),
            root.join("a").join("plant.json")
        );
        // `..` never climbs above the root.
        let top: PathBuf = root.components().take(1).collect();
        assert_eq!(
            lexical(&top.join("..").join("plant.json")),
            top.join("plant.json")
        );
    }

    #[test]
    fn a_second_launch_of_the_same_mode_and_project_only_comes_forward() {
        let base = cwd().join("second-instance");
        let first = parse_args(args(&["--runtime", "plant.json"]), &base).unwrap();
        assert_eq!(
            second_instance(&first, &launch(&["--runtime", "plant.json"]), &base),
            None
        );
        // The relative path of the second resolves against its own cwd.
        assert_eq!(
            second_instance(
                &first,
                &launch(&["--runtime", "../plant.json"]),
                &base.join("sub")
            ),
            None
        );
        let absolute = base.join("plant.json");
        assert_eq!(
            second_instance(
                &first,
                &launch(&["--runtime", absolute.to_str().unwrap()]),
                &cwd()
            ),
            None
        );
        assert_eq!(second_instance(&AppMode::Editor, &launch(&[]), &base), None);
    }

    #[test]
    fn a_second_launch_of_another_mode_or_project_is_told() {
        let base = cwd().join("second-instance");
        let first = parse_args(args(&["--runtime", "plant.json"]), &base).unwrap();
        assert_eq!(
            second_instance(&first, &launch(&["--runtime", "other.json"]), &base),
            Some(SecondInstance::OtherProject)
        );
        assert_eq!(
            second_instance(&first, &launch(&["--runtime", "plant.json"]), &cwd()),
            Some(SecondInstance::OtherProject)
        );
        assert_eq!(
            second_instance(&first, &launch(&[]), &base),
            Some(SecondInstance::OtherMode)
        );
        assert_eq!(
            second_instance(
                &AppMode::Editor,
                &launch(&["--runtime", "plant.json"]),
                &base
            ),
            Some(SecondInstance::OtherMode)
        );
        // Broken arguments never reach the first process; here they only
        // bring it forward.
        assert_eq!(
            second_instance(&first, &launch(&["--runtime"]), &base),
            None
        );
        assert_eq!(
            serde_json::to_value(SecondInstance::OtherProject).unwrap(),
            serde_json::json!("otherProject")
        );
    }

    #[cfg(windows)]
    #[test]
    fn paths_differing_only_in_case_are_one_project_on_windows() {
        let base = cwd().join("second-instance");
        let first = parse_args(args(&["--runtime", "Plant.json"]), &base).unwrap();
        assert_eq!(
            second_instance(&first, &launch(&["--runtime", "plant.JSON"]), &base),
            None
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
