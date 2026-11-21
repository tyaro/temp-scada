// Issue #306 E1: 面の図形（矩形・楕円・多角形）を接続先にした回帰。Symbol 配置の規則
// （connections.test.ts）と同じ削除・ロック・group・複製・頂点の編集を図形で確かめる。
import { expect, it } from "vitest";
import sample from "../../../../examples/connection.project.json";
import cases from "../../../../examples/connection-cases.json";
import {
  parseProject,
  serializeProject,
  type PolylineObject,
  type Project,
} from "./project";
import { applyCommand, type EditCommand } from "./editor";
import { objectToWorld } from "./rotation";
import { connectionAnchorPoint } from "./connection-geometry";
import { connectionUsages, resolveConnectionObjects } from "./connections";
import { reframedPolygonVertex } from "./polygon-frame";
import { lineConnectionCommand } from "./designer/forms/line-connection";

/** 契約ケース（菱形の多角形の top へ始点）に、終点側を矩形にした Project。 */
function fresh(): Project {
  const project: any = structuredClone(sample);
  const diamond = cases.find(
    (c) => c.name === "polygon-diamond-matches-frame-midpoint",
  )!;
  for (const patch of diamond.patches) {
    const keys = patch.path.slice(1).split("/");
    let parent: any = project;
    for (const key of keys.slice(0, -1)) parent = parent[key];
    parent[keys.at(-1)!] = structuredClone(patch.value);
  }
  const box = project.screens[0].objects[1];
  delete box.fill;
  box.shape = structuredClone(project.screens[0].objects[0].shape);
  box.shape.type = "rectangle";
  delete box.shape.points;
  return parseProject(JSON.stringify(project));
}
const screenId = sample.screens[0].id;
const [polygon, box, pipe] = sample.screens[0].objects.map((o) => o.id);
const edit = (project: Project, command: object) =>
  applyCommand(project, { screenId, ...command } as EditCommand, "edit");
const line = (project: Project): PolylineObject => {
  const object = project.screens[0].objects.find((o) => o.id === pipe)!;
  if (object.shape.type !== "polyline") throw Error();
  return object as PolylineObject;
};
const positions = (project: Project) =>
  line(project).shape.points.map((p) => objectToWorld(line(project), p));
const target = (project: Project, id: string) =>
  project.screens[0].objects.find((o) => o.id === id) as any;

