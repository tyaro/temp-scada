//! The desktop's Project open / save commands (alarm design §5.2, §5.5,
//! 3-C1). Thin adapters: the file handling is `scada_host::project_file`.
//!
//! The host picks the file in its own dialog and reads or writes it, so the
//! saved Project is the file the host wrote. The webview names a file only
//! by the `fileId` the host returned. The file bytes travel as raw IPC in
//! the frame of `project_file::frame`.
use std::path::PathBuf;

use scada_host::auth::BantoError;
use scada_host::desktop_auth::CommandError;
use scada_host::project_file::{
    frame, suggested_file_name, unframe, with_extension, ProjectFiles, ProjectFormat, SaveRequest,
};
use serde_json::{json, Value};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Runtime, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::auth::AuthState;

/// The files the user picked in this process.
#[derive(Default)]
pub struct ProjectFileState(pub ProjectFiles);

const FILTER_NAME: &str = "Banto SCADA Project";

async fn pick_open<R: Runtime>(window: &WebviewWindow<R>) -> Option<PathBuf> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(window)
        .set_title("Project を開く")
        .add_filter(FILTER_NAME, &["json", "bantoscada"])
        .pick_file(move |path| {
            let _ = sender.send(path);
        });
    receiver.await.ok().flatten()?.into_path().ok()
}

async fn pick_save<R: Runtime>(
    window: &WebviewWindow<R>,
    format: ProjectFormat,
    name: &str,
) -> Option<PathBuf> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .dialog()
        .file()
        .set_parent(window)
        .set_title("Project を保存")
        .set_file_name(suggested_file_name(name, format))
        .add_filter(FILTER_NAME, &[format.extension()])
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let picked = receiver.await.ok().flatten()?.into_path().ok()?;
    let path = with_extension(picked.clone(), format);
    // The dialog confirmed an overwrite of the picked name only: a file at
    // the name with the extension appended is confirmed here.
    if path != picked && path.exists() && !confirm_overwrite(window, &path).await {
        return None;
    }
    Some(path)
}

async fn confirm_overwrite<R: Runtime>(window: &WebviewWindow<R>, path: &std::path::Path) -> bool {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    window
        .dialog()
        .message(format!("{name} は既にあります。上書きしますか？"))
        .title("Project を保存")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "上書き".into(),
            "キャンセル".into(),
        ))
        .parent(window)
        .show(move |overwrite| {
            let _ = sender.send(overwrite);
        });
    receiver.await.unwrap_or(false)
}

/// The refusal of the save permission, as the webview reads it.
fn refusal(error: CommandError) -> String {
    match error {
        CommandError::Banto(BantoError::Unauthorized) => "unauthorized",
        CommandError::Banto(BantoError::Forbidden) => "forbidden",
        CommandError::Unavailable(_) => "auth_unavailable",
        _ => "auth_failed",
    }
    .into()
}

async fn authorize(auth: &AuthState) -> Result<(), String> {
    auth.get()
        .map_err(refusal)?
        .authorize_project_save()
        .await
        .map_err(refusal)
}

/// `project_open`: the user picks a Project file and the host reads it.
/// Answers a frame whose header is `{"status": "opened", "fileId",
/// "fileName"}` followed by the file, or `{"status": "cancelled"}`.
#[tauri::command]
pub async fn project_open<R: Runtime>(
    window: WebviewWindow<R>,
    files: State<'_, ProjectFileState>,
) -> Result<Response, String> {
    let Some(path) = pick_open(&window).await else {
        return Ok(Response::new(frame(&json!({"status": "cancelled"}), &[])));
    };
    let opened = files.0.read(&path).map_err(|error| error.reason())?;
    Ok(Response::new(frame(
        &json!({"status": "opened", "fileId": opened.file_id, "fileName": opened.file_name}),
        &opened.bytes,
    )))
}

/// `project_save`: the body is a frame of a [`SaveRequest`] header and the
/// file. Overwrites the file of `fileId` when it has the format, else (or
/// for "save as") asks where to save. The permission (§5.2) is checked
/// before the dialog and again before the write. Answers `{"status":
/// "saved", "fileId", "fileName", "apply": null}` (`apply` is the alarm
/// definitions' apply, 3-C2) or `{"status": "cancelled"}`.
#[tauri::command]
pub async fn project_save<R: Runtime>(
    window: WebviewWindow<R>,
    files: State<'_, ProjectFileState>,
    auth: State<'_, AuthState>,
    request: Request<'_>,
) -> Result<Value, String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("invalid_request".into());
    };
    let (header, content) = unframe::<SaveRequest>(body).ok_or("invalid_request")?;
    authorize(&auth).await?;
    let target = match header.save_as {
        true => None,
        false => files.0.target(header.file_id, header.format),
    };
    let path = match target {
        Some(path) => path,
        None => match pick_save(&window, header.format, &header.name).await {
            Some(path) => {
                authorize(&auth).await?;
                path
            }
            None => return Ok(json!({"status": "cancelled"})),
        },
    };
    let saved = files
        .0
        .write(&path, header.format, content)
        .map_err(|error| error.reason())?;
    Ok(json!({
        "status": "saved",
        "fileId": saved.file_id,
        "fileName": saved.file_name,
        "apply": null,
    }))
}
