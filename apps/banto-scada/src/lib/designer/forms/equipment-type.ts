import type { Project } from "../../project";
import type { EquipmentCommand } from "../../editor/commands";
import type { EquipmentSlot } from "../../equipment";
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
      (row.type !== "bool" && row.type !== "number") ||
      !("direction" in row) ||
      row.direction !== "read"
    )
      throw new Error("読取slotの名前と型を確認してください");
    return { name: row.name, type: row.type, direction: "read" };
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
  }
  const name = String(data.get("name") ?? "");
  return typeId
    ? { type: "update-equipment-type", typeId, name, slots }
    : { type: "create-equipment-type", name, slots };
}
