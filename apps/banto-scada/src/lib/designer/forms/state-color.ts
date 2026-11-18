import type { EditCommand } from "../../editor";
import { isAreaShape, type Screen, type SymbolDefinition } from "../../project";
import { supportsStateColor, stateColorSources } from "../../state-color";
import type {
  SymbolColorModeInput,
  SymbolColorModeContext,
} from "./symbol-color-mode";
export function stateColorCommand(
  input: SymbolColorModeInput,
  context: SymbolColorModeContext & { owner: Screen | SymbolDefinition },
): EditCommand {
  const selected = context.selected;
  if (
    input.targetKey !==
      `${context.generation}:${context.screenId}:${context.definition}` ||
    selected?.id !== input.objectId ||
    context.owner.id !== context.screenId ||
    "background" in context.owner === context.definition ||
    !(
      selected &&
      (isAreaShape(selected.shape) || selected.shape.type === "polyline")
    )
  )
    throw new Error("状態色の追従先が変更されています。選択し直してください。");
  const textId = String(input.data.get("stateColorTextId") ?? "");
  if (
    textId &&
    (!supportsStateColor(selected!) ||
      !stateColorSources(context.owner).some((source) => source.id === textId))
  )
    throw new Error(
      "有効な単色塗り・線と、同じ共有定義または同じ画面の配色元Textを選択してください。",
    );
  return {
    type: "update",
    screenId: context.screenId,
    objectId: selected!.id,
    patch: { stateColor: textId ? { textId } : null },
  };
}
