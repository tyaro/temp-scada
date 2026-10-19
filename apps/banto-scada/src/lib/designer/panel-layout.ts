import { DEFAULT_PANEL_WIDTHS } from "./panel-widths";
import { DEFAULT_REFERENCE_HEIGHT } from "./panel-height";

/** Layout preferences only; editing context and Project data are not reset. */
export const DEFAULT_PANEL_LAYOUT = {
  widths: { ...DEFAULT_PANEL_WIDTHS },
  referenceHeight: DEFAULT_REFERENCE_HEIGHT,
  panels: { sidebar: true, inspector: true, references: true },
  menubar: true,
  minimap: true,
  rulers: true,
};
