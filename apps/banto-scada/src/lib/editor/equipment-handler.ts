import { equipmentUsages } from "../equipment";
import type { Project } from "../project";
import type { EquipmentType, EquipmentInstance } from "../equipment";
import type { EquipmentCommand } from "./commands";
import { newId } from "./model-helpers";
import { unhandledCommand } from "./unhandled-command";
/** Candidate only. Shared finish validates references and records one atomic edit. */
export function applyEquipmentCommand(
  next: Project,
  command: EquipmentCommand,
) {
  const typeById = (id: string): EquipmentType => {
    const found = next.equipmentTypes?.find((type) => type.id === id);
    if (!found) throw new Error("機器種別が見つかりません");
    return found;
  };
  const byId = (id: string): EquipmentInstance => {
    const found = next.equipment?.find((item) => item.id === id);
    if (!found) throw new Error("機器が見つかりません");
    return found;
  };
  switch (command.type) {
    case "create-equipment-type":
      (next.equipmentTypes ??= []).push({
        id: newId(),
        name: command.name.trim(),
        slots: command.slots.map((slot) => ({ ...slot })),
      });
      return;
    case "update-equipment-type": {
      const type = typeById(command.typeId);
      for (const item of next.equipment ?? []) {
        if (item.typeId !== type.id) continue;
        for (const binding of item.bindings) {
          const old = type.slots.find(
            (slot) => slot.name === binding.slotName,
          )!;
          const replacement = command.slots.find(
            (slot) => slot.name === binding.slotName,
          );
          if (
            !replacement ||
            replacement.type !== old.type ||
            replacement.direction !== old.direction
          )
            throw new Error("採用中slotの削除・改名・型変更はできません");
        }
      }
      type.name = command.name.trim();
      type.slots = command.slots.map((slot) => ({ ...slot }));
      return;
    }
    case "remove-equipment-type":
      typeById(command.typeId);
      if (next.equipment?.some((item) => item.typeId === command.typeId))
        throw new Error("使用中の機器種別です");
      next.equipmentTypes = next.equipmentTypes!.filter(
        (type) => type.id !== command.typeId,
      );
      return;
    case "create-equipment":
      typeById(command.typeId);
      (next.equipment ??= []).push({
        id: newId(),
        typeId: command.typeId,
        code: command.code.trim(),
        name: command.name.trim(),
        bindings: command.bindings.map((binding) => ({ ...binding })),
      });
      return;
    case "update-equipment": {
      const item = byId(command.equipmentId);
      item.code = command.code.trim();
      item.name = command.name.trim();
      item.bindings = command.bindings.map((binding) => ({ ...binding }));
      return;
    }
    case "remove-equipment":
      byId(command.equipmentId);
      if (equipmentUsages(next, command.equipmentId).length)
        throw new Error("図面で使用中の機器は削除できません");
      next.equipment = next.equipment!.filter(
        (item) => item.id !== command.equipmentId,
      );
      return;
    default:
      return unhandledCommand(command);
  }
}
