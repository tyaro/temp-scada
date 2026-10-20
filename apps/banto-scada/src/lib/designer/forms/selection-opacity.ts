import type { EditCommand } from "../../editor";
import { parseNumericProperty } from "../numeric-properties";
import {
  selectionStyleTarget,
  type SelectionStyleInput,
  type SelectionStyleContext,
} from "./selection-target";
export function selectionOpacityCommand(
  input: SelectionStyleInput,
  context: SelectionStyleContext,
): EditCommand {
  const ids = selectionStyleTarget(input, context);
  return {
    type: "set-opacity",
    screenId: context.screenId,
    objectIds: ids,
    opacity:
      parseNumericProperty(String(input.data.get("opacity") ?? "")) / 100,
  };
}
export function acknowledgeSelectionOpacity(form: HTMLFormElement) {
  const input = form.elements.namedItem("opacity");
  if (input instanceof HTMLInputElement) input.value = "";
}
