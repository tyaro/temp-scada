import type { EditCommand } from "../../editor";
import { parseNumericProperty } from "../numeric-properties";
import {
  selectionStyleTarget,
  type SelectionStyleInput,
  type SelectionStyleContext,
} from "./selection-target";
export function selectionTextStyleCommand(
  input: SelectionStyleInput,
  context: SelectionStyleContext,
): EditCommand {
  const ids = selectionStyleTarget(input, context),
    fontSize = String(input.data.get("fontSize") ?? "").trim(),
    fontWeight = String(input.data.get("fontWeight") ?? ""),
    align = String(input.data.get("textAlign") ?? "");
  if (fontWeight !== "" && fontWeight !== "normal" && fontWeight !== "bold")
    throw new Error("文字の太さを選択してください");
  if (
    align !== "" &&
    align !== "left" &&
    align !== "center" &&
    align !== "right"
  )
    throw new Error("文字揃えを選択してください");
  return {
    type: "set-text-style",
    screenId: context.screenId,
    objectIds: ids,
    patch: {
      ...(fontSize ? { fontSize: parseNumericProperty(fontSize) } : {}),
      ...(fontWeight ? { fontWeight } : {}),
      ...(align ? { align } : {}),
    },
  };
}
export function acknowledgeSelectionTextStyle(form: HTMLFormElement) {
  for (const name of ["fontSize", "fontWeight", "textAlign"]) {
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement)
      input.value = "";
  }
}
