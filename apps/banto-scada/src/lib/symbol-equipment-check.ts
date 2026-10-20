import type { Project } from "./project";
import { resolveSymbolSlot, symbolSlotUsages } from "./symbol-slots";

/** Saved configuration only: never consult runtime values or claim catalog validation. */
export function symbolEquipmentCheck(
  project: Project,
  symbolId: string,
  equipmentId: string,
) {
  const definition = project.symbols.find((item) => item.id === symbolId);
  const equipment = project.equipment?.find((item) => item.id === equipmentId);
  const context = {
    equipment: project.equipment,
    equipmentTypes: project.equipmentTypes,
  };
  const used =
    definition?.readSlots?.filter(
      (slot) => symbolSlotUsages(definition, slot.name).length > 0,
    ) ?? [];
  const rows = used.map((slot) => {
    const display = resolveSymbolSlot(
      definition!,
      slot.name,
      equipmentId,
      context,
    );
    return {
      name: slot.name,
      type: slot.type,
      state: display.state,
      label:
        display.state === "disconnected"
          ? "外部名あり・catalog未確認"
          : display.label,
    };
  });
  return {
    definition,
    equipment,
    rows,
    incomplete: rows.filter((row) => row.state !== "disconnected").length,
    unused: (definition?.readSlots?.length ?? 0) - used.length,
  };
}
