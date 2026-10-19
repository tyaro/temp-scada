import type { EditCommand } from "../../editor";
import { parseLineStyle } from "../../line-style";
import { parseNumericProperty } from "../numeric-properties";
import {
  selectionStyleTarget,
  type SelectionStyleInput,
  type SelectionStyleContext,
} from "./selection-target";
export function selectionOutlineCommand(
  input: SelectionStyleInput,
  context: SelectionStyleContext,
): EditCommand {
  const ids = selectionStyleTarget(input, context),
    data = input.data;
  const rawMode = String(data.get("outlineMode") ?? ""),
    color = String(data.get("outlineColor") ?? ""),
    width = String(data.get("outlineWidth") ?? "");
  const style = String(data.get("outlineStyle") ?? "");
  if (rawMode !== "" && rawMode !== "none" && rawMode !== "enabled")
    throw new Error("枠線の有無を選択してください。");
  return {
    type: "set-outline-style",
    screenId: context.screenId,
    objectIds: ids as string[],
    patch: {
      ...(rawMode === "" ? {} : { mode: rawMode }),
      ...(color === "" ? {} : { color }),
      ...(width === "" ? {} : { width: parseNumericProperty(width) }),
      ...(style === "" ? {} : { lineStyle: parseLineStyle(style) }),
    },
  };
}

/** Clear only this form's one-shot patch fields before the common draft acceptance. */
export function acknowledgeSelectionOutline(form: HTMLFormElement) {
  for (const name of [
    "outlineMode",
    "outlineColor",
    "outlineWidth",
    "outlineStyle",
  ]) {
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement)
      input.value = "";
  }
}
