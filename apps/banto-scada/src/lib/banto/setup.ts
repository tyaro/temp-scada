import {
  parseFloatingPanelPlacement,
  type FloatingPanelPlacement,
} from "../designer/floating-panel-layout";
import {
  parseInspectorPlacement,
  type InspectorPlacement,
} from "../designer/inspector-layout";
import { DEFAULT_FAVORITES, parseFavorites } from "../designer/favorites";
import { DEFAULT_PANEL_LAYOUT } from "../designer/panel-layout";
import { parseReferenceHeight } from "../designer/panel-height";
import { parsePanelWidths, type PanelWidths } from "../designer/panel-widths";
import {
  createInMemoryDataProvider,
  createLocalUiSettings,
  initBanto,
  type AuthProvider,
  type CredentialRevision,
} from "@banto/admin-core";
import { createToastStore } from "@banto/ui";
import { createUiPreference, type UiPreference } from "./ui-preference";
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
function warn(message: string) {
  toastStore.push("warning", message);
}
/** UI の好み1件。保存の順序と保存済みの値は上流の`createSavedSetting`が持つ。 */
function preference<T>(
  key: string,
  options: {
    parse: (raw: string) => T | undefined;
    serialize: (value: T) => string;
    fallback: () => T;
    saveFailed: string;
    loadFailed: string;
  },
) {
  return createUiPreference({ provider: uiSettings, key, warn, ...options });
}
/** 従来どおり「false」だけを非表示とし、ほかの文字は表示として扱う。 */
function visibility(key: string, fallback: boolean, label: string) {
  return preference(key, {
    parse: (raw) => raw !== "false",
    serialize: String,
    fallback: () => fallback,
    saveFailed: `${label}の設定を保存できません。このタブだけに適用します。`,
    loadFailed: `${label}の設定を読み込めません。初期表示を使います。`,
  });
}
export type PaletteView = "icons" | "names";
const paletteView = preference<PaletteView>("scada.designer.palette-view", {
  parse: (raw) => (raw === "icons" || raw === "names" ? raw : undefined),
  serialize: (value) => value,
  fallback: () => "icons",
  saveFailed: "部品の表示形式を保存できません。このタブだけに適用します。",
  loadFailed: "部品の表示形式を読み込めません。アイコン一覧を使います。",
});
export function getPaletteView(): PaletteView {
  return paletteView.current;
}
export async function setPaletteView(view: PaletteView): Promise<void> {
  await paletteView.update(view);
}
/**
 * 浮動配置の保存枠。`saved` は保存に成功した配置だけで、保存の失敗では前の枠が残る。
 * 保存は明示操作のときだけ。`null`は既定（何も保存していない）で、書き込まない。
 */
