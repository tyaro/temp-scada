import type { Project } from "../../project";
import type { EquipmentCommand } from "../../editor/commands";
export function equipmentFormCommand(
  form: HTMLFormElement,
  project: Project,
  generation: number,
): EquipmentCommand {
  if (
    !form.isConnected ||
    form.dataset.targetKey !== `${generation}:${project.manifest.projectId}`
  )
    throw new Error("機器の編集対象が変わりました");
  const data = new FormData(form),
    equipmentId = form.dataset.equipmentId;
  const code = String(data.get("code") ?? ""),
    name = String(data.get("name") ?? "");
  if (!equipmentId)
    return {
      type: "create-equipment",
      typeId: String(data.get("typeId") ?? ""),
      code,
      name,
      bindings: [],
    };
  const item = project.equipment?.find((item) => item.id === equipmentId);
  if (!item) throw new Error("機器が見つかりません");
  const kind = project.equipmentTypes!.find((type) => type.id === item.typeId)!;
  const bindings = kind.slots.flatMap((slot) => {
    const state = data.get(`state:${slot.name}`);
    if (state === "unadopted") return [];
    if (state !== "unassigned" && state !== "assigned")
      throw new Error("slotの状態が不正です");
    return [
      {
        slotName: slot.name,
        externalName:
          state === "unassigned"
            ? null
            : String(data.get(`tag:${slot.name}`) ?? ""),
      },
    ];
  });
  return { type: "update-equipment", equipmentId, code, name, bindings };
}
