/** UI preferences only. Never stored in Project or edit history. */
export interface FloatingPanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type FloatingPanelId = "inspector" | "sidebar";
export interface FloatingPanelPlacement {
  layoutVersion: 1;
  panelId: FloatingPanelId;
  mode: "docked" | "floating";
  rect: FloatingPanelRect;
}
export interface PanelViewport {
  width: number;
  height: number;
  top: number;
}
export const FLOATING_PANEL_LIMITS = {
  minWidth: 280,
  maxWidth: 640,
  minHeight: 240,
  maxHeight: 900,
  margin: 8,
};
export function parseFloatingPanelPlacement(
  raw: string | null | undefined,
  panelId: FloatingPanelId,
): FloatingPanelPlacement | null {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const data = value as Record<string, unknown>;
    if (
      Object.keys(data).sort().join(",") !==
        "layoutVersion,mode,panelId,rect" ||
      data.layoutVersion !== 1 ||
      data.panelId !== panelId ||
      (data.mode !== "docked" && data.mode !== "floating")
    )
      return null;
    const rect = data.rect;
    if (!rect || typeof rect !== "object" || Array.isArray(rect)) return null;
    const box = rect as Record<string, unknown>;
    if (
      Object.keys(box).sort().join(",") !== "height,width,x,y" ||
      !["x", "y", "width", "height"].every(
        (key) => typeof box[key] === "number" && Number.isFinite(box[key]),
      )
    )
      return null;
    const { x, y, width, height } = box as unknown as FloatingPanelRect;
    const limits = FLOATING_PANEL_LIMITS;
    if (
      x < 0 ||
      y < 0 ||
      width < limits.minWidth ||
      width > limits.maxWidth ||
      height < limits.minHeight ||
      height > limits.maxHeight
    )
      return null;
    return {
      layoutVersion: 1,
      panelId,
      mode: data.mode,
      rect: { x, y, width, height },
    };
  } catch {
    return null;
  }
}
export function supportsFloatingPanel(area: PanelViewport): boolean {
  return (
    [area.width, area.height, area.top].every(Number.isFinite) &&
    area.top >= 0 &&
    area.width >= 1100 &&
    area.height >= 480 &&
    area.height - area.top >= FLOATING_PANEL_LIMITS.minHeight + 16
  );
}
/** Clamp a displayed rectangle only; callers keep the saved/desired rectangle separately. */
export function visibleFloatingPanelRect(
  rect: FloatingPanelRect,
  area: PanelViewport,
): FloatingPanelRect | null {
  if (!supportsFloatingPanel(area)) return null;
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite))
    return null;
  const limits = FLOATING_PANEL_LIMITS,
    margin = limits.margin;
  const width = Math.min(
    Math.max(rect.width, limits.minWidth),
    Math.min(limits.maxWidth, area.width - margin * 2),
  );
  const height = Math.min(
    Math.max(rect.height, limits.minHeight),
    Math.min(limits.maxHeight, area.height - area.top - margin * 2),
  );
  return {
    x: Math.max(margin, Math.min(rect.x, area.width - width - margin)),
    y: Math.max(
      area.top + margin,
      Math.min(rect.y, area.height - height - margin),
    ),
    width,
    height,
  };
}
export function initialFloatingPanelPlacement(
  area: PanelViewport,
  panelId: FloatingPanelId,
): FloatingPanelPlacement {
  const rect = {
    x: panelId === "sidebar" ? 24 : Math.max(8, area.width - 344),
    y: Math.max(8, area.top + 20),
    width: 320,
    height: 600,
  };
  return {
    layoutVersion: 1,
    panelId,
    mode: "docked",
    rect: visibleFloatingPanelRect(rect, area) ?? rect,
  };
}
export function adjustedFloatingPanelRect(
  start: FloatingPanelRect,
  kind: "move" | "resize",
  dx: number,
  dy: number,
  area: PanelViewport,
): FloatingPanelRect | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (kind !== "move" && kind !== "resize") return null;
  const base = visibleFloatingPanelRect(start, area);
  if (!base) return null;
  if (kind === "move")
    return visibleFloatingPanelRect(
      { ...base, x: base.x + dx, y: base.y + dy },
      area,
    );
  // A bottom-right resize keeps the top-left fixed, including at viewport edges.
  const limits = FLOATING_PANEL_LIMITS;
  return {
    ...base,
    width: Math.min(
      Math.max(base.width + dx, limits.minWidth),
      limits.maxWidth,
      area.width - base.x - limits.margin,
    ),
    height: Math.min(
      Math.max(base.height + dy, limits.minHeight),
      limits.maxHeight,
      area.height - base.y - limits.margin,
    ),
  };
}
