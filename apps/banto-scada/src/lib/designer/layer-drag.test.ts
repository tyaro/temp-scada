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
