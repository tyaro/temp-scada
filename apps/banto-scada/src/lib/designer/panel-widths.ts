export interface PanelWidths {
  left: number;
  right: number;
}
export const DEFAULT_PANEL_WIDTHS: PanelWidths = { left: 240, right: 288 };
export const PANEL_WIDTH_LIMITS = {
  left: { min: 200, max: 400 },
  right: { min: 240, max: 440 },
};
export function parsePanelWidths(
  value: string | null | undefined,
): PanelWidths {
  try {
    const data: unknown = JSON.parse(value ?? "null");
    if (
      data &&
      typeof data === "object" &&
      "left" in data &&
      "right" in data &&
      typeof data.left === "number" &&
      typeof data.right === "number" &&
      Number.isInteger(data.left) &&
      Number.isInteger(data.right) &&
      data.left >= 200 &&
      data.left <= 400 &&
      data.right >= 240 &&
      data.right <= 440
    )
      return { left: data.left, right: data.right };
  } catch {
    /* Use a bounded layout even if local UI settings are damaged. */
  }
  return { ...DEFAULT_PANEL_WIDTHS };
}
export function panelWidthMaximum(side: keyof PanelWidths, viewport: number) {
  return Math.max(
    PANEL_WIDTH_LIMITS[side].min,
    Math.min(
      PANEL_WIDTH_LIMITS[side].max,
      Math.floor(viewport * (side === "left" ? 0.28 : 0.32)),
    ),
  );
}
