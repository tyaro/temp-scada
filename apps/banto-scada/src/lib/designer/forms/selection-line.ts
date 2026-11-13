import type { EditCommand } from "../../editor";
import { parseLineArrow } from "../../line-arrow";
import { parseLineStyle } from "../../line-style";
import { parseNumericProperty } from "../numeric-properties";
import {
  selectionStyleTarget,
  type SelectionStyleInput,
  type SelectionStyleContext,
} from "./selection-target";
export function selectionLineCommand(
  input: SelectionStyleInput,
  context: SelectionStyleContext,
): EditCommand {
  const ids = selectionStyleTarget(input, context),
    data = input.data;
  const width = String(data.get("strokeWidth") ?? ""),
    arrow = String(data.get("arrow") ?? "");
  const style = String(data.get("lineStyle") ?? "");
  return {
    type: "set-line-style",
    screenId: context.screenId,
    objectIds: ids as string[],
    patch: {
      ...(width === "" ? {} : { strokeWidth: parseNumericProperty(width) }),
      ...(arrow === "" ? {} : { arrow: parseLineArrow(arrow) }),
      ...(style === "" ? {} : { lineStyle: parseLineStyle(style) }),
    },
  };
}

export function acknowledgeSelectionLine(form: HTMLFormElement) {
  const width = form.elements.namedItem("strokeWidth"),
    arrow = form.elements.namedItem("arrow");
  if (width instanceof HTMLInputElement) width.value = "";
  if (arrow instanceof HTMLSelectElement) arrow.value = "";
  const style = form.elements.namedItem("lineStyle");
  if (style instanceof HTMLSelectElement) style.value = "";
}
