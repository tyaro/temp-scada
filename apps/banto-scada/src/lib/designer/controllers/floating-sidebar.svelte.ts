import {
  getSavedSidebarPlacement,
  saveSidebarPlacement,
} from "../../banto/setup";
import {
  initialFloatingPanelPlacement,
  visibleFloatingPanelRect,
  supportsFloatingPanel,
  adjustedFloatingPanelRect,
} from "../floating-panel-layout";
import {
  createFloatingPanel,
  type FloatingPanelHost,
  type FloatingPanelWorkspace,
} from "./floating-panel.svelte";
export function createFloatingSidebar(
  host: FloatingPanelHost,
  workspace: FloatingPanelWorkspace,
) {
  return createFloatingPanel(host, {
    panelId: "sidebar",
    label: "作業パネル",
    workspace,
    getSaved: getSavedSidebarPlacement,
    save: saveSidebarPlacement,
    initial: (area) => initialFloatingPanelPlacement(area, "sidebar"),
    visible: visibleFloatingPanelRect,
    supports: supportsFloatingPanel,
    adjust: adjustedFloatingPanelRect,
  });
}
