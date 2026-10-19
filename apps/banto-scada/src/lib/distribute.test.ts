import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import { applyCommand, type EditCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import {
  getBounds,
  parseProject,
  serializeProject,
  type ScreenObject,
} from "./project";
const fresh = () => parseProject(JSON.stringify(sample));
function center(object: ScreenObject, axis: "x" | "y") {
  const bounds = getBounds(object);
  return (
    object[axis] +
    bounds[axis] +
    (axis === "x" ? bounds.width : bounds.height) / 2
  );
}
it("distributes unequal objects by centers, fixes endpoints and preserves the orthogonal geometry", () => {
  const original = fresh(),
    screen = original.screens[0];
  screen.objects[0].x = -350;
  screen.objects[1].x = 600;
  const command = {
    type: "distribute" as const,
    screenId: screen.id,
    objectIds: screen.objects.map((o) => o.id),
    axis: "x" as const,
  };
  const result = applyCommand(original, command, "edit");
  const sorted = [...result.screens[0].objects].sort(
    (a, b) => center(a, "x") - center(b, "x"),
  );
  expect(center(sorted[1], "x")).toBe(
    (center(sorted[0], "x") + center(sorted[2], "x")) / 2,
  );
  expect(result.screens[0].objects[0]).toEqual(screen.objects[0]);
  expect(result.screens[0].objects[1]).toEqual(screen.objects[1]);
  result.screens[0].objects.forEach((object, i) =>
    expect({ ...object, x: screen.objects[i].x }).toEqual(screen.objects[i]),
  );
  expect(applyCommand(result, command, "edit")).toBe(result);
  expect(original.manifest.projectRevision).toBe(1);
});
it("uses line bounds including negative points and arrow padding; retains IDs and supports Undo and JSON", () => {
  let original = fresh();
  const screenId = original.screens[0].id;
  original = applyCommand(
    original,
    { type: "add", screenId, kind: "pipe" },
    "edit",
  );
  const pipe = original.screens[0].objects.at(-1)!;
  if (pipe.shape.type !== "polyline") throw new Error("expected pipe");
  pipe.shape.points = [
    { x: -30, y: -80 },
    { x: 45, y: 60 },
  ];
  pipe.shape.arrow = "end";
  pipe.y = -120.25;
  const ids = original.screens[0].objects.map((o) => o.id);
  const command = {
    type: "distribute" as const,
    screenId,
    objectIds: ids,
    axis: "y" as const,
  };
  const result = recordEdit(original, emptyHistory(), command, "edit");
  const centers = result.project.screens[0].objects
    .map((o) => center(o, "y"))
    .sort((a, b) => a - b);
  for (let i = 1; i < centers.length; i++)
    expect(centers[i] - centers[i - 1]).toBeCloseTo(
      (centers.at(-1)! - centers[0]) / (centers.length - 1),
    );
  expect(result.history.past).toHaveLength(1);
  expect(
    result.project.screens[0].objects.some((object) => object.y % 1 !== 0),
  ).toBe(true);
  expect(applyCommand(result.project, command, "edit")).toBe(result.project);
  expect(parseProject(serializeProject(result.project))).toEqual(
    result.project,
  );
  expect(
    travelHistory(result.project, result.history, "undo", "edit").project
      .screens,
  ).toEqual(original.screens);
});
it("keeps coincident endpoints unchanged and orders tied inner centers by object order", () => {
  const original = fresh(),
    screen = original.screens[0];
  screen.objects.forEach((o) => {
    const b = getBounds(o);
    o.x = 100 - b.x - b.width / 2;
  });
  const command = {
    type: "distribute" as const,
    screenId: screen.id,
    objectIds: [...screen.objects].reverse().map((o) => o.id),
    axis: "x" as const,
  };
  expect(applyCommand(original, command, "edit")).toBe(original);
  let four = applyCommand(
    original,
    { type: "add", screenId: screen.id, kind: "rectangle" },
    "edit",
  );
  const objects = four.screens[0].objects;
  objects[0].x = -getBounds(objects[0]).width / 2;
  objects[3].x = 300 - getBounds(objects[3]).width / 2;
  four = applyCommand(
    four,
    { ...command, objectIds: [...objects].reverse().map((o) => o.id) },
    "edit",
  );
  expect(four.screens[0].objects.map((o) => center(o, "x"))).toEqual([
    0, 100, 200, 300,
  ]);
});
it("rejects insufficient, stale, duplicate, invalid-axis and locked selections atomically", () => {
  const original = fresh(),
    screenId = original.screens[0].id,
    ids = original.screens[0].objects.map((o) => o.id);
  const base = {
    type: "distribute" as const,
    screenId,
    objectIds: ids,
    axis: "x" as const,
  };
  const commands: EditCommand[] = [
    ...[
      [],
      ids.slice(0, 2),
      [ids[0], ids[0], ids[2]],
      [ids[0], ids[1], "missing"],
    ].map((objectIds) => ({ ...base, objectIds })),
    { ...base, axis: "z" as "x" },
  ];
  for (const command of commands)
    expect(() => applyCommand(original, command, "edit")).toThrow();
  original.screens[0].objects[1].locked = true;
  const before = serializeProject(original);
  expect(() => applyCommand(original, base, "edit")).toThrow("ロック");
  expect(() => applyCommand(original, base, "preview")).toThrow("プレビュー");
  expect(serializeProject(original)).toBe(before);
});
it("includes hidden targets in explicit distribution without changing their visibility", () => {
  const original = fresh(),
    screen = original.screens[0];
  screen.objects[0].visible = false;
  screen.objects[2].name = "計測値";
  const result = applyCommand(
    original,
    {
      type: "distribute",
      screenId: screen.id,
      objectIds: screen.objects.map((o) => o.id),
      axis: "x",
    },
    "edit",
  );
  expect(result.screens[0].objects[0].visible).toBe(false);
  expect(result.screens[0].objects[2].name).toBe("計測値");
});

it("distributes explicitly edited definition children without changing parent placements", () => {
  let original = fresh();
  const screenId = original.screens[0].id;
  original = applyCommand(
    original,
    { type: "add-symbol", screenId, template: "pump" },
    "edit",
  );
  const definition = original.symbols[0];
  const result = applyCommand(
    original,
    {
      type: "distribute",
      screenId: definition.id,
      definitionId: definition.id,
      objectIds: definition.objects.map((object) => object.id),
      axis: "x",
    },
    "edit",
  );
  expect(result.screens).toEqual(original.screens);
  const centers = result.symbols[0].objects
    .map((object) => center(object, "x"))
    .sort((a, b) => a - b);
  const step = (centers.at(-1)! - centers[0]) / (centers.length - 1);
  centers.forEach((value, index) =>
    expect(value).toBeCloseTo(centers[0] + step * index),
  );
});
