import type { EditCommand } from "../../editor";
import { isStateSlotType, type EquipmentSlot } from "../../equipment";
import type {
  SymbolColorModeInput,
  SymbolColorModeContext,
} from "./symbol-color-mode";

export function stateTextColorCommand(
  input: SymbolColorModeInput,
  context: SymbolColorModeContext & { readSlots: readonly EquipmentSlot[] },
): EditCommand {
  const selected = context.selected;
  if (
    input.targetKey !==
      `${context.generation}:${context.screenId}:${context.definition}` ||
    selected?.id !== input.objectId ||
    selected?.shape.type !== "text" ||
    !context.definition ||
    !context.readSlots.some(
      (slot) =>
        slot.name ===
          (selected.shape.type === "text"
            ? selected.shape.slotBinding?.slotName
            : undefined) && isStateSlotType(slot.type),
    )
  )
    throw new Error(
      "状態の色に従う指定の適用先が変更されています。選択し直してください。",
    );
  const mode = input.data.get("stateColorsMode");
  if (mode !== "enabled" && mode !== "disabled")
    throw new Error("状態の色に従う指定の使用を選択してください。");
  return {
    type: "update",
    screenId: context.screenId,
    objectId: selected.id,
    patch: {
      stateColors:
        mode === "disabled"
          ? null
          : { unknownColor: String(input.data.get("unknownColor")) },
    },
  };
}
