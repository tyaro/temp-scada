/** Transient preview windows. Never serialized into Project, history or browser settings. */
export const MAX_PREVIEW_POPUPS = 4;
export const MAX_POPUP_PLACEMENTS = 20_000;
export interface PopupArea {
  readonly width: number;
  readonly height: number;
}
export interface PopupFrame extends PopupArea {
  readonly x: number;
  readonly y: number;
}
export interface PreviewPopup {
  readonly targetId: string;
  readonly kind: PopupKind;
  readonly cost: number;
  readonly frame: PopupFrame;
}
export type PopupKind = "screen" | "equipment";
export const popupKey = (entry: Pick<PreviewPopup, "kind" | "targetId">) =>
  `${entry.kind}:${entry.targetId}`;
/** Bottom to top. Identity is kind + target within the current Project generation. */
export type PreviewPopups = readonly PreviewPopup[];
function finite(value: number) {
  if (!Number.isFinite(value))
    throw new Error("小窓の位置・寸法は有限の数値にしてください。");
  return value;
}
export function popupFrame(frame: PopupFrame, area: PopupArea): PopupFrame {
  const available = {
    width: Math.max(0, finite(area.width)),
    height: Math.max(0, finite(area.height)),
  };
  const width = Math.min(
    available.width,
    Math.max(Math.min(320, available.width), finite(frame.width)),
  );
  const height = Math.min(
    available.height,
    Math.max(Math.min(220, available.height), finite(frame.height)),
  );
  return {
    x: Math.max(0, Math.min(finite(frame.x), available.width - width)),
    y: Math.max(0, Math.min(finite(frame.y), available.height - height)),
    width,
    height,
  };
}
export function frontPopup(
  windows: PreviewPopups,
  targetId: string,
  kind: PopupKind = "screen",
): PreviewPopups {
  const entry = windows.find((w) => w.targetId === targetId && w.kind === kind);
  if (!entry) throw new Error("小窓が見つかりません。");
  return windows.at(-1) === entry
    ? windows
    : [...windows.filter((w) => w !== entry), entry];
}
export function openPopup(
  windows: PreviewPopups,
  targetId: string,
  cost: number,
  area: PopupArea,
  kind: PopupKind = "screen",
): PreviewPopups {
  if (windows.some((w) => w.targetId === targetId && w.kind === kind))
    return frontPopup(windows, targetId, kind);
  if (!targetId || !Number.isSafeInteger(cost) || cost < 0)
    throw new Error("小窓の画面または描画配置数が不正です。");
  if (windows.length >= MAX_PREVIEW_POPUPS)
    throw new Error(
      "表示確認の小窓は4件までです。不要な小窓を閉じてください。",
    );
  if (windows.reduce((sum, w) => sum + w.cost, 0) + cost > MAX_POPUP_PLACEMENTS)
    throw new Error(
      "小窓全体の描画配置数は20,000件以下にしてください。不要な小窓を閉じるか、参照元の配置を減らしてください。",
    );
  if (area.width <= 0 || area.height <= 0)
    throw new Error("小窓を表示する領域がありません。");
  const frame = popupFrame(
    {
      x: 24 + windows.length * 24,
      y: 24 + windows.length * 24,
      width: Math.min(720, area.width * 0.8),
      height: Math.min(480, area.height * 0.8),
    },
    area,
  );
  return [...windows, { targetId, kind, cost, frame }];
}
export function positionPopup(
  windows: PreviewPopups,
  targetId: string,
  frame: PopupFrame,
  area: PopupArea,
  kind: PopupKind = "screen",
): PreviewPopups {
  if (!windows.some((w) => w.targetId === targetId && w.kind === kind))
    throw new Error("小窓が見つかりません。");
  const next = popupFrame(frame, area);
  return windows.map((w) =>
    w.targetId === targetId && w.kind === kind ? { ...w, frame: next } : w,
  );
}
export function constrainPopups(
  windows: PreviewPopups,
  area: PopupArea,
): PreviewPopups {
  return windows.map((w) => ({ ...w, frame: popupFrame(w.frame, area) }));
}
export function closePopup(
  windows: PreviewPopups,
  targetId: string,
  kind: PopupKind = "screen",
): PreviewPopups {
  return windows.filter((w) => !(w.targetId === targetId && w.kind === kind));
}
