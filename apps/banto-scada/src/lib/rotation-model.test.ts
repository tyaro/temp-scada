import { expect, it } from "vitest";
import sample from "../../../../examples/process.project.json";
import cases from "../../../../examples/rotation-cases.json";
import { parseProject, getBounds, getLocalBounds } from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit } from "./history";
import { objectToWorld } from "./rotation";
it("shares required canonical angles across every saved object and definition with Rust", () => {
  for (const owner of ["screens", "symbols"] as const)
    for (let i = 0; i < sample[owner][0].objects.length; i++)
      for (const entry of cases) {
        const project: any = structuredClone(sample);
        if ("missing" in entry) delete project[owner][0].objects[i].rotation;
        else project[owner][0].objects[i].rotation = entry.angle;
        if (entry.valid)
          expect(parseProject(JSON.stringify(project))).toEqual(project);
        else expect(() => parseProject(JSON.stringify(project))).toThrow();
      }
  const old: any = structuredClone(sample);
  old.manifest.schemaVersion = old.manifest.minRuntimeVersion = "0.10.0";
  expect(() => parseProject(JSON.stringify(old))).toThrow();
});
it("normalizes edits, preserves geometry and symbols, and treats full turns as no-op", () => {
  const project = parseProject(JSON.stringify(sample)),
    owner = project.screens[0],
    object = owner.objects.find((o) => o.shape.type === "symbol")!;
  const command = {
    type: "update" as const,
    screenId: owner.id,
    objectId: object.id,
    patch: { rotation: -90 },
  };
  const next = applyCommand(project, command, "edit");
  expect(next.screens[0].objects.find((o) => o.id === object.id)).toEqual({
    ...object,
    rotation: 270,
  });
  expect(next.symbols).toEqual(project.symbols);
  expect(
    recordEdit(
      next,
      emptyHistory(),
      { ...command, patch: { rotation: 630 } },
      "edit",
    ).project,
  ).toBe(next);
  let turned = project;
  for (let i = 1; i <= 4; i++)
    turned = applyCommand(
      turned,
      { ...command, patch: { rotation: 90 * i } },
      "edit",
    );
  expect(turned.screens).toEqual(project.screens);
  for (const rotation of [NaN, Infinity, -Infinity])
    expect(() =>
      applyCommand(project, { ...command, patch: { rotation } }, "edit"),
    ).toThrow();
  object.locked = true;
  expect(() => applyCommand(project, command, "edit")).toThrow(/ロック/);
});
it("definition rotation is isolated and painted bounds rotate around the declared layout center", () => {
  const project = parseProject(JSON.stringify(sample)),
    owner = project.symbols[0],
    object = owner.objects[0];
  const next = applyCommand(
    project,
    {
      type: "update",
      screenId: project.screens[0].id,
      definitionId: owner.id,
      objectId: object.id,
      patch: { rotation: 33 },
    },
    "edit",
  );
  expect(next.screens).toEqual(project.screens);
  expect(next.symbols[0].objects[0].rotation).toBe(33);
  expect(next.symbols[0].objects.slice(1)).toEqual(owner.objects.slice(1));
  const rectangle = project.screens[0].objects.find(
    (o) => o.shape.type === "rectangle",
  )!;
  rectangle.rotation = 90;
  const local = getLocalBounds(rectangle),
    painted = getBounds(rectangle);
  expect(painted.width).toBe(local.height);
  expect(painted.height).toBe(local.width);
});
it("vertex command compensates a changed pivot and keeps all other world points fixed", () => {
  const project = parseProject(JSON.stringify(sample)),
    owner = project.screens[0],
    object = owner.objects.find((o) => o.shape.type === "polyline")!;
  if (object.shape.type !== "polyline") throw new Error();
  object.rotation = 33;
  const before = object.shape.points
    .slice(1)
    .map((point) =>
      objectToWorld(
        object as typeof object & { shape: typeof object.shape },
        point,
      ),
    );
  const next = applyCommand(
    project,
    {
      type: "move-vertex",
      screenId: owner.id,
      objectId: object.id,
      index: 0,
      point: { x: -25, y: 40 },
    },
    "edit",
  );
  const updated = next.screens[0].objects.find((o) => o.id === object.id)!;
  if (updated.shape.type !== "polyline") throw new Error();
  updated.shape.points.slice(1).forEach((point, i) => {
    const world = objectToWorld(
      updated as typeof updated & { shape: typeof updated.shape },
      point,
    );
    expect(world.x).toBeCloseTo(before[i].x, 9);
    expect(world.y).toBeCloseTo(before[i].y, 9);
  });
});
