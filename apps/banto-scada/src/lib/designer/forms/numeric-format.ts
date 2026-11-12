import type { EditCommand } from "../../editor";
import type { NumericFormat, ScreenObject } from "../../project";

export const MAX_FORMAT_DECIMALS = 6;
export const MAX_UNIT_LENGTH = 16;

export interface NumericFormatInput {
  data: Pick<FormData, "get">;
  objectId?: string;
  targetKey?: string;
}
export interface NumericFormatContext {
  generation: number;
  screenId: string;
  definition: boolean;
  selected: ScreenObject | undefined;
}

/** C0/C1 controls and the line/paragraph separators, as in the schema. */
function isControl(char: string) {
  const code = char.codePointAt(0)!;
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029
  );
}
/**
 * The format from the form, or null when both fields are empty (the format
 * is removed). The unit is trimmed; decimals are an integer 0..6.
 */
export function parseNumericFormat(
  data: Pick<FormData, "get">,
): NumericFormat | null {
  const decimalsText = String(data.get("decimals") ?? "").trim();
  const unit = String(data.get("unit") ?? "").trim();
  const format: NumericFormat = {};
  if (decimalsText !== "") {
    const decimals = Number(decimalsText);
    if (
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > MAX_FORMAT_DECIMALS
    )
      throw new Error(
        `小数桁は0〜${MAX_FORMAT_DECIMALS}の整数か「そのまま」にしてください。`,
      );
    format.decimals = decimals;
  }
  if (unit !== "") {
    if ([...unit].length > MAX_UNIT_LENGTH)
      throw new Error(`単位は${MAX_UNIT_LENGTH}文字以内にしてください。`);
    if ([...unit].some(isControl))
      throw new Error("単位に制御文字は使えません。");
    format.unit = unit;
  }
  return Object.keys(format).length ? format : null;
}

export function numericFormatCommand(
  input: NumericFormatInput,
  context: NumericFormatContext,
): EditCommand {
  const selected = context.selected;
  if (
    input.targetKey !==
      `${context.generation}:${context.screenId}:${context.definition}` ||
    selected?.id !== input.objectId ||
    selected?.shape.type !== "text" ||
    !(selected.shape.binding || selected.shape.slotBinding)
  )
    throw new Error(
      "数値の書式の適用先が変更されています。選択し直してください。",
    );
  return {
    type: "update",
    screenId: context.screenId,
    objectId: selected.id,
    patch: { format: parseNumericFormat(input.data) },
  };
}