function placementSlot<T extends FloatingPanelPlacement>(
  key: string,
  parse: (raw: string) => T | null,
  label: string,
  standard: string,
) {
  return preference<T | null>(key, {
    parse: (raw) => parse(raw) ?? undefined,
    serialize: (value) => JSON.stringify(value),
    fallback: () => null,
    saveFailed: `${label}の配置を保存できません。現在の配置と以前の保存配置を保持します。`,
    loadFailed: `${label}の保存配置を読み込めません。${standard}を使います。`,
  });
}
function copyPlacement<T extends FloatingPanelPlacement>(
  value: T | null | undefined,
): T | null {
  return value ? { ...value, rect: { ...value.rect } } : null;
}
function savePlacement<T extends FloatingPanelPlacement>(
  slot: UiPreference<T | null>,
  candidate: T | null,
  label: string,
): Promise<boolean> {
  if (!candidate) {
    warn(`${label}の配置を保存できません。配置の設定を確認してください。`);
    return Promise.resolve(false);
  }
  return slot.update(candidate);
}
const inspectorPlacement = placementSlot(
  "scada.designer.inspector-placement",
  parseInspectorPlacement,
  "プロパティ",
  "右側の標準配置",
);
export function getSavedInspectorPlacement(): InspectorPlacement | null {
  return copyPlacement(inspectorPlacement.saved);
}
/** Explicit save only; a failed write leaves the previous slot available. */
export function saveInspectorPlacement(
  value: InspectorPlacement,
): Promise<boolean> {
  return savePlacement(
    inspectorPlacement,
    parseInspectorPlacement(JSON.stringify(value)),
    "プロパティ",
  );
}
const sidebarPlacement = placementSlot(
  "scada.designer.sidebar-placement",
  (raw) => parseFloatingPanelPlacement(raw, "sidebar"),
  "作業パネル",
  "左側の標準配置",
);
export function getSavedSidebarPlacement(): FloatingPanelPlacement | null {
  return copyPlacement(sidebarPlacement.saved);
}
/** Explicit save only; a failed write leaves the previous slot available. */
export function saveSidebarPlacement(
  value: FloatingPanelPlacement,
): Promise<boolean> {
  return savePlacement(
    sidebarPlacement,
    parseFloatingPanelPlacement(JSON.stringify(value), "sidebar"),
    "作業パネル",
  );
}
// 幅・高さ・お気に入りは、壊れた値を既定値へ丸める従来の解釈をそのまま使う。
const panelWidths = preference<PanelWidths>("scada.designer.panel-widths", {
  parse: parsePanelWidths,
  serialize: (value) => JSON.stringify(value),
  fallback: () => ({ ...DEFAULT_PANEL_LAYOUT.widths }),
  saveFailed: "パネルの幅を保存できません。このタブだけに適用します。",
  loadFailed: "パネルの幅を読み込めません。標準幅を使います。",
});
export function getPanelWidths(): PanelWidths {
  return { ...panelWidths.current };
}
export async function setPanelWidths(value: PanelWidths): Promise<void> {
  await panelWidths.update(parsePanelWidths(JSON.stringify(value)));
}
const referenceHeight = preference<number>("scada.designer.reference-height", {
  parse: parseReferenceHeight,
  serialize: String,
  fallback: () => DEFAULT_PANEL_LAYOUT.referenceHeight,
  saveFailed:
    "タグ参照パネルの高さを保存できません。このタブだけに適用します。",
  loadFailed: "タグ参照パネルの高さを読み込めません。標準の高さを使います。",
});
export function getReferenceHeight(): number {
  return referenceHeight.current;
}
export async function setReferenceHeight(value: number): Promise<void> {
  await referenceHeight.update(parseReferenceHeight(String(value)));
}
const favorites = preference<string[]>("scada.designer.favorites", {
  parse: parseFavorites,
  serialize: (value) => JSON.stringify(value),
  fallback: () => [...DEFAULT_FAVORITES],
  saveFailed: "お気に入りを保存できません。このタブだけに適用します。",
  loadFailed: "お気に入りを読み込めません。初期配置を使います。",
});
export function getFavorites(): string[] {
  return [...favorites.current];
}
export async function setFavorites(value: string[]): Promise<void> {
  await favorites.update(parseFavorites(JSON.stringify(value)));
}
const minimap = visibility(
  "scada.designer.minimap",
  DEFAULT_PANEL_LAYOUT.minimap,
  "ミニマップ",
);
export function getMinimapVisible() {
  return minimap.current;
}
export async function setMinimapVisible(visible: boolean) {
  await minimap.update(visible);
}
const rulers = visibility(
  "scada.designer.rulers",
  DEFAULT_PANEL_LAYOUT.rulers,
  "ルーラー",
);
export function getRulersVisible() {
  return rulers.current;
}
export async function setRulersVisible(visible: boolean) {
  await rulers.update(visible);
}
const menubar = visibility(
  "scada.designer.menubar",
  DEFAULT_PANEL_LAYOUT.menubar,
  "メニューバー",
);
/** 5項目を既定へ戻して保存する。失敗が何項目でも通知は1回。 */
export async function resetDesignerLayoutPreferences(): Promise<boolean> {
  const layout = [panelWidths, referenceHeight, menubar, minimap, rulers];
  for (const item of layout) item.resetToDefault();
  const results = await Promise.all(layout.map((item) => item.save()));
  const saved = results.every(Boolean);
  if (!saved)
    warn(
      "レイアウトを保存できない項目があります。このタブの復元は維持します。",
    );
  return saved;
}
export function getMenubarVisible(): boolean {
  return menubar.current;
}
export async function setMenubarVisible(visible: boolean): Promise<void> {
  await menubar.update(visible);
}
const themeMode = preference<ThemeMode>("scada.theme.mode", {
  parse: (raw) => (isThemeMode(raw) ? raw : undefined),
  serialize: (value) => value,
  fallback: () => "dark",
  saveFailed: "テーマ設定を保存できません。このタブだけに適用します。",
  loadFailed: "テーマ設定を読み込めません。既定のテーマを使います。",
});
export function getThemeMode(): ThemeMode {
  return themeMode.current;
}
export async function setThemeMode(mode: ThemeMode): Promise<void> {
  applyTheme(mode);
  await themeMode.update(mode);
}
/** `authProvider`: the desktop host's; the web version has no account. */
export async function initializeBanto(
  authProvider: AuthProvider = localFileAuth,
): Promise<() => void> {
  initBanto({
    dataProvider: createInMemoryDataProvider({}),
    authProvider,
    notifier: {
      notify: (kind, message) => {
        toastStore.push(kind, message);
      },
    },
    resources: [],
  });
  await themeMode.load();
  applyTheme(themeMode.current);
  applyPreset("standard");
  applyDensity("standard");
  // 読込みの失敗の通知は従来と同じ順に出す。
  for (const item of [
    menubar,
    paletteView,
    inspectorPlacement,
    sidebarPlacement,
    panelWidths,
    referenceHeight,
    favorites,
    minimap,
    rulers,
  ])
    await item.load();
  return watchSystemTheme(() => {
    if (themeMode.current === "system") applyTheme("system");
  });
}
