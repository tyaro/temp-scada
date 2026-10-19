import {
  getBounds,
  type Screen,
  type SymbolDefinition,
  type ScreenObject,
  type GeometricGroup,
} from "./project";
import { normalizeRotation, rotatePoint, rotationPivot } from "./rotation";

export function groupsOf(owner: Screen | SymbolDefinition): GeometricGroup[] {
  return "groups" in owner ? owner.groups : [];
}
export function validateGroups(screen: Screen, ids: Set<string>): void {
  const ordered = [...screen.objects].sort((a, b) => a.order - b.order);
  const positions = new Map(ordered.map((object, index) => [object.id, index]));
  const assigned = new Set<string>();
  for (const group of screen.groups) {
    if (ids.has(group.id)) throw new Error("ID が重複しています");
    ids.add(group.id);
    const start = positions.get(group.memberIds[0]);
    if (start === undefined) throw new Error("グループの配置が見つかりません");
    const folder = ordered[start].folderId;
    group.memberIds.forEach((id, index) => {
      if (assigned.has(id))
        throw new Error("配置は複数グループに所属できません");
      assigned.add(id);
      if (positions.get(id) !== start + index)
        throw new Error("グループは描画順で連続する配置を指定してください");
      if (ordered[start + index].folderId !== folder)
        throw new Error("グループは同じフォルダーの配置を指定してください");
    });
  }
}
export function groupFor(owner: Screen | SymbolDefinition, id: string) {
  return groupsOf(owner).find((group) => group.memberIds.includes(id));
}
export function completeGroupSelection(
  owner: Screen | SymbolDefinition,
  ids: readonly string[],
) {
  const selected = new Set(ids);
  for (const group of groupsOf(owner))
    if (
      group.memberIds.some((id) => selected.has(id)) &&
      !group.memberIds.every((id) => selected.has(id))
    )
      throw new Error(
        "グループ全体を選択してください。内部編集はグループ解除後に行ってください。",
      );
}
export function expandGroupSelection(
  owner: Screen | SymbolDefinition,
  ids: readonly string[],
): string[] {
  const selected = new Set(ids);
  for (const group of groupsOf(owner))
    if (group.memberIds.some((id) => selected.has(id)))
      group.memberIds.forEach((id) => selected.add(id));
  return owner.objects
    .filter((object) => selected.has(object.id))
    .sort((a, b) => a.order - b.order)
    .map((object) => object.id);
}
export function selectionUnits(
  owner: Screen | SymbolDefinition,
  ids: readonly string[],
): ScreenObject[][] {
  completeGroupSelection(owner, ids);
  const selected = new Set(ids),
    visited = new Set<string>();
  const ordered = [...owner.objects].sort((a, b) => a.order - b.order);
  return ordered.flatMap((object) => {
    if (!selected.has(object.id) || visited.has(object.id)) return [];
    const group = groupFor(owner, object.id);
    const members = group
      ? ordered.filter((item) => group.memberIds.includes(item.id))
      : [object];
    members.forEach((item) => visited.add(item.id));
    return [members];
  });
}
export function unitBounds(objects: readonly ScreenObject[]) {
  if (!objects.length) throw new Error("配置を選択してください");
  const bounds = objects.map((object) => {
    const b = getBounds(object);
    return {
      left: object.x + b.x,
      top: object.y + b.y,
      right: object.x + b.x + b.width,
      bottom: object.y + b.y + b.height,
    };
  });
  const x = Math.min(...bounds.map((b) => b.left)),
    y = Math.min(...bounds.map((b) => b.top));
  const result = {
    x,
    y,
    width: Math.max(...bounds.map((b) => b.right)) - x,
    height: Math.max(...bounds.map((b) => b.bottom)) - y,
  };
  if (
    ![
      ...Object.values(result),
      result.x + result.width,
      result.y + result.height,
    ].every(Number.isFinite)
  )
    throw new Error("グループの外形は有限の座標にしてください");
  return result;
}
export function rotateUnit(objects: ScreenObject[], delta: number) {
  if (delta !== 90 && delta !== -90)
    throw new Error("グループは左右90度で回転してください");
  const bounds = unitBounds(objects),
    pivot = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  for (const object of objects) {
    const local = rotationPivot(object),
      world = { x: object.x + local.x, y: object.y + local.y };
    const target = rotatePoint(world, pivot, delta);
    object.x = target.x - local.x;
    object.y = target.y - local.y;
    object.rotation = normalizeRotation(object.rotation + delta);
  }
}
