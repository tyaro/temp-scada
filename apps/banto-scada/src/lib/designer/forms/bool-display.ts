import type { EditCommand } from "../../editor";
import type { SlotStateLabel } from "../../equipment";
import type { ScreenObject, TextBoolDisplay } from "../../project";

export const MAX_BOOL_LABEL_LENGTH = 64;
export const DEFAULT_BOOL_DISPLAY: TextBoolDisplay = {
  true: { text: "運転", color: "#16a34a" },
  false: { text: "停止", color: "#64748b" },
  unknownColor: "#d97706",
};

export interface BoolDisplayInput {
  data: Pick<FormData, "get">;
  objectId?: string;
  targetKey?: string;
}
export interface BoolDisplayContext {
  generation: number;
  screenId: string;
  definition: boolean;
  selected: ScreenObject | undefined;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
function label(
  data: Pick<FormData, "get">,
  key: "true" | "false",
  name: string,
): SlotStateLabel {
  const text = String(data.get(`${key}Text`) ?? "");
  const color = String(data.get(`${key}Color`) ?? "");
  if ([...text].length > MAX_BOOL_LABEL_LENGTH)
    throw new Error(
      `${name}の文字は${MAX_BOOL_LABEL_LENGTH}文字以内にしてください。`,
    );
  if (/[\r\n\u2028\u2029]/.test(text))
    throw new Error(`${name}の文字に改行は使えません。`);
  if (!COLOR.test(color))
    throw new Error(`${name}の色は #RRGGBB で指定してください。`);
  return { text, color };
}

/** The display from the form; null when "使用しない" is chosen (the display is removed). */
export function parseBoolDisplay(
  data: Pick<FormData, "get">,
): TextBoolDisplay | null {
  const mode = data.get("boolDisplayMode");
  if (mode === "disabled") return null;
  if (mode !== "enabled")
    throw new Error("bool の表示の使用を選択してください。");
  const unknownColor = String(data.get("unknownColor") ?? "");
  if (!COLOR.test(unknownColor))
    throw new Error("取得不能の色は #RRGGBB で指定してください。");
  return {
    true: label(data, "true", "true"),
    false: label(data, "false", "false"),
    unknownColor,
  };
}

/** One history entry: the display (or its removal) of a tag-bound screen Text. */
export function boolDisplayCommand(
  input: BoolDisplayInput,
  context: BoolDisplayContext,
): EditCommand {
  const selected = context.selected;
  if (
    input.targetKey !==
      `${context.generation}:${context.screenId}:${context.definition}` ||
    selected?.id !== input.objectId ||
    selected?.shape.type !== "text" ||
    context.definition ||
    !selected.shape.binding
  )
    throw new Error(
      "bool の表示の適用先が変更されています。選択し直してください。",
    );
  const boolDisplay = parseBoolDisplay(input.data);
  if (boolDisplay && selected.shape.format)
    throw new Error(
      "数値の書式を持つTextには bool の表示を設定できません。先に書式を解除してください。",
    );
  return {
    type: "update",
    screenId: context.screenId,
    objectId: selected.id,
    patch: { boolDisplay },
  };
}
