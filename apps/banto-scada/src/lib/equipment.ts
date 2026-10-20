import type { Project } from "./project";
export interface EquipmentSlot {
  name: string;
  type: "bool" | "number";
  direction: "read";
}
export interface EquipmentType {
  id: string;
  name: string;
  slots: EquipmentSlot[];
}
export interface EquipmentBinding {
  slotName: string;
  externalName: string | null;
}
export interface EquipmentInstance {
  id: string;
  typeId: string;
  code: string;
  name: string;
  bindings: EquipmentBinding[];
}
/** Schema validates structure; this checks identity and references without adding defaults. */
export function validateEquipment(project: Project, ids: Set<string>) {
  const types = new Map<string, EquipmentType>();
  for (const type of project.equipmentTypes ?? []) {
    if (ids.has(type.id)) throw new Error("ID が重複しています");
    ids.add(type.id);
    types.set(type.id, type);
    const names = new Set<string>();
    for (const slot of type.slots) {
      if (names.has(slot.name)) throw new Error("slot名が重複しています");
      names.add(slot.name);
    }
  }
  const codes = new Set<string>();
  for (const equipment of project.equipment ?? []) {
    if (ids.has(equipment.id)) throw new Error("ID が重複しています");
    ids.add(equipment.id);
    if (codes.has(equipment.code)) throw new Error("機器番号が重複しています");
    codes.add(equipment.code);
    const type = types.get(equipment.typeId);
    if (!type) throw new Error("機器種別が見つかりません");
    const slots = new Set(type.slots.map((slot) => slot.name)),
      bound = new Set<string>();
    for (const binding of equipment.bindings) {
      if (!slots.has(binding.slotName)) throw new Error("未宣言のslotです");
      if (bound.has(binding.slotName))
        throw new Error("slot割付が重複しています");
      bound.add(binding.slotName);
    }
  }
}
