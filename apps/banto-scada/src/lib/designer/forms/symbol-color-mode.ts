import type { EditCommand } from "../../editor";
import type { ScreenObject } from "../../project";

export interface SymbolColorModeInput {
  data: Pick<FormData, "get">;
  objectId?: string;
  targetKey?: string;
}
export interface SymbolColorModeContext {
  generation: number;
  screenId: string;
  definition: boolean;
  selected: ScreenObject | undefined;
}

export function symbolColorModeCommand(
  input: SymbolColorModeInput,
  context: SymbolColorModeContext,
): EditCommand {
  const selected = context.selected;
  if (
    input.targetKey !==
      `${context.generation}:${context.screenId}:${context.definition}` ||
    selected?.id !== input.objectId ||
    selected?.shape.type !== "symbol" ||
    context.definition
  )
    throw new Error(
      "Symbolの色の適用先が変更されています。選択し直してください。",
    );
  const colorMode = String(input.data.get("colorMode"));
  if (colorMode !== "monochrome" && colorMode !== "definition")
    throw new Error("色の使い方を選択してください。");
  return {
    type: "update",
    screenId: context.screenId,
    objectId: selected.id,
    patch: { colorMode },
  };
}
