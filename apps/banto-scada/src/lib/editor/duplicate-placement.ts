import { groupsOf } from "../geometric-groups";
import type { Screen, SymbolDefinition, ScreenObject } from "../project";
import { newId, remapStateColor } from "./model-helpers";

/** One new ID map per copy keeps group members and internal state-color references together. */
export function duplicatePlacements(
  owner: Screen | SymbolDefinition,
  objects: readonly ScreenObject[],
  dx: number,
  dy: number,
) {
  const order =
    Math.max(-1, ...owner.objects.map((object) => object.order)) + 1;
  const copies = new Map(objects.map((object) => [object.id, newId()]));
  const copiedGroups = groupsOf(owner)
    .filter((group) => group.memberIds.every((id) => copies.has(id)))
    .map((group) => ({
      ...group,
      id: newId(),
      memberIds: group.memberIds.map((id) => copies.get(id)!),
    }));
  if ("groups" in owner) owner.groups.push(...copiedGroups);
  objects.forEach((object, index) => {
    const copy = structuredClone(object);
    copy.id = copies.get(object.id)!;
    remapStateColor(copy, copies);
    copy.x += dx;
    copy.y += dy;
    copy.order = order + index;
    owner.objects.push(copy);
  });
}
