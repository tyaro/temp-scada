import type { EditCommand } from "../../editor";
import {
  selectionStyleTarget,
  type SelectionStyleInput,
  type SelectionStyleContext,
} from "./selection-target";

export function selectionColorCommand(
  input: SelectionStyleInput,
  context: SelectionStyleContext,
): EditCommand {
  const ids = selectionStyleTarget(input, context);
  return {
    type: "set-color",
    screenId: context.screenId,
    objectIds: ids,
    fill: String(input.data.get("fill")),
    convertDefinitionSymbols:
      input.data.get("convertDefinitionSymbols") === "on",
  };
}

/** Reset one-shot changes only after the edit succeeds. */
export function acknowledgeSelectionColor(form: HTMLFormElement) {
  const input = form.elements.namedItem("fill");
  if (input instanceof HTMLInputElement) input.value = "";
  const convert = form.elements.namedItem("convertDefinitionSymbols");
  if (convert instanceof HTMLInputElement) convert.checked = false;
}
