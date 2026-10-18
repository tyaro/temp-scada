import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import { parseProject, getBounds } from "./project";
import { applyCommand, type AlignMode } from "./editor";
import { recordEdit, emptyHistory, travelHistory } from "./history";
const fresh = () => parseProject(JSON.stringify(sample));
it("moves a selection with one revision and undoes the whole move atomically", () => {
  const project = fresh(),
    screenId = project.screens[0].id,
    objectIds = project.screens[0].objects.slice(0, 2).map((o) => o.id);
  const result = recordEdit(
    project,
    emptyHistory(),
    { type: "move-many", screenId, objectIds, dx: 25.5, dy: -10 },
    "edit",
  );
  expect(result.project.manifest.projectRevision).toBe(2);
  expect(result.history.past).toHaveLength(1);
  expect(result.project.screens[0].objects[0]).toMatchObject({
    x: 125.5,
    y: 160,
  });
  expect(result.project.screens[0].objects[1]).toMatchObject({
    x: 595.5,
    y: 180,
  });
  expect(result.project.screens[0].objects[2]).toEqual(
    project.screens[0].objects[2],
  );
  expect(
    travelHistory(result.project, result.history, "undo", "edit").project
      .screens,
  ).toEqual(project.screens);
});
for (const [alignment, first, second] of [
  ["left", { x: 100, y: 170 }, { x: 100, y: 200 }],
  ["right", { x: 450, y: 170 }, { x: 570, y: 200 }],
  ["center-x", { x: 275, y: 170 }, { x: 335, y: 200 }],
  ["top", { x: 100, y: 170 }, { x: 570, y: 170 }],
  ["bottom", { x: 100, y: 170 }, { x: 570, y: 210 }],
  ["center-y", { x: 100, y: 170 }, { x: 570, y: 190 }],
] as const)
  it(`aligns ${alignment} to the union bounds and leaves nonselected objects unchanged`, () => {
    const project = fresh();
    project.screens[0].objects[1].y = 200;
    const screenId = project.screens[0].id,
      objectIds = project.screens[0].objects.slice(0, 2).map((o) => o.id);
    const result = applyCommand(
      project,
      { type: "align", screenId, objectIds, alignment: alignment as AlignMode },
      "edit",
    );
    expect(result.screens[0].objects[0]).toMatchObject(first);
    expect(result.screens[0].objects[1]).toMatchObject(second);
    expect(result.screens[0].objects[2]).toEqual(project.screens[0].objects[2]);
    expect(result.manifest.projectRevision).toBe(2);
    expect(
      applyCommand(
        result,
        { type: "align", screenId, objectIds, alignment },
        "edit",
      ),
    ).toBe(result);
  });
it("includes negative local pipe bounds and stroke in alignment", () => {
  const project = fresh(),
    screenId = project.screens[0].id;
  const added = applyCommand(
    project,
    { type: "add", screenId, kind: "pipe" },
    "edit",
  );
  const pipe = added.screens[0].objects.at(-1)!;
  const modified = applyCommand(
    added,
    {
      type: "update",
      screenId,
      objectId: pipe.id,
      patch: {
        points: [
          { x: -20, y: 0 },
          { x: 80, y: 0 },
        ],
        strokeWidth: 4,
      },
    },
    "edit",
  );
  const objectIds = [modified.screens[0].objects[0].id, pipe.id];
  const result = applyCommand(
    modified,
    { type: "align", screenId, objectIds, alignment: "left" },
    "edit",
  );
  const [rectangle, line] = [
    result.screens[0].objects[0],
    result.screens[0].objects.at(-1)!,
  ];
  expect(rectangle.x + getBounds(rectangle).x).toBe(18);
  expect(line.x + getBounds(line).x).toBe(18);
});
it("duplicates and removes a selection in one edit while sharing Symbol definitions", () => {
  const project = fresh(),
    screenId = project.screens[0].id;
  const one = applyCommand(
    project,
    { type: "add-symbol", screenId, template: "pump" },
    "edit",
  );
  const two = applyCommand(
    one,
    { type: "add-symbol", screenId, template: "valve" },
    "edit",
  );
  const objectIds = two.screens[0].objects
    .slice(-2)
    .map((o) => o.id)
    .reverse();
  const duplicated = recordEdit(
    two,
    emptyHistory(),
    { type: "duplicate-many", screenId, objectIds },
    "edit",
  );
  const copies = duplicated.project.screens[0].objects.slice(-2);
  expect(copies.map((o) => o.shape)).toEqual(
    two.screens[0].objects.slice(-2).map((o) => o.shape),
  );
  expect(copies.every((o) => !objectIds.includes(o.id))).toBe(true);
  expect(copies.map((o) => o.x)).toEqual([60, 60]);
  expect(duplicated.project.symbols).toEqual(two.symbols);
  expect(duplicated.project.manifest.projectRevision).toBe(4);
  expect(
    travelHistory(duplicated.project, duplicated.history, "undo", "edit")
      .project.screens,
  ).toEqual(two.screens);
  const removed = recordEdit(
    duplicated.project,
    duplicated.history,
    { type: "remove-many", screenId, objectIds: copies.map((o) => o.id) },
    "edit",
  );
  expect(removed.project.screens).toEqual(two.screens);
  expect(
    travelHistory(removed.project, removed.history, "undo", "edit").project
      .screens,
  ).toEqual(duplicated.project.screens);
});
it("rejects invalid batches without partial changes and treats zero movement as no-op", () => {
  const project = fresh(),
    screenId = project.screens[0].id,
    id = project.screens[0].objects[0].id;
  for (const objectIds of [[], [id, id], [id, "missing"]])
    expect(() =>
      applyCommand(
        project,
        { type: "move-many", screenId, objectIds, dx: 50, dy: 10 },
        "edit",
      ),
    ).toThrow();
  expect(() =>
    applyCommand(
      project,
      { type: "move-many", screenId, objectIds: [id], dx: Infinity, dy: 0 },
      "edit",
    ),
  ).toThrow();
  expect(() =>
    applyCommand(
      project,
      { type: "remove-many", screenId, objectIds: [id] },
      "preview",
    ),
  ).toThrow();
  expect(project).toEqual(fresh());
  expect(
    applyCommand(
      project,
      { type: "move-many", screenId, objectIds: [id], dx: 0, dy: 0 },
      "edit",
    ),
  ).toBe(project);
});
