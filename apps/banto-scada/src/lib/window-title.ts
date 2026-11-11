const APP_NAME = "Banto SCADA";

export function windowTitle(projectName: string): string {
  const name = projectName.trim();
  return name ? `${name} - ${APP_NAME}` : APP_NAME;
}

/** ブラウザのタブとデスクトップ版のウィンドウの両方へタイトルを反映する。 */
export async function applyWindowTitle(title: string): Promise<void> {
  document.title = title;
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setTitle(title);
}
