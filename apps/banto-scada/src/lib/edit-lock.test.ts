import { expect, it } from "vitest";
import cases from "../../../../examples/edit-lock-cases.json";
import sample from "../../../../examples/minimal.project.json";
import processSample from "../../../../examples/process.project.json";
import { parseProject, serializeProject, type Project } from "./project";
import { applyCommand, type EditCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { objectsInRange } from "./range-selection";
import { copyObjects, parseClipboard } from "./clipboard";
const fresh = () => parseProject(JSON.stringify(sample));
function lock(project: Project, objectId: string) {
  return applyCommand(
    project,
    {
      type: "set-lock",
      screenId: project.screens[0].id,
      objectId,
      locked: true,
    },
    "edit",
  );
}
for (const test of cases)
  it(`edit lock contract: ${test.name}`, () => {
    for (const path of [
      ["screens", 0, "objects", 2],
      ["screens", 0, "objects", 7],
      ["screens", 0, "objects", 10],
      ["symbols", 0, "objects", 0],
    ] as const) {
      const value: any = structuredClone(processSample);
      value[path[0]][path[1]][path[2]][path[3]].locked = test.value;
      if (test.valid) {
        const project = parseProject(JSON.stringify(value));
        expect(parseProject(serializeProject(project))).toEqual(project);
      } else expect(() => parseProject(JSON.stringify(value))).toThrow();
    }
  });
it("lock/unlock is guarded, undoable, idempotent, and an optional false baseline", () => {
  const project = fresh(),
    screenId = project.screens[0].id,
    objectId = project.screens[0].objects[0].id;
  let result = recordEdit(
    project,
    emptyHistory(),
    { type: "set-lock", screenId, objectId, locked: true },
    "edit",
  );
  expect(result.project.screens[0].objects[0]).toEqual({
    ...project.screens[0].objects[0],
    locked: true,
  });
  expect(
    applyCommand(
      result.project,
      { type: "set-lock", screenId, objectId, locked: true },
      "edit",
    ),
  ).toBe(result.project);
  result = recordEdit(
    result.project,
    result.history,
    { type: "set-lock", screenId, objectId, locked: false },
    "edit",
  );
  expect(result.project.screens[0].objects[0]).not.toHaveProperty("locked");
  result = travelHistory(result.project, result.history, "undo", "edit");
  expect(result.project.screens[0].objects[0].locked).toBe(true);
  expect(() =>
    applyCommand(
      result.project,
      { type: "set-lock", screenId, objectId, locked: false },
      "preview",
    ),
  ).toThrow();
});
it("rejects every direct mutation and mixed operation atomically without changing revisions or input", () => {
  let project = fresh();
  const screenId = project.screens[0].id,
    objectId = project.screens[0].objects[0].id,
    otherId = project.screens[0].objects[1].id;
  project = lock(project, objectId);
  const before = serializeProject(project);
  const commands: EditCommand[] = [
    { type: "update", screenId, objectId, patch: { name: "new", x: 42 } },
    { type: "remove", screenId, objectId },
    { type: "duplicate", screenId, objectId },
    { type: "reorder", screenId, objectId, direction: "front" },
    {
      type: "move-many",
      screenId,
      objectIds: [otherId, objectId],
      dx: 10,
      dy: 5,
    },
    { type: "remove-many", screenId, objectIds: [otherId, objectId] },
    { type: "duplicate-many", screenId, objectIds: [otherId, objectId] },
    {
      type: "align",
      screenId,
      objectIds: [otherId, objectId],
      alignment: "left",
    },
  ];
  for (const command of commands) {
    expect(() => applyCommand(project, command, "edit")).toThrow(/ロック/);
    expect(serializeProject(project)).toBe(before);
  }
  expect(() =>
    applyCommand(
      project,
      {
        type: "update",
        screenId,
        objectId,
        patch: { locked: false, x: 42 } as any,
      },
      "edit",
    ),
  ).toThrow(/ロック/);
  const renamed = applyCommand(
    project,
    {
      type: "update",
      screenId,
      objectId: otherId,
      patch: { name: "unlocked" },
    },
    "edit",
  );
  expect(renamed.screens[0].objects[1].name).toBe("unlocked");
});
it("excludes locked bounds from range selection but permits order renumbering when another placement is reordered", () => {
  let project = fresh();
  const screen = project.screens[0],
    locked = screen.objects[0],
    other = screen.objects[1];
  project = lock(project, locked.id);
  expect(
    objectsInRange(
      project.screens[0].objects,
      { x: -100, y: -100 },
      { x: 2000, y: 2000 },
    ),
  ).not.toContain(locked.id);
  const moved = applyCommand(
    project,
    {
      type: "reorder",
      screenId: screen.id,
      objectId: other.id,
      direction: "back",
    },
    "edit",
  );
  expect(
    moved.screens[0].objects.find((object) => object.id === locked.id),
  ).toEqual({
    ...project.screens[0].objects[0],
    order: 1,
  });
});
it("locked Symbol instances still share live definitions; locked children reject geometry and vertex changes", () => {
  let project = parseProject(JSON.stringify(processSample));
  const screenId = project.screens[0].id,
    pump = project.screens[0].objects[10],
    definitionId = project.symbols[0].id,
    childId = project.symbols[0].objects[0].id;
  project = lock(project, pump.id);
  expect(() =>
    applyCommand(
      project,
      { type: "make-symbol-unique", screenId, objectId: pump.id },
      "edit",
    ),
  ).toThrow(/ロック/);
  project = applyCommand(
    project,
    {
      type: "update",
      screenId: definitionId,
      definitionId,
      objectId: childId,
      patch: { fill: "#aabbcc" },
    },
    "edit",
  );
  expect(project.screens[0].objects[10].locked).toBe(true);
  expect(project.symbols[0].objects[0].fill).toBe("#aabbcc");
  project = applyCommand(
    project,
    {
      type: "set-lock",
      screenId: definitionId,
      definitionId,
      objectId: childId,
      locked: true,
    },
    "edit",
  );
  expect(() =>
    applyCommand(
      project,
      {
        type: "move-vertex",
        screenId: definitionId,
        definitionId,
        objectId: childId,
        index: 0,
        point: { x: 0, y: 0 },
      },
      "edit",
    ),
  ).toThrow(/ロック/);
  expect(() =>
    applyCommand(
      project,
      {
        type: "update",
        screenId: definitionId,
        definitionId,
        objectId: childId,
        patch: { fill: "#ffffff" },
      },
      "edit",
    ),
  ).toThrow(/ロック/);
});
it("copy and cross-project paste preserve locks and names without granting permission to cut", () => {
  let project = fresh();
  const screenId = project.screens[0].id,
    objectId = project.screens[0].objects[0].id;
  project = applyCommand(
    project,
    { type: "update", screenId, objectId, patch: { name: "保護した配置" } },
    "edit",
  );
  project = lock(project, objectId);
  const text = copyObjects(project, screenId, [objectId], "source");
  expect(parseClipboard(text).project.screens[0].objects[0].locked).toBe(true);
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
  const object = pasted.screens[0].objects.at(-1)!;
  expect(object.name).toBe("保護した配置");
  expect(object.locked).toBe(true);
  expect(object.id).not.toBe(objectId);
  expect(() =>
    applyCommand(project, { type: "remove", screenId, objectId }, "edit"),
  ).toThrow(/ロック/);
});
