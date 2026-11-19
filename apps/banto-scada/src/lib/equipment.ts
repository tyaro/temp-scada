import type { SymbolUsage } from "./symbol-usages";
import type { Project } from "./project";
export type SlotType = "bool" | "number" | "state";
/** Wire read type: a `state` slot reads its integer word as a number. */
export type SlotReadType = "bool" | "number";
export function slotReadType(type: SlotType): SlotReadType {
  return type === "bool" ? "bool" : "number";
}
/** Slot types whose equipment-type definition can give a display state. */
export function isStateSlotType(type: SlotType): boolean {
  return type === "bool" || type === "state";
}
export interface SlotStateLabel {
  text: string;
  color: string;
}
/** Rows are evaluated top first; `bits` matches when that bit (0-31) is set. */
export interface SlotStateDisplay {
  source: "value" | "bits";
  rows: (SlotStateLabel & { match: number })[];
  otherwise: SlotStateLabel;
}
/** A Symbol definition declares only the role name and type. */
export interface SymbolReadSlot {
  name: string;
  type: SlotType;
  direction: "read";
}
/** State definitions live only on the equipment type. */
export interface EquipmentSlot extends SymbolReadSlot {
  /** Saved only as true: an unassigned slot then reads as "none", not as an error. */
  allowUnassigned?: true;
  /**
   * Default end of the tag name; the binding table joins it after a per-row
   * prefix. Opaque like a tag name: never trimmed, not blank, 512 chars at most.
   */
  tagSuffix?: string;
  boolDisplay?: { true: SlotStateLabel; false: SlotStateLabel };
  stateDisplay?: SlotStateDisplay;
  /** Present only on slots an operator may write; the slot is still read. */
  write?: SlotWrite;
}
/**
 * Operation of one slot. A button value is a boolean on a bool slot, a finite
 * number on a number slot and an integer 0-2147483647 on a state slot; `input`
 * is for number slots only. At least one of `buttons` and `input` is present.
 */
export interface SlotWrite {
  label: string;
  buttons?: { label: string; value: boolean | number }[];
  input?: { min: number; max: number };
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
/** Checks what the schema cannot; the Rust `validate_slot_write` matches it. */
function validateSlotWrite(write: SlotWrite | undefined) {
  if (write?.input && write.input.min > write.input.max)
    throw new Error("操作の入力の下限が上限より大きいです");
  const values = write?.buttons?.map((button) => button.value) ?? [];
  if (new Set(values).size !== values.length)
    throw new Error("操作のボタンの値が重複しています");
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
      const matches = new Set(slot.stateDisplay?.rows.map((row) => row.match));
      if (matches.size !== (slot.stateDisplay?.rows.length ?? 0))
        throw new Error("状態の行の値（ビット）が重複しています");
      validateSlotWrite(slot.write);
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
