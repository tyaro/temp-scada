import type { Project } from "../../project";
import type { EquipmentCommand } from "../../editor/commands";
import type { EquipmentSlot } from "../../equipment";
import { slotDisplayError } from "../../slot-display-edit";
export function equipmentTypeFormCommand(
  input: {
    connected: boolean;
    targetKey?: string;
    typeId?: string;
    data: Pick<FormData, "get">;
  },
  project: Project,
  generation: number,
): EquipmentCommand {
  const typeId = input.typeId ?? "";
  if (
    !input.connected ||
    input.targetKey !==
      `${generation}:${project.manifest.projectId}:${typeId || "new"}`
  )
    throw new Error("機器種別の編集対象が変わりました");
  if (typeId && !project.equipmentTypes?.some((type) => type.id === typeId))
    throw new Error("機器種別が見つかりません");
  const data = input.data;
  let value: unknown;
  try {
    value = JSON.parse(String(data.get("slots") ?? ""));
  } catch {
    throw new Error("読取slotの入力が不正です");
  }
  if (!Array.isArray(value) || value.length > 64)
    throw new Error("読取slotは64件以下にしてください");
  const slots: EquipmentSlot[] = value.map((row: unknown) => {
    if (
      !row ||
      typeof row !== "object" ||
      !("name" in row) ||
      typeof row.name !== "string" ||
      !("type" in row) ||
      (row.type !== "bool" && row.type !== "number" && row.type !== "state") ||
      !("direction" in row) ||
      row.direction !== "read"
    )
      throw new Error("読取slotの名前と型を確認してください");
    // The remaining shape is checked by the schema when the edit is applied.
    const extra = row as Partial<EquipmentSlot>;
    if (
      extra.stateDisplay &&
      (typeof extra.stateDisplay !== "object" ||
        !Array.isArray(extra.stateDisplay.rows) ||
        !extra.stateDisplay.otherwise)
    )
      throw new Error("状態の定義の入力が不正です");
    return {
      name: row.name,
      type: row.type,
      direction: "read",
      ...(extra.allowUnassigned === true ? { allowUnassigned: true } : {}),
      ...(extra.boolDisplay ? { boolDisplay: extra.boolDisplay } : {}),
      ...(extra.stateDisplay ? { stateDisplay: extra.stateDisplay } : {}),
    };
  });
  const seen = new Set<string>();
  for (const slot of slots) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(slot.name) ||
      /[^A-Za-z0-9_]/.test(slot.name)
    )
      throw new Error(
        "slot名は英字か_で始まる英数字と_の64文字以内にしてください",
      );
    if (seen.has(slot.name)) throw new Error("slot名が重複しています");
    seen.add(slot.name);
    const problem = slotDisplayError(slot);
    if (problem) throw new Error(problem);
  }
  const name = String(data.get("name") ?? "");
  return typeId
    ? { type: "update-equipment-type", typeId, name, slots }
    : { type: "create-equipment-type", name, slots };
}
