import type { Screen, SymbolDefinition } from "../project";
import {
  completeGroupSelection,
  groupFor,
  groupsOf,
  selectionUnits,
  rotateUnit,
} from "../geometric-groups";
import { newId } from "./model-helpers";
import type { GroupCommand } from "./commands";
import { unhandledCommand } from "./unhandled-command";

function groupName(name: string | undefined) {
  if (name === undefined) return undefined;
  if (typeof name !== "string" || !name.trim() || [...name.trim()].length > 200)
    throw new Error("グループ名は空白以外の200文字以下で指定してください");
  return name.trim();
}
export function reorderUnit(
  owner: Screen | SymbolDefinition,
  id: string,
  direction: "front" | "back" | "forward" | "backward",
) {
  const units = selectionUnits(
    owner,
    owner.objects.map((object) => object.id),
  );
  const from = units.findIndex((unit) =>
    unit.some((object) => object.id === id),
  );
  if (from < 0) throw new Error("配置が見つかりません");
  const to =
    direction === "front"
      ? units.length - 1
      : direction === "back"
        ? 0
        : direction === "forward"
          ? Math.min(units.length - 1, from + 1)
          : Math.max(0, from - 1);
  if (from === to) return "unchanged" as const;
  const [unit] = units.splice(from, 1);
  units.splice(to, 0, unit);
  owner.objects = units.flat();
  owner.objects.forEach((object, index) => (object.order = index));
  return "finish" as const;
}
export function applyGroupCommand(
  owner: Screen | SymbolDefinition,
  command: GroupCommand,
): "finish" | "unchanged" {
  if (!("groups" in owner))
    throw new Error("Symbol定義内のグループには対応していません");
  if (command.type === "group" || command.type === "rotate-groups") {
    const ids = new Set(command.objectIds);
    if (!ids.size || ids.size !== command.objectIds.length)
      throw new Error("選択する配置IDが空または重複しています");
    const objects = owner.objects
      .filter((object) => ids.has(object.id))
      .sort((a, b) => a.order - b.order);
    if (objects.length !== ids.size) throw new Error("配置が見つかりません");
    if (objects.some((object) => object.locked))
      throw new Error("ロック中の配置を含むため変更できません");
    if (command.type === "group") {
      if (objects.length < 2)
        throw new Error("グループ化する配置を2件以上選択してください");
      if (objects.some((object) => groupFor(owner, object.id)))
        throw new Error("既存グループを解除してからグループ化してください");
      const name = groupName(command.name);
      owner.groups.push({
        id: newId(),
        ...(name === undefined ? {} : { name }),
        memberIds: objects.map((object) => object.id),
      });
    } else {
      completeGroupSelection(owner, command.objectIds);
      if (command.delta !== 90 && command.delta !== -90)
        throw new Error("左右90度を指定してください");
      for (const unit of selectionUnits(owner, command.objectIds))
        rotateUnit(unit, command.delta);
    }
    return "finish";
  }
  const group = groupsOf(owner).find((group) => group.id === command.groupId);
  if (!group) throw new Error("グループが見つかりません");
  const objects = owner.objects.filter((object) =>
    group.memberIds.includes(object.id),
  );
  if (command.type === "set-group-state") {
    if (command.locked === undefined && command.visible === undefined)
      throw new Error("表示またはロック状態を指定してください");
    if (
      (command.locked !== undefined && typeof command.locked !== "boolean") ||
      (command.visible !== undefined && typeof command.visible !== "boolean")
    )
      throw new Error("状態はbooleanで指定してください");
    objects.forEach((object) => {
      if (command.locked !== undefined && !!object.locked !== command.locked) {
        if (command.locked) object.locked = true;
        else delete object.locked;
      }
      if (
        command.visible !== undefined &&
        (object.visible !== false) !== command.visible
      ) {
        if (command.visible) delete object.visible;
        else object.visible = false;
      }
    });
    return "finish";
  }
  if (objects.some((object) => object.locked))
    throw new Error("ロック中の配置を含むため変更できません");
  if (command.type === "ungroup")
    owner.groups = owner.groups.filter((item) => item.id !== group.id);
  else if (command.type === "rename-group") {
    const name = groupName(command.name);
    if (name === undefined) delete group.name;
    else group.name = name;
  } else if (command.type === "reorder-group")
    return reorderUnit(owner, group.memberIds[0], command.direction);
  else return unhandledCommand(command);
  return "finish";
}
