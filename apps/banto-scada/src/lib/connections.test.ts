import { expect, it } from "vitest";
import sample from "../../../../examples/connection.project.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand, newId, type EditCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { projectContent } from "./save-state";
import { copyObjects, parseClipboard } from "./clipboard";
import { objectToWorld } from "./rotation";
import { symbolAnchorPoint, sameConnectionPoint } from "./connection-geometry";
import { connectionUsages } from "./connections";
const fresh = () => parseProject(JSON.stringify(sample));
const screenId = sample.screens[0].id;
const [pump1, pump2, pipe] = sample.screens[0].objects.map((o) => o.id);
const edit = (project: ReturnType<typeof fresh>, command: object) =>
  applyCommand(project, { screenId, ...command } as EditCommand, "edit");
const positions = (project: ReturnType<typeof fresh>) => {
  const line = project.screens[0].objects.find((o) => o.id === pipe)!;
  if (line.shape.type !== "polyline") throw Error();
  return line.shape.points.map((p) => objectToWorld(line, p));
};
it("tracks target geometry while preserving world bends, input, no-op and one-action Undo", () => {
  const original = fresh(),
    before = positions(original),
    beforeText = serializeProject(original);
  const command = {
    type: "update" as const,
    screenId,
    objectId: pump1,
    patch: { x: 140, width: 130, rotation: 33 },
  };
  const result = recordEdit(original, emptyHistory(), command, "edit");
  const after = positions(result.project),
    target = result.project.screens[0].objects[0];
  expect(
    sameConnectionPoint(after[0], symbolAnchorPoint(target as any, "right")),
  ).toBe(true);
  expect(after.slice(1)).toEqual(before.slice(1));
  expect(result.history.past).toHaveLength(1);
  const undo = travelHistory(result.project, result.history, "undo", "edit");
  expect(projectContent(undo.project)).toBe(projectContent(original));
  expect(
    projectContent(
      travelHistory(undo.project, undo.history, "redo", "edit").project,
    ),
  ).toBe(projectContent(result.project));
  expect(edit(result.project, command)).toBe(result.project);
  expect(serializeProject(original)).toBe(beforeText);
});
it("moves both targets and the line without double-moving connected endpoints", () => {
  const project = fresh(),
    before = positions(project);
  const moved = edit(project, {
    type: "move-many",
    objectIds: [pump1, pump2, pipe],
    dx: 40,
    dy: -30,
  });
  expect(positions(moved)).toEqual(
    before.map((p) => ({ x: p.x + 40, y: p.y - 30 })),
  );
});
it("allows middle-vertex editing but rejects direct connected-endpoint mutations", () => {
  const project = fresh();
  const moved = edit(project, {
    type: "move-vertex",
    objectId: pipe,
    index: 1,
    point: { x: 280, y: 260 },
  });
  expect(positions(moved)[0]).toEqual(positions(project)[0]);
  expect(positions(moved)[1]).toEqual({ x: 280, y: 260 });
  for (const index of [0, 3])
    expect(() =>
      edit(project, {
        type: "move-vertex",
        objectId: pipe,
        index,
        point: { x: 0, y: 0 },
      }),
    ).toThrow(/解除/);
  expect(() =>
    edit(project, {
      type: "update",
      objectId: pipe,
      patch: {
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      },
    }),
  ).toThrow(/解除/);
});
it("disconnects explicitly without changing the visible shape and reconnects through one command", () => {
  const project = fresh();
  const disconnected = edit(project, {
    type: "set-line-connection",
    objectId: pipe,
    endpoint: "start",
    connection: null,
  });
  expect(positions(disconnected)).toEqual(positions(project));
  expect(connectionUsages(disconnected.screens[0], pump1)).toHaveLength(0);
  const connected = edit(disconnected, {
    type: "set-line-connection",
    objectId: pipe,
    endpoint: "start",
    connection: { targetObjectId: pump2, anchor: "top" },
  });
  expect(positions(connected)[0]).toEqual({ x: 400, y: 300 });
  expect(connectionUsages(connected.screens[0], pump2)).toHaveLength(2);
});
it("protects deletion and cut preflight, but permits removing the target and every referring line together", () => {
  const project = fresh(),
    before = serializeProject(project);
  for (const command of [
    { type: "remove", objectId: pump1 },
    { type: "remove-many", objectIds: [pump2] },
  ])
    expect(() => edit(project, command)).toThrow(/接続先/);
  const removed = edit(project, {
    type: "remove-many",
    objectIds: [pump1, pipe],
  });
  expect(removed.screens[0].objects).toHaveLength(1);
  expect(serializeProject(project)).toBe(before);
});
it("rejects a target move that would change a locked line, while permitting target paint and name edits", () => {
  const locked = edit(fresh(), {
    type: "set-lock",
    objectId: pipe,
    locked: true,
  });
  const before = serializeProject(locked);
  expect(() =>
    edit(locked, { type: "move-many", objectIds: [pump1], dx: 40, dy: 0 }),
  ).toThrow(/ロック/);
  expect(
    edit(locked, {
      type: "update",
      objectId: pump1,
      patch: { name: "新しい名前", fill: "#ff0000" },
    }).screens[0].objects[0].name,
  ).toBe("新しい名前");
  expect(serializeProject(locked)).toBe(before);
});
it("allows grouped targets to transform, but rejects grouping a connected line atomically", () => {
  const project = fresh();
  const grouped = edit(project, { type: "group", objectIds: [pump1, pump2] });
  const rotated = edit(grouped, {
    type: "rotate-groups",
    objectIds: [pump1, pump2],
    delta: 90,
  });
  expect(positions(rotated)[1]).toEqual(positions(project)[1]);
  expect(() =>
    edit(project, { type: "group", objectIds: [pump2, pipe] }),
  ).toThrow(/グループ/);
});
it("rewires each array-copy set internally, and detaches connections outside single-line copies", () => {
  const project = fresh();
  const copied = edit(project, {
    type: "duplicate-array",
    objectIds: [pump1, pump2, pipe],
    columns: 2,
    rows: 2,
    stepX: 150,
    stepY: 120,
  });
  const objects = copied.screens[0].objects;
  expect(objects).toHaveLength(12);
  for (let offset = 3; offset < 12; offset += 3) {
    const line = objects[offset + 2];
    if (line.shape.type !== "polyline") throw Error();
    expect(line.shape.connections?.start?.targetObjectId).toBe(
      objects[offset].id,
    );
    expect(line.shape.connections?.end?.targetObjectId).toBe(
      objects[offset + 1].id,
    );
  }
  for (const command of [
    { type: "duplicate", objectId: pipe },
    { type: "duplicate-many", objectIds: [pipe] },
  ]) {
    const line = edit(project, command).screens[0].objects.at(-1)!;
    expect(line.shape).not.toHaveProperty("connections");
  }
  expect(
    edit(project, {
      type: "duplicate",
      objectId: pump1,
    }).screens[0].objects.find((o) => o.id === pipe)?.shape,
  ).toEqual(project.screens[0].objects[2].shape);
});
it("retains only copy-set connections through clipboard and paste into a different Project", () => {
  const project = fresh(),
    before = serializeProject(project);
  for (const ids of [[pipe], [pump1, pipe], [pump1, pump2, pipe]]) {
    const text = copyObjects(project, screenId, ids, "origin");
    const fragment = parseClipboard(text);
    const clipboardLine = fragment.project.screens[0].objects.find(
      (o) => o.shape.type === "polyline",
    )!;
    expect(
      "connections" in clipboardLine.shape &&
        !!clipboardLine.shape.connections?.start,
    ).toBe(ids.includes(pump1));
    expect(
      "connections" in clipboardLine.shape &&
        !!clipboardLine.shape.connections?.end,
    ).toBe(ids.includes(pump2));
    const target = fresh();
    target.manifest.projectId = newId();
    const pasted = edit(target, {
      type: "paste",
      text,
      origin: "different",
      center: { x: 500, y: 200 },
    });
    const newObjects = pasted.screens[0].objects.slice(3),
      newLine = newObjects.find((o) => o.shape.type === "polyline")!;
    if (newLine.shape.type !== "polyline") throw Error();
    const newIds = new Set(newObjects.map((o) => o.id));
    for (const c of Object.values(newLine.shape.connections ?? {}))
      expect(newIds.has(c!.targetObjectId)).toBe(true);
    expect(parseProject(serializeProject(pasted))).toEqual(pasted);
  }
  expect(serializeProject(project)).toBe(before);
});
it("renews all screen-copy IDs and keeps both endpoints bound to the copied placements", () => {
  const project = fresh(),
    copy = applyCommand(project, { type: "duplicate-screen", screenId }, "edit")
      .screens[1];
  const line = copy.objects[2];
  if (line.shape.type !== "polyline") throw Error();
  expect(line.shape.connections?.start?.targetObjectId).toBe(
    copy.objects[0].id,
  );
  expect(line.shape.connections?.end?.targetObjectId).toBe(copy.objects[1].id);
  expect(
    copy.objects.every(
      (o) => !project.screens[0].objects.some((source) => source.id === o.id),
    ),
  ).toBe(true);
});
it("rejects missing/wrong target, malformed connection and preview commands without changing the Project", () => {
  const project = fresh(),
    before = serializeProject(project);
  const command = {
    type: "set-line-connection" as const,
    screenId,
    objectId: pipe,
    endpoint: "start" as const,
    connection: { targetObjectId: pump1, anchor: "right" as const },
  };
  for (const patch of [
    { connection: undefined },
    { endpoint: "middle" },
    { connection: { targetObjectId: pipe, anchor: "right" } },
    { connection: { targetObjectId: newId(), anchor: "right" } },
    { connection: { targetObjectId: pump1, anchor: "unknown" } },
  ])
    expect(() => edit(project, { ...command, ...patch })).toThrow();
  expect(() => applyCommand(project, command, "preview")).toThrow();
  expect(serializeProject(project)).toBe(before);
});
function viewFixture() {
  let project = applyCommand(
    fresh(),
    { type: "create-screen", name: "参照表示", width: 960, height: 540 },
    "edit",
  );
  const ownerId = project.screens[1].id;
  project = applyCommand(
    project,
    {
      type: "add-screen-view",
      screenId: ownerId,
      sourceScreenId: screenId,
      frame: { x: 0, y: 0, width: 960, height: 540 },
    },
    "edit",
  );
  const viewId = project.screens[1].objects[0].id;
  return {
    project,
    ownerId,
    text: copyObjects(project, ownerId, [viewId], "origin"),
  };
}
it("rewires connections inside an embedded-screen dependency without mixing root placement IDs", () => {
  const { text } = viewFixture();
  const target = fresh();
  target.manifest.projectId = newId();
  const pasted = edit(target, {
    type: "paste",
    text,
    origin: "different",
    center: { x: 500, y: 250 },
  });
  expect(pasted.screens).toHaveLength(2);
  const source = pasted.screens[1],
    line = source.objects[2];
  if (line.shape.type !== "polyline") throw Error();
  expect(line.shape.connections?.start?.targetObjectId).toBe(
    source.objects[0].id,
  );
  expect(line.shape.connections?.end?.targetObjectId).toBe(
    source.objects[1].id,
  );
  expect(
    source.objects.every(
      (o) => !pasted.screens[0].objects.some((root) => root.id === o.id),
    ),
  ).toBe(true);
  const view = pasted.screens[0].objects.at(-1)!;
  expect(view.shape).toMatchObject({ type: "screenView", screenId: source.id });
});
it("reuses the current embedded screen and its live connections instead of reviving an old clipboard snapshot", () => {
  const { project, ownerId, text } = viewFixture();
  const moved = edit(project, {
    type: "move-many",
    objectIds: [pump1],
    dx: 80,
    dy: 20,
  });
  const pasted = applyCommand(
    moved,
    {
      type: "paste",
      screenId: ownerId,
      text,
      origin: "origin",
      center: { x: 400, y: 200 },
    },
    "edit",
  );
  expect(pasted.screens).toHaveLength(2);
  expect(pasted.screens[0]).toEqual(moved.screens[0]);
  const views = pasted.screens[1].objects;
  expect(views).toHaveLength(2);
  expect(
    views.every(
      (o) => o.shape.type === "screenView" && o.shape.screenId === screenId,
    ),
  ).toBe(true);
  expect(positions(pasted)[0]).toEqual({ x: 260, y: 240 });
});
