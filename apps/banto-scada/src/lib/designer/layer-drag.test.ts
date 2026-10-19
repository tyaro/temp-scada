import { expect, it } from "vitest";
import sample from "../../../../../examples/minimal.project.json";
import { parseProject } from "../project";
import { emptyHistory, recordEdit, travelHistory } from "../history";
import { layerDragSource, layerDropError, type LayerDrag } from "./layer-drag";
function fixture() {
  const project = parseProject(JSON.stringify(sample));
  project.screens[0].folders = [
    { id: "0199fe00-0000-7000-8000-000000000001", name: "移動先", order: 0 },
  ];
  return project;
}
it("captures selected sources without mutating selection, including hidden placements", () => {
  const owner = fixture().screens[0],
    ids = owner.objects.slice(0, 2).map((o) => o.id);
  owner.objects[1].visible = false;
  const captured = layerDragSource(owner, ids[0], ids)!;
  expect(captured).toEqual(ids);
  expect(captured).not.toBe(ids);
  expect(layerDragSource(owner, owner.objects[2].id, ids)).toEqual([
    owner.objects[2].id,
  ]);
  expect(ids).toHaveLength(2);
});
it("rejects missing, duplicate and locked selection atomically", () => {
  const owner = fixture().screens[0],
    ids = owner.objects.slice(0, 2).map((o) => o.id);
  owner.objects[1].locked = true;
  expect(layerDragSource(owner, ids[0], ids)).toBeNull();
  expect(layerDragSource(owner, ids[0], [ids[0], ids[0]])).toBeNull();
  expect(layerDragSource(owner, ids[0], [ids[0], "missing"])).toBeNull();
  expect(layerDragSource(owner, "missing", [])).toBeNull();
});
it("revalidates generation, owner, destination and lock changes after a deferred drop", () => {
  const owner = fixture().screens[0];
  const drag: LayerDrag = {
    kind: "objects",
    token: "session",
    scope: "1:screen",
    ids: [owner.objects[0].id],
    hidden: 0,
  };
  expect(layerDropError(owner, drag.scope, drag, "")).toBeNull();
  expect(
    layerDropError(owner, drag.scope, drag, owner.folders[0].id),
  ).toBeNull();
  expect(layerDropError(owner, "2:screen", drag, "")).toContain("編集対象");
  expect(layerDropError(owner, "1:other", drag, "")).toContain("編集対象");
  expect(layerDropError(owner, drag.scope, drag, "missing")).toContain(
    "移動先",
  );
  owner.objects[0].locked = true;
  expect(layerDropError(owner, drag.scope, drag, "")).toContain("ロック");
  owner.objects = [];
  expect(layerDropError(owner, drag.scope, drag, "")).toContain("見つからない");
  expect(
    layerDropError(owner, drag.scope, { ...drag, ids: [] }, ""),
  ).toBeTruthy();
});
it("uses one existing membership command and history step, preserving geometry and drawing order", () => {
  const project = fixture(),
    owner = project.screens[0],
    ids = owner.objects.slice(0, 2).map((o) => o.id);
  const command = {
    type: "set-folder" as const,
    screenId: owner.id,
    objectIds: ids,
    folderId: owner.folders[0].id,
  };
  const changed = recordEdit(project, emptyHistory(), command, "edit");
  expect(changed.project.screens[0].objects.slice(0, 2)).toEqual(
    owner.objects
      .slice(0, 2)
      .map((o) => ({ ...o, folderId: command.folderId })),
  );
  expect(
    travelHistory(changed.project, changed.history, "undo", "edit").project
      .screens,
  ).toEqual(project.screens);
  expect(
    recordEdit(changed.project, changed.history, command, "edit").project,
  ).toBe(changed.project);
});

import { folderDragSource } from "./layer-drag";
it("captures a folder subtree without including unrelated selection, and keeps locks and visibility", () => {
  const owner = fixture().screens[0],
    id = owner.folders[0].id;
  owner.folders.push({ id: "child", parentId: id, name: "child", order: 1 });
  owner.objects[0].folderId = "child";
  owner.objects[0].locked = true;
  owner.objects[1].folderId = id;
  owner.objects[1].visible = false;
  const source = folderDragSource(owner, id)!;
  expect(source).toEqual({
    kind: "folder",
    folderId: id,
    parentId: "",
    name: "移動先",
    count: 2,
    hidden: 1,
  });
  expect(folderDragSource(owner, "missing")).toBeNull();
  const drag: LayerDrag = { ...source, token: "session", scope: "owner" };
  expect(layerDropError(owner, "owner", drag, "")).toBeNull();
  expect(layerDropError(owner, "owner", drag, id)).toContain("自身");
  expect(layerDropError(owner, "owner", drag, "child")).toContain("配下");
  expect(layerDropError(owner, "owner", drag, "missing")).toContain("移動先");
  owner.folders[0].parentId = "elsewhere";
  expect(layerDropError(owner, "owner", drag, "")).toContain("移動元の親");
  owner.folders = [];
  expect(layerDropError(owner, "owner", drag, "")).toContain("見つかりません");
});
it("includes the whole subtree height in hover validation and revalidates it after a deferred drop", () => {
  const owner = fixture().screens[0],
    id = owner.folders[0].id;
  owner.folders.push({ id: "child", parentId: id, name: "child", order: 1 });
  for (let i = 1; i <= 15; i++)
    owner.folders.push({
      id: `depth${i}`,
      name: `depth${i}`,
      order: i + 1,
      ...(i > 1 ? { parentId: `depth${i - 1}` } : {}),
    });
  const drag: LayerDrag = {
    ...folderDragSource(owner, id)!,
    token: "session",
    scope: "owner",
  };
  expect(layerDropError(owner, "owner", drag, "depth14")).toBeNull();
  expect(layerDropError(owner, "owner", drag, "depth15")).toContain("16段");
  owner.folders.push({
    id: "grandchild",
    name: "grandchild",
    parentId: "child",
    order: 20,
  });
  expect(layerDropError(owner, "owner", drag, "depth14")).toContain("16段");
  expect(layerDropError(owner, "other", drag, "")).toContain("編集対象");
});
