import { resolveEquipmentSlot, type EquipmentContext } from "./symbol-slots";
import { isSimulatedSlot } from "./slot-presentation";

/** Equipment scope: all adopted roles, including null bindings and roles unused by drawings. */
export function equipmentReadDetails(
  equipmentId: string,
  context: EquipmentContext,
) {
  const equipment = context.equipment?.find((item) => item.id === equipmentId);
  if (!equipment) return undefined;
  const type = context.equipmentTypes?.find(
    (item) => item.id === equipment.typeId,
  );
  if (!type) return undefined;
  const adopted = new Map(
    equipment.bindings.map((binding) => [binding.slotName, binding]),
  );
  const rows = type.slots.flatMap((slot) => {
    const binding = adopted.get(slot.name);
    if (!binding) return [];
    const display = resolveEquipmentSlot(
      equipmentId,
      slot.name,
      slot.type,
      context,
    );
    return [
      {
        name: slot.name,
        type: slot.type,
        externalName: binding.externalName,
        display,
        simulated: isSimulatedSlot(display.provenance),
      },
    ];
  });
  return {
    equipment,
    type,
    rows,
    unavailable: rows.filter((row) => row.display.state !== "good").length,
    simulated: rows.filter((row) => row.simulated).length,
  };
}

/**
 * 表示プレビューで、図面上の Symbol を読取詳細の小窓への入口にするときの対象機器。
 * 関連付けのない Symbol、存在しない機器を指す Symbol、Symbol 以外は undefined（無反応）。
 */
export function previewEquipmentLink(
  shape: { type: string; equipmentId?: string },
  equipment: EquipmentContext["equipment"],
) {
  if (shape.type !== "symbol" || !shape.equipmentId) return undefined;
  return equipment?.find((item) => item.id === shape.equipmentId);
}
