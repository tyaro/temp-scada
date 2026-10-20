import type { Project, SymbolDefinition } from "./project";

/** Shared declarations describe roles, never equipment-specific tag names. */
export function validateSymbolSlots(project: Project) {
  for (const owner of [...project.screens, ...project.symbols]) {
    const definition = project.symbols.includes(owner as SymbolDefinition)
      ? (owner as SymbolDefinition)
      : undefined;
    const slots = new Set<string>();
    for (const slot of definition?.readSlots ?? []) {
      if (slots.has(slot.name))
        throw new Error("Symbolの読取slot名が重複しています");
      slots.add(slot.name);
    }
    for (const object of owner.objects) {
      if (object.shape.type !== "text" || !object.shape.slotBinding) continue;
      if (!definition)
        throw new Error("slot表示は共有定義内のTextだけに設定できます");
      if (!slots.has(object.shape.slotBinding.slotName))
        throw new Error("Symbolの読取slot宣言が見つかりません");
    }
  }
}

export type EquipmentContext = Pick<Project, "equipmentTypes" | "equipment">;
export type SlotStatus =
  | "unbound"
  | "missingSlot"
  | "typeMismatch"
  | "unadopted"
  | "unassigned"
  | "disconnected";
const labels: Record<SlotStatus, string> = {
  unbound: "機器未関連付け",
  missingSlot: "機器種別にslotなし",
  typeMismatch: "slot型不一致",
  unadopted: "未採用",
  unassigned: "未割付",
  disconnected: "未接続",
};
export function slotPresentation(state: SlotStatus) {
  return { state, label: labels[state], text: `-- · ${labels[state]}` };
}
export type SlotPresentation = ReturnType<typeof slotPresentation>;

/** Resolves saved context only. Real values will enter through the future Host boundary. */
export function resolveSymbolSlot(
  definition: SymbolDefinition,
  slotName: string,
  equipmentId?: string,
  context?: EquipmentContext,
): SlotPresentation {
  const requirement = definition.readSlots?.find(
    (slot) => slot.name === slotName,
  );
  // Invalid definitions are normally rejected by parseProject; keep this renderer fail closed.
  if (!requirement) return slotPresentation("missingSlot");
  const equipment = context?.equipment?.find((item) => item.id === equipmentId);
  if (!equipment) return slotPresentation("unbound");
  const type = context?.equipmentTypes?.find(
    (item) => item.id === equipment.typeId,
  );
  const slot = type?.slots.find((item) => item.name === slotName);
  if (!slot) return slotPresentation("missingSlot");
  if (slot.type !== requirement.type) return slotPresentation("typeMismatch");
  const binding = equipment.bindings.find((item) => item.slotName === slotName);
  if (!binding) return slotPresentation("unadopted");
  if (binding.externalName === null) return slotPresentation("unassigned");
  return slotPresentation("disconnected");
}
