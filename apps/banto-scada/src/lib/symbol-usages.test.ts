import { expect, it } from "vitest";
import sample from "../../../../examples/process.project.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand } from "./editor";
import { symbolUsages } from "./symbol-usages";
const fresh = () => parseProject(JSON.stringify(sample));

it("finds exact definition references across screens without mutating geometry or saved order", () => {
  const initial = fresh();
  const project = applyCommand(
    initial,
    { type: "duplicate-screen", screenId: initial.screens[0].id },
    "edit",
  );
  const pump = project.symbols[0];
  const placement = project.screens[0].objects.find(
    (o) => o.shape.type === "symbol" && o.shape.symbolId === pump.id,
  )!;
  const before = serializeProject(project);
  const usages = symbolUsages(project, pump.id);
  expect(usages).toHaveLength(2);
  expect(usages.map((u) => u.screenId)).toEqual(
    project.screens.map((s) => s.id),
  );
  expect(new Set(usages.map((u) => u.objectId)).size).toBe(2);
  expect(
    usages.every(
      (u) =>
        u.symbolId === pump.id && u.x === placement.x && u.y === placement.y,
    ),
  ).toBe(true);
  expect(serializeProject(project)).toBe(before);
  expect(symbolUsages(project, pump.name)).toEqual([]);
});

it("follows stored screen and stacking order even when object array order differs", () => {
  const initial = fresh();
  const pump = initial.symbols[0];
  const placement = initial.screens[0].objects.find(
    (o) => o.shape.type === "symbol" && o.shape.symbolId === pump.id,
  )!;
  let project = applyCommand(
    initial,
    {
      type: "duplicate",
      screenId: initial.screens[0].id,
      objectId: placement.id,
    },
    "edit",
  );
  project = applyCommand(
    project,
    { type: "duplicate-screen", screenId: project.screens[0].id },
    "edit",
  );
  project = applyCommand(
    project,
    {
      type: "reorder-screen",
      screenId: project.screens[1].id,
      direction: "up",
    },
    "edit",
  );
  for (const screen of project.screens) screen.objects.reverse();
  const usages = symbolUsages(project, pump.id);
  expect(usages.map((u) => u.screenId)).toEqual([
    project.screens[0].id,
    project.screens[0].id,
    project.screens[1].id,
    project.screens[1].id,
  ]);
  expect(usages[0].order).toBeLessThan(usages[1].order);
});

it("independent copies and placement deletion update the impact scope without matching equal names", () => {
  const initial = fresh();
  const original = initial.symbols[0];
  const placement = initial.screens[0].objects.find(
    (o) => o.shape.type === "symbol" && o.shape.symbolId === original.id,
  )!;
  const project = applyCommand(
    initial,
    {
      type: "make-symbol-unique",
      screenId: initial.screens[0].id,
      objectId: placement.id,
    },
    "edit",
  );
  const copy = project.symbols.at(-1)!;
  copy.name = original.name;
  expect(symbolUsages(project, original.id)).toEqual([]);
  expect(symbolUsages(project, copy.id).map((u) => u.objectId)).toEqual([
    placement.id,
  ]);
  const removed = applyCommand(
    project,
    { type: "remove", screenId: project.screens[0].id, objectId: placement.id },
    "edit",
  );
  expect(symbolUsages(removed, copy.id)).toEqual([]);
});
