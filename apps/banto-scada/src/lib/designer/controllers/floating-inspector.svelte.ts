import {
  getSavedInspectorPlacement,
  saveInspectorPlacement,
} from "../../banto/setup";
import {
  initialInspectorPlacement,
  visibleInspectorRect,
  supportsFloatingInspector,
  adjustedInspectorRect,
} from "../inspector-layout";
import {
  createFloatingPanel,
  createFloatingPanelWorkspace,
  type FloatingPanelHost,
  type FloatingPanelWorkspace,
} from "./floating-panel.svelte";
/** Same Inspector DOM, persistence slot, geometry and interaction contract. */
export function createFloatingInspector(
  host: FloatingPanelHost,
  workspace: FloatingPanelWorkspace = createFloatingPanelWorkspace(),
) {
  return createFloatingPanel(host, {
    panelId: "inspector",
    label: "プロパティ",
    workspace,
    getSaved: getSavedInspectorPlacement,
    save: (value) => saveInspectorPlacement({ ...value, panelId: "inspector" }),
    initial: initialInspectorPlacement,
    visible: visibleInspectorRect,
    supports: supportsFloatingInspector,
    adjust: adjustedInspectorRect,
  });
}
export type FloatingInspector = ReturnType<typeof createFloatingInspector>;
