import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import { parseProject } from "./project";
import { applyCommand } from "./editor";
const fresh = () => parseProject(JSON.stringify(sample));
it("adds UUID v7 objects, changes geometry and removes without changing the input", () => {
  const original = fresh();
  const screenId = original.screens[0].id;
  const added = applyCommand(
    original,
    { type: "add", screenId, kind: "rectangle" },
    "edit",
  );
  const object = added.screens[0].objects.at(-1)!;
  expect(original).toEqual(fresh());
  expect(added.manifest.projectRevision).toBe(2);
  expect(object.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const moved = applyCommand(
    added,
    {
      type: "update",
      screenId,
      objectId: object.id,
      patch: { x: 12.5, width: 200, fill: "#ffffff" },
    },
    "edit",
  );
  expect(moved.screens[0].objects.at(-1)).toMatchObject({
    id: object.id,
    x: 12.5,
    width: 200,
    fill: "#ffffff",
  });
  const removed = applyCommand(
    moved,
    { type: "remove", screenId, objectId: object.id },
    "edit",
  );
  expect(removed.screens).toEqual(original.screens);
  expect(removed.manifest.projectRevision).toBe(4);
});
it("rejects invalid edits atomically and preview mutations", () => {
  const original = fresh();
  const screenId = original.screens[0].id;
  const objectId = original.screens[0].objects[0].id;
  expect(() =>
    applyCommand(
      original,
      { type: "update", screenId, objectId, patch: { width: 0 } },
      "edit",
    ),
  ).toThrow();
  expect(() =>
    applyCommand(original, { type: "remove", screenId, objectId }, "preview"),
  ).toThrow("プレビュー");
  expect(original).toEqual(fresh());
});
it("edits text and rejects a missing target", () => {
  const original = fresh();
  const screenId = original.screens[0].id;
  const text = original.screens[0].objects[2];
  expect(
    applyCommand(
      original,
      { type: "update", screenId, objectId: text.id, patch: { text: "槽 A" } },
      "edit",
    ).screens[0].objects[2].shape,
  ).toEqual({ type: "text", text: "槽 A" });
  expect(() =>
    applyCommand(
      original,
      { type: "remove", screenId, objectId: "missing" },
      "edit",
    ),
  ).toThrow();
});

it("reuses one Symbol definition for multiple independent instances", () => {
  const project = fresh();
  const screenId = project.screens[0].id;
  const first = applyCommand(
    project,
    { type: "add-symbol", screenId, template: "pump" },
    "edit",
  );
  const second = applyCommand(
    first,
    { type: "add-symbol", screenId, template: "pump" },
    "edit",
  );
  expect(second.symbols).toHaveLength(1);
  const instances = second.screens[0].objects.slice(-2);
  expect(instances[0].id).not.toBe(instances[1].id);
  expect(instances[0].shape).toEqual(instances[1].shape);
  const moved = applyCommand(
    second,
    {
      type: "update",
      screenId,
      objectId: instances[1].id,
      patch: { x: 350, width: 140 },
    },
    "edit",
  );
  expect(moved.screens[0].objects.at(-2)!.x).toBe(40);
  expect(moved.symbols).toEqual(second.symbols);
});
it("edits pipe geometry and rejects degenerate paths without mutating input", () => {
  const project = fresh();
  const screenId = project.screens[0].id;
  const added = applyCommand(
    project,
    { type: "add", screenId, kind: "pipe" },
    "edit",
  );
  const objectId = added.screens[0].objects.at(-1)!.id;
  const edited = applyCommand(
    added,
    {
      type: "update",
      screenId,
      objectId,
      patch: {
        points: [
          { x: -20, y: 0 },
          { x: 100, y: 0 },
        ],
        strokeWidth: 6,
        arrow: "end",
      },
    },
    "edit",
  );
  expect(edited.screens[0].objects.at(-1)!.shape).toMatchObject({
    strokeWidth: 6,
    arrow: "end",
  });
  expect(() =>
    applyCommand(
      added,
      {
        type: "update",
        screenId,
        objectId,
        patch: {
          points: [
            { x: 0, y: 0 },
            { x: 0, y: 0 },
          ],
        },
      },
      "edit",
    ),
  ).toThrow();
  expect(added.screens[0].objects.at(-1)!.shape).toMatchObject({
    strokeWidth: 8,
    arrow: "none",
  });
});
it("duplicates only a Symbol placement and independently clones pipe vertices", () => {
  const project = fresh(),
    screenId = project.screens[0].id;
  const symbol = applyCommand(
    project,
    { type: "add-symbol", screenId, template: "pump" },
    "edit",
  );
  const original = symbol.screens[0].objects.at(-1)!;
  const copied = applyCommand(
    symbol,
    { type: "duplicate", screenId, objectId: original.id },
    "edit",
  );
  const clone = copied.screens[0].objects.at(-1)!;
  expect(clone.id).not.toBe(original.id);
  expect(clone.x).toBe(original.x + 20);
  expect(clone.shape).toEqual(original.shape);
  expect(copied.symbols).toEqual(symbol.symbols);
  const pipe = applyCommand(
    project,
    { type: "add", screenId, kind: "pipe" },
    "edit",
  );
  const pipeId = pipe.screens[0].objects.at(-1)!.id;
  const pipes = applyCommand(
    pipe,
    { type: "duplicate", screenId, objectId: pipeId },
    "edit",
  );
  const edited = applyCommand(
    pipes,
    {
      type: "update",
      screenId,
      objectId: pipes.screens[0].objects.at(-1)!.id,
      patch: {
        points: [
          { x: 0, y: 0 },
          { x: 50, y: 100 },
        ],
      },
    },
    "edit",
  );
  expect(edited.screens[0].objects.find((o) => o.id === pipeId)!.shape).toEqual(
    pipe.screens[0].objects.at(-1)!.shape,
  );
});
it("reorders by explicit order while preserving IDs and ignoring boundary no-ops", () => {
  const project = fresh(),
    screenId = project.screens[0].id,
    objectId = project.screens[0].objects[0].id;
  const front = applyCommand(
    project,
    { type: "reorder", screenId, objectId, direction: "front" },
    "edit",
  );
  expect(front.screens[0].objects.at(-1)!.id).toBe(objectId);
  expect(new Set(front.screens[0].objects.map((o) => o.order)).size).toBe(3);
  expect(
    applyCommand(
      front,
      { type: "reorder", screenId, objectId, direction: "front" },
      "edit",
    ),
  ).toBe(front);
  const backward = applyCommand(
    front,
    { type: "reorder", screenId, objectId, direction: "backward" },
    "edit",
  );
  expect(backward.screens[0].objects[1].id).toBe(objectId);
  const back = applyCommand(
    backward,
    { type: "reorder", screenId, objectId, direction: "back" },
    "edit",
  );
  expect(back.screens[0].objects[0].id).toBe(objectId);
  const forward = applyCommand(
    back,
    { type: "reorder", screenId, objectId, direction: "forward" },
    "edit",
  );
  expect(forward.screens[0].objects[1].id).toBe(objectId);
  expect([...forward.screens[0].objects.map((o) => o.id)].sort()).toEqual(
    project.screens[0].objects.map((o) => o.id).sort(),
  );
});
it("moves one polyline vertex atomically and rejects invalid or degenerate edits", () => {
  const project = fresh(),
    screenId = project.screens[0].id;
  const line = applyCommand(
    project,
    { type: "add", screenId, kind: "line" },
    "edit",
  );
  const objectId = line.screens[0].objects.at(-1)!.id;
  const moved = applyCommand(
    line,
    {
      type: "move-vertex",
      screenId,
      objectId,
      index: 1,
      point: { x: 100, y: 30 },
    },
    "edit",
  );
  expect(moved.screens[0].objects.at(-1)!.shape).toMatchObject({
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 30 },
    ],
  });
  expect(moved.manifest.projectRevision).toBe(
    line.manifest.projectRevision + 1,
  );
  for (const index of [-1, 0.5, 2])
    expect(() =>
      applyCommand(
        line,
        {
          type: "move-vertex",
          screenId,
          objectId,
          index,
          point: { x: 100, y: 0 },
        },
        "edit",
      ),
    ).toThrow();
  for (const point of [
    { x: 0, y: 0 },
    { x: Infinity, y: 0 },
    { x: 1000001, y: 0 },
  ])
    expect(() =>
      applyCommand(
        line,
        { type: "move-vertex", screenId, objectId, index: 1, point },
        "edit",
      ),
    ).toThrow();
  expect(() =>
    applyCommand(
      project,
      {
        type: "move-vertex",
        screenId,
        objectId: project.screens[0].objects[0].id,
        index: 0,
        point: { x: 100, y: 0 },
      },
      "edit",
    ),
  ).toThrow();
  expect(line.screens[0].objects.at(-1)!.shape).toMatchObject({
    points: [
      { x: 0, y: 0 },
      { x: 180, y: 0 },
    ],
  });
});
it("positions new placements around an explicit visible center in one edit", () => {
  const original = fresh(),
    screenId = original.screens[0].id;
  const rectangle = applyCommand(
    original,
    { type: "add", screenId, kind: "rectangle", center: { x: 600, y: 400 } },
    "edit",
  );
  expect(rectangle.screens[0].objects.at(-1)).toMatchObject({
    x: 520,
    y: 350,
    width: 160,
    height: 100,
  });
  expect(rectangle.manifest.projectRevision).toBe(
    original.manifest.projectRevision + 1,
  );
  const pipe = applyCommand(
    original,
    { type: "add", screenId, kind: "pipe", center: { x: 600, y: 400 } },
    "edit",
  );
  expect(pipe.screens[0].objects.at(-1)).toMatchObject({ x: 480, y: 350 });
  const pump = applyCommand(
    original,
    {
      type: "add-symbol",
      screenId,
      template: "pump",
      center: { x: 600, y: 400 },
    },
    "edit",
  );
  const symbolId = pump.symbols[0].id;
  const placed = applyCommand(
    pump,
    { type: "place-symbol", screenId, symbolId, center: { x: 250, y: 150 } },
    "edit",
  );
  expect(placed.screens[0].objects.at(-1)).toMatchObject({
    x: 200,
    y: 100,
    width: 100,
    height: 100,
  });
  expect(placed.symbols).toEqual(pump.symbols);
});
it("rejects invalid placement centers without leaving a partially added symbol", () => {
  const original = fresh(),
    screenId = original.screens[0].id;
  expect(() =>
    applyCommand(
      original,
      {
        type: "add-symbol",
        screenId,
        template: "pump",
        center: { x: NaN, y: 100 },
      },
      "edit",
    ),
  ).toThrow("配置先");
  expect(original).toEqual(fresh());
});
