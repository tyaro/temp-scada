import type { EditCommand } from "../../editor";
import type { SymbolDefinition } from "../../project";
import { supportsStateColor, stateColorSources } from "../../state-color";
import type {
  SymbolColorModeInput,
  SymbolColorModeContext,
} from "./symbol-color-mode";
export function stateColorCommand(
  input: SymbolColorModeInput,
  context: SymbolColorModeContext & { owner: SymbolDefinition },
): EditCommand {
  const selected = context.selected;
  if (
    input.targetKey !==
      `${context.generation}:${context.screenId}:${context.definition}` ||
    selected?.id !== input.objectId ||
    !context.definition ||
    context.owner.id !== context.screenId ||
    !["rectangle", "ellipse", "polyline"].includes(selected?.shape.type ?? "")
  )
    throw new Error("状態色の追従先が変更されています。選択し直してください。");
  const textId = String(input.data.get("stateColorTextId") ?? "");
  if (
    textId &&
    (!supportsStateColor(selected!) ||
      !stateColorSources(context.owner).some((source) => source.id === textId))
  )
    throw new Error(
      "有効な単色塗り・線と、同じ共有定義のbool配色Textを選択してください。",
    );
  return {
    type: "update",
    screenId: context.screenId,
    objectId: selected!.id,
    patch: { stateColor: textId ? { textId } : null },
  };
}