it("follows polygon vertex edits with the reframed shape, identically during the drag and on commit", () => {
  const project = fresh();
  expect(positions(project)[0]).toEqual({ x: 140, y: 200 });
  const object = target(project, polygon);
  const point = { x: 40, y: -20 };
  const preview = reframedPolygonVertex(object, 0, point);
  if (!preview.ok) throw Error(preview.reason);
  const during = resolveConnectionObjects(
    project.screens[0].objects.map((o) =>
      o.id === polygon ? preview.object : o,
    ),
  ).find((o) => o.id === pipe)!;
  const committed = edit(project, {
    type: "move-vertex",
    objectId: polygon,
    index: 0,
    point,
  });
  expect(during).toEqual(line(committed));
  expect(positions(committed)[0]).toEqual({ x: 140, y: 180 });
  expect(positions(committed).slice(1)).toEqual(positions(project).slice(1));
  // 作り直しが拒否される形（隣り合う頂点が同じ）は、途中も確定も受け付けない。
  expect(reframedPolygonVertex(object, 0, { x: 80, y: 20 }).ok).toBe(false);
  expect(() =>
    edit(project, {
      type: "move-vertex",
      objectId: polygon,
      index: 0,
      point: { x: 80, y: 20 },
    }),
  ).toThrow();
});
it("tracks rectangle resize, and protects area targets from deletion without the referring line", () => {
  const project = fresh(),
    before = serializeProject(project);
  const resized = edit(project, {
    type: "update",
    objectId: box,
    patch: { y: 280, height: 100 },
  });
  expect(positions(resized).at(-1)).toEqual({ x: 360, y: 330 });
  expect(connectionUsages(project.screens[0], polygon)).toHaveLength(1);
  expect(connectionUsages(project.screens[0], box)).toHaveLength(1);
  for (const command of [
    { type: "remove", objectId: polygon },
    { type: "remove-many", objectIds: [box] },
  ])
    expect(() => edit(project, command)).toThrow(/接続先/);
  expect(
    edit(project, { type: "remove-many", objectIds: [polygon, pipe] })
      .screens[0].objects,
  ).toHaveLength(1);
  expect(serializeProject(project)).toBe(before);
});
it("rejects area target edits that would change a locked line, but not paint or name edits", () => {
  const locked = edit(fresh(), {
    type: "set-lock",
    objectId: pipe,
    locked: true,
  });
  const before = serializeProject(locked);
  for (const command of [
    { type: "move-many", objectIds: [box], dx: 40, dy: 0 },
    {
      type: "move-vertex",
      objectId: polygon,
      index: 0,
      point: { x: 40, y: -20 },
    },
  ])
    expect(() => edit(locked, command)).toThrow(/ロック/);
  expect(
    target(
      edit(locked, {
        type: "update",
        objectId: polygon,
        patch: { name: "新しい箱" },
      }),
      polygon,
    ).name,
  ).toBe("新しい箱");
  expect(serializeProject(locked)).toBe(before);
});
it("lets grouped area targets rotate with the line following, and still rejects grouping the line", () => {
  const project = fresh();
  const grouped = edit(project, {
    type: "group",
    objectIds: [polygon, box],
  });
  const rotated = edit(grouped, {
    type: "rotate-groups",
    objectIds: [polygon, box],
    delta: 90,
  });
  const after = positions(rotated);
  expect(after.slice(1, -1)).toEqual(positions(project).slice(1, -1));
  const anchor = connectionAnchorPoint(target(rotated, polygon), "top");
  expect(after[0].x).toBeCloseTo(anchor.x, 9);
  expect(after[0].y).toBeCloseTo(anchor.y, 9);
  expect(() =>
    edit(project, { type: "group", objectIds: [box, pipe] }),
  ).toThrow(/グループ/);
});
it("rewires array copies and screen copies to the copied area targets", () => {
  const project = fresh();
  const objects = edit(project, {
    type: "duplicate-array",
    objectIds: [polygon, box, pipe],
    columns: 2,
    rows: 1,
    stepX: 150,
    stepY: 0,
  }).screens[0].objects;
  const copy = objects[5];
  if (copy.shape.type !== "polyline") throw Error();
  expect(copy.shape.connections).toEqual({
    start: { targetObjectId: objects[3].id, anchor: "top" },
    end: { targetObjectId: objects[4].id, anchor: "left" },
  });
  const screen = applyCommand(
    project,
    { type: "duplicate-screen", screenId },
    "edit",
  ).screens[1];
  const screenLine = screen.objects[2];
  if (screenLine.shape.type !== "polyline") throw Error();
  expect(screenLine.shape.connections?.start?.targetObjectId).toBe(
    screen.objects[0].id,
  );
  expect(screen.objects[0].shape.type).toBe("polygon");
});
it("connects and disconnects an area target through the Inspector form command", () => {
  const project = fresh(),
    screen = project.screens[0];
  const context = {
    generation: 1,
    screenId,
    definition: false,
    selected: screen.objects[2],
    objects: screen.objects,
  };
  const input = (values: Record<string, string>) => ({
    connected: true,
    objectId: pipe,
    targetKey: `1:${screenId}:false`,
    endpoint: "end",
    data: { get: (key: string) => values[key] ?? null },
  });
  const reconnected = edit(
    project,
    lineConnectionCommand(
      input({ connectionTarget: polygon, connectionAnchor: "right" }),
      context,
    ),
  );
  expect(positions(reconnected).at(-1)).toEqual({ x: 180, y: 220 });
  const disconnected = edit(
    project,
    lineConnectionCommand(input({ connectionTarget: "" }), context),
  );
  expect(connectionUsages(disconnected.screens[0], box)).toHaveLength(0);
  expect(positions(disconnected)).toEqual(positions(project));
  expect(target(disconnected, box)).toEqual(target(project, box));
});
