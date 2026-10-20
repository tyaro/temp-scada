import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import {
  parseProject,
  getBounds,
  serializeProject,
  type ScreenObject,
} from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { selectionUnits, unitBounds } from "./geometric-groups";
const fresh = () => parseProject(JSON.stringify(sample));
function fixture(axis: "x" | "y" = "x") {
  const project = fresh(),
    screen = project.screens[0],
    dimension = axis === "x" ? "width" : "height";
  screen.objects.forEach((object, index) => {
    if (!("width" in object)) throw new Error("fixture");
    object.rotation = 0;
    object[axis] = [0, 75, 320][index];
    object[dimension] = [40, 80, 60][index];
  });
  return project;
}
function command(project: ReturnType<typeof fresh>, axis: "x" | "y" = "x") {
  return {
    type: "distribute-gaps" as const,
    screenId: project.screens[0].id,
    objectIds: project.screens[0].objects.map((o) => o.id),
    axis,
  };
}
function gaps(objects: ScreenObject[], axis: "x" | "y") {
  const dimension = axis === "x" ? "width" : "height";
  const bounds = objects
    .map((object) => {
      const b = getBounds(object);
      return { start: object[axis] + b[axis], size: b[dimension] };
    })
    .sort((a, b) => a.start + a.size / 2 - b.start - b.size / 2);
  return bounds
    .slice(1)
    .map((b, i) => b.start - bounds[i].start - bounds[i].size);
}
for (const axis of ["x", "y"] as const)
  it(`equalizes unequal ${axis} gaps and preserves endpoints, orthogonal geometry, no-op and one Undo`, () => {
    const original = fixture(axis),
      edit = command(original, axis);
    const result = recordEdit(original, emptyHistory(), edit, "edit");
    const before = original.screens[0].objects,
      after = result.project.screens[0].objects;
    expect(gaps(after, axis)[0]).toBeCloseTo(100, 10);
    expect(gaps(after, axis)[1]).toBeCloseTo(100, 10);
    expect(after[0]).toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
    expect({ ...after[1], [axis]: before[1][axis] }).toEqual(before[1]);
    expect(after[1][axis]).toBeCloseTo(140, 10);
    expect(applyCommand(result.project, edit, "edit")).toBe(result.project);
    expect(
      travelHistory(result.project, result.history, "undo", "edit").project
        .screens,
    ).toEqual(original.screens);
    expect(parseProject(serializeProject(result.project))).toEqual(
      result.project,
    );
  });
