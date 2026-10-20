import type { SymbolUsage } from "./symbol-usages";
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
  const equipmentIds = new Set(project.equipment?.map((item) => item.id));
  for (const owner of [...project.screens, ...project.symbols])
    for (const object of owner.objects) {
      if (
        object.shape.type !== "symbol" ||
        object.shape.equipmentId === undefined
      )
        continue;
      if (!project.screens.includes(owner as Project["screens"][number]))
        throw new Error("共有定義に機器を関連付けできません");
      if (!equipmentIds.has(object.shape.equipmentId))
        throw new Error("関連付けた機器が見つかりません");
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

export interface EquipmentUsage extends SymbolUsage {
  equipmentId: string;
}
/** Derived index: hidden and locked placements in every screen remain usages. */
export function equipmentUsages(
  project: Project,
  equipmentId: string,
): EquipmentUsage[] {
  return project.screens.flatMap((screen) =>
    [...screen.objects]
      .sort((a, b) => a.order - b.order)
      .flatMap((object) =>
        object.shape.type === "symbol" &&
        object.shape.equipmentId === equipmentId
          ? [
              {
                equipmentId,
                symbolId: object.shape.symbolId,
                screenId: screen.id,
                screenName: screen.name,
                objectId: object.id,
                order: object.order,
                x: object.x,
                y: object.y,
                ...(object.name ? { name: object.name } : {}),
                ...(object.visible === false ? { visible: false } : {}),
              },
            ]
          : [],
      ),
  );
}
