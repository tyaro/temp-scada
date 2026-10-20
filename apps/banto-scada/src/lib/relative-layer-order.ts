import type { LayerFolder, ScreenObject, GeometricGroup } from "./project";
import {
  completeGroupSelection,
  groupFor,
  selectedGroup,
} from "./geometric-groups";

export type RelativePosition = "before" | "after";
type Owner = {
  objects: ScreenObject[];
  folders: LayerFolder[];
  groups?: GeometricGroup[];
};
function insert<T extends { id: string }>(
  ordered: T[],
  moving: T[],
  targetIds: string[],
  position: RelativePosition,
): T[] {
  if (position !== "before" && position !== "after")
    throw new Error("挿入位置が不正です。");
  const movingIds = new Set(moving.map((item) => item.id));
  if (targetIds.some((id) => movingIds.has(id))) return ordered;
  const rest = ordered.filter((item) => !movingIds.has(item.id));
  const anchor =
    position === "before" ? targetIds[0] : targetIds[targetIds.length - 1];
  const index = rest.findIndex((item) => item.id === anchor);
  if (index < 0) throw new Error("挿入先が見つかりません。");
  rest.splice(index + (position === "after" ? 1 : 0), 0, ...moving);
  return rest;
}

/** Preserve sibling order slots; folder organization never changes paint order. */
export function relativeFolderOrder(
  folders: readonly LayerFolder[],
  id: string,
  targetId: string,
  position: RelativePosition,
): string[] {
  const source = folders.find((item) => item.id === id),
    target = folders.find((item) => item.id === targetId);
  if (!source || !target) throw new Error("フォルダーが見つかりません。");
  if (source.parentId !== target.parentId)
    throw new Error("同じ親のフォルダー間で並べ替えてください。");
  const ordered = [...folders].sort((a, b) => a.order - b.order);
  const siblings = ordered.filter((item) => item.parentId === source.parentId);
  const next = insert(siblings, [source], [target.id], position);
  let index = 0;
  return ordered.map((item) =>
    item.parentId === source.parentId ? next[index++].id : item.id,
  );
}

/** A single placement/group moves as a block, relative to the entire target group. */
export function relativeObjectOrder(
  owner: Owner,
  ids: readonly string[],
  targetId: string,
  position: RelativePosition,
): string[] {
  const wanted = new Set(ids);
  const ordered = [...owner.objects].sort((a, b) => a.order - b.order);
  const moving = ordered.filter((item) => wanted.has(item.id)),
    target = ordered.find((item) => item.id === targetId);
  if (
    !wanted.size ||
    wanted.size !== ids.length ||
    moving.length !== ids.length ||
    !target
  )
    throw new Error("配置のIDが空・重複または見つかりません。");
  completeGroupSelection(owner, ids);
  if (moving.length > 1 && !selectedGroup(owner, ids))
    throw new Error(
      "並べ替えは一つの配置または一つのグループで行ってください。",
    );
  if (moving.some((item) => item.locked))
    throw new Error("ロック中の配置は並べ替えできません。");
  if (moving.some((item) => item.folderId !== target.folderId))
    throw new Error("同じ親の配置間で並べ替えてください。");
  const targetIds = groupFor(owner, targetId)?.memberIds ?? [targetId];
  return insert(ordered, moving, targetIds, position).map((item) => item.id);
}

/** Names, geometry and visibility do not invalidate an ordering intent. */
export function layerOrderSnapshot(owner: Owner): string {
  return JSON.stringify({
    folders: owner.folders.map((item) => [item.id, item.parentId, item.order]),
    objects: owner.objects.map((item) => [item.id, item.folderId, item.order]),
    groups: owner.groups?.map((item) => [item.id, item.memberIds]),
  });
}
