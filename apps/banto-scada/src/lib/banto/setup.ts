import {
  createInMemoryDataProvider,
  createLocalUiSettings,
  initBanto,
  type AuthProvider,
  type CredentialRevision,
} from "@banto/admin-core";
import { createToastStore } from "@banto/ui";
import {
  applyTheme,
  applyPreset,
  applyDensity,
  isThemeMode,
  watchSystemTheme,
  type ThemeMode,
} from "@banto/theme";

export const toastStore = createToastStore();
export const uiSettings = createLocalUiSettings();
const revision = "scada-local-file:no-credential" as CredentialRevision;
/** ローカルファイル編集のみ。アカウントや認証済みセッションを捏造しない。 */
const localFileAuth: AuthProvider = {
  login: async () => ({
    success: false,
    error: "ローカル編集ではログインを使用しません",
  }),
  logout: async () => {},
  resolve: async () => ({
    status: "none",
    checked: revision,
    current: revision,
  }),
  credentialRevision: () => revision,
  onCredentialChanged: () => () => {},
};
let themeMode: ThemeMode = "dark";
let menubarVisible = true;
const MENUBAR_KEY = "scada.designer.menubar";
export function getMenubarVisible(): boolean {
  return menubarVisible;
}
export async function setMenubarVisible(visible: boolean): Promise<void> {
  menubarVisible = visible;
  try {
    await uiSettings.set(MENUBAR_KEY, String(visible));
  } catch {
    toastStore.push(
      "warning",
      "メニューバーの設定を保存できません。このタブだけに適用します。",
    );
  }
}
const THEME_KEY = "scada.theme.mode";
export function getThemeMode(): ThemeMode {
  return themeMode;
}
export async function setThemeMode(mode: ThemeMode): Promise<void> {
  themeMode = mode;
  applyTheme(mode);
  try {
    await uiSettings.set(THEME_KEY, mode);
  } catch {
    toastStore.push(
      "warning",
      "テーマ設定を保存できません。このタブだけに適用します。",
    );
  }
}
export async function initializeBanto(): Promise<() => void> {
  initBanto({
    dataProvider: createInMemoryDataProvider({}),
    authProvider: localFileAuth,
    notifier: {
      notify: (kind, message) => {
        toastStore.push(kind, message);
      },
    },
    resources: [],
  });
  try {
    const stored = await uiSettings.get(THEME_KEY);
    if (isThemeMode(stored)) themeMode = stored;
  } catch {
    toastStore.push(
      "warning",
      "テーマ設定を読み込めません。既定のテーマを使います。",
    );
  }
  applyTheme(themeMode);
  applyPreset("standard");
  applyDensity("standard");
  try {
    menubarVisible = (await uiSettings.get(MENUBAR_KEY)) !== "false";
  } catch {
    toastStore.push(
      "warning",
      "メニューバーの設定を読み込めません。初期表示を使います。",
    );
  }
  return watchSystemTheme(() => {
    if (themeMode === "system") applyTheme("system");
  });
}
