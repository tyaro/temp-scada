import {
  parseFloatingPanelPlacement,
  initialFloatingPanelPlacement,
  type FloatingPanelPlacement,
  type PanelViewport,
} from "./floating-panel-layout";
export type { FloatingPanelRect, PanelViewport } from "./floating-panel-layout";
export {
  FLOATING_PANEL_LIMITS as INSPECTOR_FLOAT_LIMITS,
  supportsFloatingPanel as supportsFloatingInspector,
  visibleFloatingPanelRect as visibleInspectorRect,
  adjustedFloatingPanelRect as adjustedInspectorRect,
} from "./floating-panel-layout";
export type InspectorPlacement = FloatingPanelPlacement & {
  panelId: "inspector";
};
export function parseInspectorPlacement(
  raw: string | null | undefined,
): InspectorPlacement | null {
  const value = parseFloatingPanelPlacement(raw, "inspector");
  return value ? { ...value, panelId: "inspector" } : null;
}
export function initialInspectorPlacement(
  area: PanelViewport,
): InspectorPlacement {
  return {
    ...initialFloatingPanelPlacement(area, "inspector"),
    panelId: "inspector",
  };
}
