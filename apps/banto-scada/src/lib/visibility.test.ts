import { expect, it } from "vitest";
import cases from "../../../../examples/visibility-cases.json";
import sample from "../../../../examples/minimal.project.json";
import processSample from "../../../../examples/process.project.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { objectsInRange } from "./range-selection";
import { copyObjects, parseClipboard } from "./clipboard";
import { bindingReferences } from "./binding-references";
import { symbolUsages } from "./symbol-usages";
const fresh = () => parseProject(JSON.stringify(sample));
for (const test of cases)
  it(`visibility contract: ${test.name}`, () => {
    for (const path of [
      ["screens", 0, "objects", 2],
      ["screens", 0, "objects", 7],
      ["screens", 0, "objects", 10],
      ["symbols", 0, "objects", 0],
    ] as const) {
      const value: any = structuredClone(processSample);
      value[path[0]][path[1]][path[2]][path[3]].visible = test.value;
      if (test.valid) {
        const project = parseProject(JSON.stringify(value));
        expect(parseProject(serializeProject(project))).toEqual(project);
      } else expect(() => parseProject(JSON.stringify(value))).toThrow();
    }
  });
it("hide/show is reversible, idempotent, and independent of names, geometry and lock", () => {
  let project = fresh();
  const screenId = project.screens[0].id,
    objectId = project.screens[0].objects[0].id;
  project = applyCommand(
    project,
    { type: "set-lock", screenId, objectId, locked: true },
    "edit",
  );
  const original = project.screens[0].objects[0];
  let result = recordEdit(
    project,
    emptyHistory(),
    { type: "set-visibility", screenId, objectId, visible: false },
    "edit",
  );
  expect(result.project.screens[0].objects[0]).toEqual({
    ...original,
    visible: false,
  });
  expect(
    applyCommand(
      result.project,
      { type: "set-visibility", screenId, objectId, visible: false },
      "edit",
    ),
  ).toBe(result.project);
  result = recordEdit(
    result.project,
    result.history,
    { type: "set-visibility", screenId, objectId, visible: true },
    "edit",
  );
  expect(result.project.screens[0].objects[0]).toEqual(original);
  result = travelHistory(result.project, result.history, "undo", "edit");
  expect(result.project.screens[0].objects[0].visible).toBe(false);
  expect(() =>
    applyCommand(
      result.project,
      { type: "set-visibility", screenId, objectId, visible: true },
      "preview",
    ),
  ).toThrow();
  expect(() =>
    applyCommand(
      result.project,
      { type: "update", screenId, objectId, patch: { name: "blocked" } },
      "edit",
    ),
  ).toThrow(/ロック/);
});
it("hidden unlocked placements remain deliberately editable while range selection excludes them", () => {
  let project = fresh();
  const screenId = project.screens[0].id,
    objectId = project.screens[0].objects[0].id;
  project = applyCommand(
    project,
    { type: "set-visibility", screenId, objectId, visible: false },
    "edit",
  );
  project = applyCommand(
    project,
    {
      type: "update",
      screenId,
      objectId,
      patch: { name: "非表示の設備", x: 120 },
    },
    "edit",
  );
  expect(project.screens[0].objects[0]).toMatchObject({
    name: "非表示の設備",
    x: 120,
    visible: false,
  });
  expect(
    objectsInRange(
      project.screens[0].objects,
      { x: -100, y: -100 },
      { x: 2000, y: 2000 },
    ),
  ).not.toContain(objectId);
  project = applyCommand(
    project,
    { type: "move-many", screenId, objectIds: [objectId], dx: 10, dy: 0 },
    "edit",
  );
  expect(project.screens[0].objects[0].x).toBe(130);
});
it("all hidden objects and shared children remain valid data instead of being deleted", () => {
  let project = parseProject(JSON.stringify(processSample));
  for (const target of [...project.screens, ...project.symbols])
    for (const object of target.objects) object.visible = false;
  project = parseProject(serializeProject(project));
  expect(project.screens[0].objects).toHaveLength(
    processSample.screens[0].objects.length,
  );
  expect(project.symbols[0].objects).toHaveLength(
    processSample.symbols[0].objects.length,
  );
  expect(
    objectsInRange(
      project.screens[0].objects,
      { x: -100, y: -100 },
      { x: 2000, y: 2000 },
    ),
  ).toEqual([]);
});
it("hidden copying, duplicate and cross-project paste preserve display state and locks", () => {
  let project = fresh();
  const screenId = project.screens[0].id,
    objectId = project.screens[0].objects[0].id;
  project = applyCommand(
    project,
    { type: "set-visibility", screenId, objectId, visible: false },
    "edit",
  );
  project = applyCommand(
    project,
    { type: "duplicate", screenId, objectId },
    "edit",
  );
  expect(project.screens[0].objects.at(-1)!.visible).toBe(false);
  project = applyCommand(
    project,
    { type: "set-lock", screenId, objectId, locked: true },
    "edit",
  );
  const text = copyObjects(project, screenId, [objectId], "source");
  expect(parseClipboard(text).project.screens[0].objects[0]).toMatchObject({
    visible: false,
    locked: true,
  });
  const pasted = applyCommand(
    project,
    {
      type: "paste",
      screenId,
      text,
      origin: "other",
      center: { x: 400, y: 300 },
    },
    "edit",
  );
  expect(pasted.screens[0].objects.at(-1)).toMatchObject({
    visible: false,
    locked: true,
  });
});
it("hidden usages stay indexed and retain exact tag references", () => {
  const project = parseProject(JSON.stringify(processSample));
  const pump = project.screens[0].objects[10],
    text = project.screens[0].objects[6];
  pump.visible = false;
  text.visible = false;
  if (text.shape.type !== "text") throw Error("not text");
  text.shape.binding = { externalName: "Exact.Hidden.Tag" };
  expect(symbolUsages(project, project.symbols[0].id)[0]).toMatchObject({
    objectId: pump.id,
    visible: false,
  });
  expect(bindingReferences(project)[0]).toMatchObject({
    externalName: "Exact.Hidden.Tag",
    usages: [{ objectId: text.id, visible: false }],
  });
});
