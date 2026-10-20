import type { EditCommand } from "../../editor";
import { parseNumericProperty } from "../numeric-properties";
import {
  selectionStyleTarget,
  type SelectionStyleInput,
  type SelectionStyleContext,
} from "./selection-target";
export function selectionSizeCommand(
  input: SelectionStyleInput,
  context: SelectionStyleContext,
): EditCommand {
  const ids = selectionStyleTarget(input, context),
    width = String(input.data.get("width") ?? "").trim(),
    height = String(input.data.get("height") ?? "").trim();
  return {
    type: "set-size",
    screenId: context.screenId,
    objectIds: ids,
    ...(width ? { width: parseNumericProperty(width) } : {}),
    ...(height ? { height: parseNumericProperty(height) } : {}),
  };
}
export function acknowledgeSelectionSize(form: HTMLFormElement) {
  for (const name of ["width", "height"]) {
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLInputElement) input.value = "";
  }
}
