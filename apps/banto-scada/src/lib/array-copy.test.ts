import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import metadata from "../../../../examples/equipment-property.project.json";
import { applyCommand } from "./editor";
import { parseProject, serializeProject } from "./project";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { validateArrayCopy } from "./array-copy";
const fresh = () => parseProject(JSON.stringify(sample));
const settings = { columns: 3, rows: 2, stepX: 125.5, stepY: -73.25 };
it("copies row-major while retaining original coordinates, names, order and one Undo", () => {
  const project = fresh(),
    screen = project.screens[0],
    original = serializeProject(project);
  const edit = {
    type: "duplicate-array" as const,
    screenId: screen.id,
    objectIds: screen.objects.map((o) => o.id),
    ...settings,
  };
  const result = recordEdit(project, emptyHistory(), edit, "edit");
  expect(result.project.screens[0].objects).toHaveLength(18);
  expect(result.project.screens[0].objects.slice(0, 3)).toEqual(screen.objects);
  const order = Math.max(...screen.objects.map((o) => o.order)) + 1;
  for (let index = 1; index < 6; index++)
    for (let objectIndex = 0; objectIndex < 3; objectIndex++) {
      const object = result.project.screens[0].objects[index * 3 + objectIndex],
        source = screen.objects[objectIndex];
      expect(object.id).not.toBe(source.id);
      expect(object.x).toBe(source.x + (index % 3) * settings.stepX);
      expect(object.y).toBe(source.y + Math.floor(index / 3) * settings.stepY);
      expect({
        ...object,
        id: source.id,
        x: source.x,
        y: source.y,
        order: source.order,
      }).toEqual(source);
      expect(object.order).toBe(order + (index - 1) * 3 + objectIndex);
    }
  expect(new Set(result.project.screens[0].objects.map((o) => o.id)).size).toBe(
    18,
  );
  expect(
    travelHistory(result.project, result.history, "undo", "edit").project
      .screens,
  ).toEqual(project.screens);
  expect(serializeProject(project)).toBe(original);
});
it("each copied group gets its own membership and intact relative geometry", () => {
  let project = fresh();
  const screen = project.screens[0];
  project = applyCommand(
    project,
    {
      type: "group",
      screenId: screen.id,
      objectIds: screen.objects.slice(0, 2).map((o) => o.id),
    },
    "edit",
  );
  const next = applyCommand(
    project,
    {
      type: "duplicate-array",
      screenId: screen.id,
      objectIds: screen.objects.map((o) => o.id),
      ...settings,
    },
    "edit",
  );
  expect(next.screens[0].groups).toHaveLength(6);
  expect(new Set(next.screens[0].groups.map((g) => g.id)).size).toBe(6);
  for (let index = 0; index < 6; index++)
    expect(next.screens[0].groups[index].memberIds).toEqual(
      next.screens[0].objects.slice(index * 3, index * 3 + 2).map((o) => o.id),
    );
  expect(() =>
    applyCommand(
      project,
      {
        type: "duplicate-array",
        screenId: screen.id,
        objectIds: [screen.objects[0].id],
        ...settings,
      },
      "edit",
    ),
  ).toThrow(/グループ/);
});
it("copies equipment placements as the same equipment and preserves metadata declarations", () => {
  const project = parseProject(JSON.stringify(metadata)),
    screen = project.screens[0],
    definition = project.symbols[0];
  const next = applyCommand(
    project,
    {
      type: "duplicate-array",
      screenId: screen.id,
      objectIds: [screen.objects[0].id],
      columns: 2,
      rows: 1,
      stepX: 300,
      stepY: 0,
    },
    "edit",
  );
  expect(next.equipment).toEqual(project.equipment);
  expect(next.symbols).toEqual(project.symbols);
  expect(next.screens[0].objects.at(-1)!.shape).toEqual(
    screen.objects[0].shape,
  );
  const text = definition.objects.at(-1)!;
  const copied = applyCommand(
    project,
    {
      type: "duplicate-array",
      screenId: screen.id,
      definitionId: definition.id,
      objectIds: [text.id],
      columns: 2,
      rows: 1,
      stepX: 20,
      stepY: 0,
    },
    "edit",
  );
  expect(copied.symbols[0].objects.at(-1)!.shape).toEqual(text.shape);
  expect(copied.screens).toEqual(project.screens);
});
it("remaps bool state-color references inside each independent copy", () => {
  const project = parseProject(JSON.stringify(metadata)),
    definition = project.symbols[0];
  const source = definition.objects[5],
    line = definition.objects[0];
  if (source.shape.type !== "text" || line.shape.type !== "polyline")
    throw new Error("fixture");
  source.shape.boolColors = {
    trueColor: "#00ff00",
    falseColor: "#888888",
    unknownColor: "#999999",
  };
  line.shape.stateColor = { textId: source.id };
  const next = applyCommand(
    project,
    {
      type: "duplicate-array",
      screenId: project.screens[0].id,
      definitionId: definition.id,
      objectIds: [source.id, line.id],
      columns: 3,
      rows: 1,
      stepX: 25,
      stepY: 0,
    },
    "edit",
  );
  const copies = next.symbols[0].objects.slice(definition.objects.length);
  for (let index = 0; index < 2; index++)
    expect(copies[index * 2].shape).toMatchObject({
      stateColor: { textId: copies[index * 2 + 1].id },
    });
});
it("validates cell and placement budgets, steps, lock and mode atomically", () => {
  const project = fresh(),
    screen = project.screens[0],
    before = serializeProject(project);
  const base = {
    type: "duplicate-array" as const,
    screenId: screen.id,
    objectIds: screen.objects.map((o) => o.id),
    ...settings,
  };
  for (const change of [
    { columns: 0 },
    { rows: 1.5 },
    { columns: 101 },
    { columns: 1, rows: 1 },
    { stepX: 0 },
    { stepY: 0 },
    { stepX: Infinity },
    { columns: 100, rows: 1, stepX: 1e308 },
  ])
    expect(() =>
      applyCommand(project, { ...base, ...change }, "edit"),
    ).toThrow();
  expect(() =>
    applyCommand(project, { ...base, objectIds: [] }, "edit"),
  ).toThrow();
  expect(() =>
    applyCommand(project, { ...base, objectIds: ["missing"] }, "edit"),
  ).toThrow();
  expect(() => applyCommand(project, base, "preview")).toThrow();
  expect(serializeProject(project)).toBe(before);
  screen.objects[0].locked = true;
  expect(() => applyCommand(project, base, "edit")).toThrow(/ロック/);
  expect(() =>
    validateArrayCopy(
      { columns: 100, rows: 1, stepX: 10, stepY: 0 },
      20,
      20,
      1000,
    ),
  ).toThrow(/上限/);
  expect(() =>
    validateArrayCopy(
      { columns: 100, rows: 1, stepX: 10, stepY: 0 },
      2,
      2,
      100,
    ),
  ).toThrow(/上限/);
  expect(
    validateArrayCopy({ columns: 1, rows: 2, stepX: 0, stepY: -10 }, 1, 1, 100),
  ).toBe(1);
});
it("reuses image asset, fit and crop without adding or modifying originals", () => {
  let project = fresh(),
    screen = project.screens[0];
  const asset = {
    id: "019a0000-0000-7000-8000-000000009700",
    sha256: "0".repeat(64),
    mime: "image/png" as const,
    byteLength: 100,
    width: 400,
    height: 200,
    name: "設備.png",
  };
  project = applyCommand(
    project,
    {
      type: "add-image",
      screenId: screen.id,
      asset,
      frame: { x: 20, y: 20, width: 200, height: 100 },
    },
    "edit",
  );
  const object = project.screens[0].objects.at(-1)!;
  project = applyCommand(
    project,
    {
      type: "set-image-crop",
      screenId: screen.id,
      objectId: object.id,
      crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.7 },
    },
    "edit",
  );
  const next = applyCommand(
    project,
    {
      type: "duplicate-array",
      screenId: screen.id,
      objectIds: [object.id],
      columns: 3,
      rows: 1,
      stepX: 30,
      stepY: 0,
    },
    "edit",
  );
  expect(next.assets).toEqual(project.assets);
  expect(next.assets).toHaveLength(1);
  expect(next.screens[0].objects.at(-1)!.shape).toEqual(
    project.screens[0].objects.at(-1)!.shape,
  );
});
it("refuses the whole array when embedded View count exceeds 32 without adding history", () => {
  const project = fresh(),
    owner = project.screens[0];
  const source = {
    ...structuredClone(owner),
    id: "019a0000-0000-7000-8000-000000009900",
    name: "参照元",
  };
  owner.objects = [];
  project.screens.push(source);
  const prepared = applyCommand(
    project,
    {
      type: "add-screen-view",
      screenId: owner.id,
      sourceScreenId: source.id,
      frame: { x: 0, y: 0, width: 400, height: 300 },
    },
    "edit",
  );
  const view = prepared.screens[0].objects[0],
    before = serializeProject(prepared),
    history = emptyHistory();
  expect(() =>
    recordEdit(
      prepared,
      history,
      {
        type: "duplicate-array",
        screenId: owner.id,
        objectIds: [view.id],
        columns: 33,
        rows: 1,
        stepX: 20,
        stepY: 0,
      },
      "edit",
    ),
  ).toThrow();
  expect(serializeProject(prepared)).toBe(before);
  expect(history.past).toHaveLength(0);
});