it("rejects overlapping target gaps, incomplete selections, bad axis, locked and preview as a whole", () => {
  const original = fixture(),
    edit = command(original);
  original.screens[0].objects[2].x = 100;
  const baseline = serializeProject(original);
  expect(() => applyCommand(original, edit, "edit")).toThrow(/収まりません/);
  expect(serializeProject(original)).toBe(baseline);
  expect(() =>
    applyCommand(
      original,
      { ...edit, objectIds: edit.objectIds.slice(0, 2) },
      "edit",
    ),
  ).toThrow(/3件/);
  expect(() =>
    applyCommand(original, { ...edit, axis: "bad" as "x" }, "edit"),
  ).toThrow(/方向/);
  expect(() =>
    applyCommand(
      original,
      { ...edit, objectIds: [edit.objectIds[0], edit.objectIds[0]] },
      "edit",
    ),
  ).toThrow(/重複/);
  original.screens[0].objects[0].locked = true;
  expect(() => applyCommand(original, edit, "edit")).toThrow(/ロック/);
  expect(() => applyCommand(fixture(), edit, "preview")).toThrow(
    /表示プレビュー/,
  );
});
it("uses rotated bounds and arrow padding, preserving shape and reference attributes", () => {
  let original = fixture();
  original = applyCommand(
    original,
    { type: "add", screenId: original.screens[0].id, kind: "pipe" },
    "edit",
  );
  const objects = original.screens[0].objects;
  objects[0].x = -200;
  objects[2].x = 900;
  objects[1].rotation = 37;
  const pipe = objects.at(-1)!;
  pipe.x = 500;
  pipe.y = -50;
  if (pipe.shape.type !== "polyline") throw new Error("fixture");
  pipe.shape.points = [
    { x: -30, y: -20 },
    { x: 40, y: 60 },
  ];
  pipe.shape.arrow = "end";
  pipe.rotation = 28;
  const next = applyCommand(original, command(original), "edit");
  const result = gaps(next.screens[0].objects, "x");
  for (const gap of result) expect(gap).toBeCloseTo(result[0], 9);
  next.screens[0].objects.forEach((object, index) =>
    expect({ ...object, x: objects[index].x }).toEqual(objects[index]),
  );
});
it("moves a group as one unit and keeps member offsets", () => {
  let original = fixture();
  const screenId = original.screens[0].id;
  original = applyCommand(
    original,
    {
      type: "duplicate",
      screenId,
      objectId: original.screens[0].objects[1].id,
    },
    "edit",
  );
  const objects = original.screens[0].objects;
  objects.at(-1)!.x = 115;
  objects[2].x = 500;
  objects[2].order = 100;
  original = applyCommand(
    original,
    { type: "group", screenId, objectIds: [objects[1].id, objects.at(-1)!.id] },
    "edit",
  );
  const next = applyCommand(original, command(original), "edit"),
    screen = next.screens[0];
  const bounds = selectionUnits(
    screen,
    screen.objects.map((o) => o.id),
  )
    .map((unit) => unitBounds(unit))
    .sort((a, b) => a.x - b.x);
  expect(bounds[1].x - bounds[0].x - bounds[0].width).toBeCloseTo(
    bounds[2].x - bounds[1].x - bounds[1].width,
    10,
  );
  expect(screen.objects[3].x - screen.objects[1].x).toBe(40);
  expect(screen.groups).toEqual(original.screens[0].groups);
  expect(applyCommand(next, command(next), "edit")).toBe(next);
  expect(() =>
    applyCommand(
      original,
      {
        ...command(original),
        objectIds: [objects[0].id, objects[1].id, objects[2].id],
      },
      "edit",
    ),
  ).toThrow(/グループ/);
});
it("supports zero gaps and finite extreme coordinates without span overflow", () => {
  const zero = fixture();
  zero.screens[0].objects[2].x = 120;
  expect(
    gaps(applyCommand(zero, command(zero), "edit").screens[0].objects, "x"),
  ).toEqual([0, 0]);
  const extreme = fixture();
  extreme.screens[0].objects[0].x = -1e308;
  extreme.screens[0].objects[2].x = 1e308;
  const next = applyCommand(extreme, command(extreme), "edit");
  expect(next.screens[0].objects[1].x).toBe(0);
  expect(applyCommand(next, command(next), "edit")).toBe(next);
});

it("changes definition children without touching placements or metadata references", () => {
  const project = fixture(),
    screen = project.screens[0];
  const definition = {
    id: "019a0000-0000-7000-8000-000000009600",
    name: "配置用の共有定義",
    folders: [],
    width: 600,
    height: 400,
    objects: screen.objects,
  };
  project.symbols.push(definition);
  screen.objects = [];
  const edit = {
    type: "distribute-gaps" as const,
    screenId: screen.id,
    definitionId: definition.id,
    objectIds: definition.objects.map((o) => o.id),
    axis: "x" as const,
  };
  const next = applyCommand(project, edit, "edit");
  expect(next.screens).toEqual(project.screens);
  expect(next.symbols[0].objects[1].x).toBeCloseTo(140, 10);
  expect(next.symbols[0].objects.map((o) => o.shape)).toEqual(
    definition.objects.map((o) => o.shape),
  );
  expect(applyCommand(next, edit, "edit")).toBe(next);
});

it("keeps 1000 tightly packed placements unchanged and corrects a perturbed middle without false negative gaps", () => {
  const project = fixture(),
    screen = project.screens[0],
    base = screen.objects[0];
  if (!("width" in base)) throw new Error("fixture");
  screen.objects = Array.from({ length: 1000 }, (_, index) => ({
    ...structuredClone(base),
    id: `019a0000-0000-7000-8000-${String(9700 + index).padStart(12, "0")}`,
    order: index,
    x: 900000 + index * 100,
    width: 100,
  }));
  const edit = command(project);
  expect(applyCommand(project, edit, "edit")).toBe(project);
  screen.objects[500].x += 0.125;
  const result = applyCommand(project, edit, "edit");
  expect(result.screens[0].objects[500].x).toBeCloseTo(950000, 8);
  expect(applyCommand(result, edit, "edit")).toBe(result);
});
