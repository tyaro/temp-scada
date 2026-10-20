import type { EquipmentPropertyField } from "./project";
import type { EquipmentContext } from "./symbol-slots";

export const equipmentPropertyLabels: Record<EquipmentPropertyField, string> = {
  code: "機器コード",
  name: "機器名",
  typeName: "機器種別名",
};
export function isEquipmentPropertyField(
  value: string,
): value is EquipmentPropertyField {
  return Object.hasOwn(equipmentPropertyLabels, value);
}
export interface EquipmentPropertyPresentation {
  field: EquipmentPropertyField;
  state: "resolved" | "example" | "unbound" | "missingType";
  text: string;
}
/** Saved metadata only. No signal values, selection fallback or runtime-frame ownership. */
export function resolveEquipmentProperty(
  field: EquipmentPropertyField,
  equipmentId?: string,
  context?: EquipmentContext,
  definitionExample = false,
): EquipmentPropertyPresentation {
  if (definitionExample)
    return {
      field,
      state: "example",
      text: `〈${equipmentPropertyLabels[field]}：例示〉`,
    };
  const equipment = context?.equipment?.find((item) => item.id === equipmentId);
  if (!equipment) return { field, state: "unbound", text: "機器未関連付け" };
  if (field === "typeName") {
    const type = context?.equipmentTypes?.find(
      (item) => item.id === equipment.typeId,
    );
    return type
      ? { field, state: "resolved", text: type.name }
      : { field, state: "missingType", text: "機器種別なし" };
  }
  return { field, state: "resolved", text: equipment[field] };
}
