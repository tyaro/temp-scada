import type { EditCommand } from "../../editor";
import type { PaintAlphaPatch } from "../../selection-paint-alpha";
import { parseNumericProperty } from "../numeric-properties";
import {
  selectionStyleTarget,
  type SelectionStyleInput,
  type SelectionStyleContext,
} from "./selection-target";
export function selectionPaintAlphaCommand(
  input: SelectionStyleInput,
  context: SelectionStyleContext,
): EditCommand {
  const ids = selectionStyleTarget(input, context);
  const patch: PaintAlphaPatch = {};
  for (const channel of ["fill", "stroke"] as const) {
    const value = String(input.data.get(`${channel}Alpha`) ?? "");
    if (value.trim()) patch[channel] = parseNumericProperty(value) / 100;
  }
  return {
    type: "set-paint-alpha",
    screenId: context.screenId,
    objectIds: ids,
    patch,
  };
}
export function acknowledgeSelectionPaintAlpha(form: HTMLFormElement) {
  for (const name of ["fillAlpha", "strokeAlpha"]) {
    const input = form.elements.namedItem(name);
    if (input instanceof HTMLInputElement) input.value = "";
  }
}
