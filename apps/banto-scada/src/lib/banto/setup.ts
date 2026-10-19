import { DEFAULT_FAVORITES, parseFavorites } from "../designer/favorites";
import {
  DEFAULT_REFERENCE_HEIGHT,
  parseReferenceHeight,
} from "../designer/panel-height";
import {
  DEFAULT_PANEL_WIDTHS,
  parsePanelWidths,
  type PanelWidths,
} from "../designer/panel-widths";
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
export type PaletteView = "icons" | "names";
let paletteView: PaletteView = "icons";
const PALETTE_VIEW_KEY = "scada.designer.palette-view";
export function getPaletteView(): PaletteView {
  return paletteView;
}
export async function setPaletteView(view: PaletteView): Promise<void> {
  paletteView = view;
  try {
    await uiSettings.set(PALETTE_VIEW_KEY, view);
  } catch {
    toastStore.push(
      "warning",
      "部品の表示形式を保存できません。このタブだけに適用します。",
    );
  }
}
const PANEL_WIDTHS_KEY = "scada.designer.panel-widths";
let panelWidths = { ...DEFAULT_PANEL_WIDTHS };
export function getPanelWidths(): PanelWidths {
  return { ...panelWidths };
}
export async function setPanelWidths(value: PanelWidths): Promise<void> {
  panelWidths = parsePanelWidths(JSON.stringify(value));
  try {
    await uiSettings.set(PANEL_WIDTHS_KEY, JSON.stringify(panelWidths));
  } catch {
    toastStore.push(
      "warning",
      "パネルの幅を保存できません。このタブだけに適用します。",
    );
  }
}
const REFERENCE_HEIGHT_KEY = "scada.designer.reference-height";
let referenceHeight = DEFAULT_REFERENCE_HEIGHT;
export function getReferenceHeight(): number {
  return referenceHeight;
}
export async function setReferenceHeight(value: number): Promise<void> {
  referenceHeight = parseReferenceHeight(String(value));
  try {
    await uiSettings.set(REFERENCE_HEIGHT_KEY, String(referenceHeight));
  } catch {
    toastStore.push(
      "warning",
      "タグ参照パネルの高さを保存できません。このタブだけに適用します。",
    );
  }
}
const FAVORITES_KEY = "scada.designer.favorites";
let favorites = [...DEFAULT_FAVORITES];
export function getFavorites(): string[] {
  return [...favorites];
}
export async function setFavorites(value: string[]): Promise<void> {
  favorites = parseFavorites(JSON.stringify(value));
  try {
    await uiSettings.set(FAVORITES_KEY, JSON.stringify(favorites));
  } catch {
    toastStore.push(
      "warning",
      "お気に入りを保存できません。このタブだけに適用します。",
    );
  }
}
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
  try {
    const stored = await uiSettings.get(PALETTE_VIEW_KEY);
    if (stored === "icons" || stored === "names") paletteView = stored;
  } catch {
    toastStore.push(
      "warning",
      "部品の表示形式を読み込めません。アイコン一覧を使います。",
    );
  }
  try {
    panelWidths = parsePanelWidths(await uiSettings.get(PANEL_WIDTHS_KEY));
  } catch {
    toastStore.push(
      "warning",
      "パネルの幅を読み込めません。標準幅を使います。",
    );
  }
  try {
    referenceHeight = parseReferenceHeight(
      await uiSettings.get(REFERENCE_HEIGHT_KEY),
    );
  } catch {
    toastStore.push(
      "warning",
      "タグ参照パネルの高さを読み込めません。標準の高さを使います。",
    );
  }
  try {
    favorites = parseFavorites(await uiSettings.get(FAVORITES_KEY));
  } catch {
    toastStore.push(
      "warning",
      "お気に入りを読み込めません。初期配置を使います。",
    );
  }
  return watchSystemTheme(() => {
    if (themeMode === "system") applyTheme("system");
  });
}
