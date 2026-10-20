import type { EditCommand } from "../../editor";
import type { EquipmentSlot } from "../../equipment";
import type {
  SymbolColorModeInput,
  SymbolColorModeContext,
} from "./symbol-color-mode";

export function boolColorsCommand(
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
            : undefined) && slot.type === "bool",
    )
  )
    throw new Error(
      "状態別の文字色の適用先が変更されています。選択し直してください。",
    );
  const mode = input.data.get("boolColorsMode");
  if (mode !== "enabled" && mode !== "disabled")
    throw new Error("状態別の文字色の使用を選択してください。");
  return {
    type: "update",
    screenId: context.screenId,
    objectId: selected.id,
    patch: {
      boolColors:
        mode === "disabled"
          ? null
          : {
              trueColor: String(input.data.get("trueColor")),
              falseColor: String(input.data.get("falseColor")),
              unknownColor: String(input.data.get("unknownColor")),
            },
    },
  };
}
