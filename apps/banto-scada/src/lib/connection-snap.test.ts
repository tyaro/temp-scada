// Issue #306 E3: 線の端のドラッグで anchor へ吸着する判定と、確定の 1 回の Undo。
import { expect, it } from "vitest";
import sample from "../../../../examples/connection.project.json";
import { parseProject, type PolylineObject, type Project } from "./project";
import { applyCommand } from "./editor";
import { objectToWorld } from "./rotation";
import { connectionAnchorPoint } from "./connection-geometry";
import {
  findConnectionSnap,
  snappableEndpoint,
  withConnection,
} from "./connection-snap";

/** 見本の線から接続を外し、終点を (300, 320) へ置いた画面。 */
function fresh(): Project {
  const project: any = structuredClone(sample);
  const line = project.screens[0].objects[2];
  delete line.shape.connections;
  line.shape.points[3] = { x: 300, y: 320 };
  return parseProject(JSON.stringify(project));
}
const screenOf = (project: Project) => project.screens[0];
const lineOf = (project: Project) =>
  screenOf(project).objects[2] as PolylineObject;
const pump2 = (project: Project) => screenOf(project).objects[1] as any;

it("半径の中の最も近い anchor へ吸着し、外では吸着しない", () => {
  const project = fresh();
  const objects = screenOf(project).objects;
  const left = connectionAnchorPoint(pump2(project), "left"); // (360, 320)
  const near = findConnectionSnap(
    objects,
    lineOf(project),
    "end",
    { x: left.x - 5, y: left.y + 3 },
    12,
  );
  expect(near).toEqual({
    endpoint: "end",
    connection: { targetObjectId: pump2(project).id, anchor: "left" },
    point: left,
  });
  expect(
    findConnectionSnap(
      objects,
      lineOf(project),
      "end",
      { x: left.x - 13, y: left.y },
      12,
    ),
  ).toBeNull();
});

it("同じ距離なら前面の配置、次に anchor の順を選ぶ", () => {
  const project = fresh();
  const objects = screenOf(project).objects as any[];
  // ポンプ2 と同じ枠の矩形を前面に重ねる。
  const box = {
    ...structuredClone(objects[1]),
    id: "0199fd00-0000-7000-8000-0000000000aa",
    order: 9,
    shape: { type: "rectangle" },
  };
  delete box.fill;
  const snap = findConnectionSnap(
    [...objects, box],
    lineOf(project),
    "end",
    { x: 400, y: 320 }, // 中心。ほかの anchor は 20 以上離れる。
    30,
  );
  expect(snap?.connection).toEqual({
    targetObjectId: box.id,
    anchor: "center",
  });
});

it("非表示の配置・線自身・接続先でない配置は候補にしない", () => {
  const project = fresh();
  const objects = screenOf(project).objects.map((o, i) =>
    i === 1 ? { ...o, visible: false } : o,
  );
  expect(
    findConnectionSnap(objects, lineOf(project), "end", { x: 360, y: 320 }, 12),
  ).toBeNull();
});

it("両端が同じ点になる候補は除く", () => {
  const project: any = structuredClone(sample);
  const line = project.screens[0].objects[2];
  line.shape.points = [
    { x: 180, y: 220 },
    { x: 200, y: 220 },
  ];
  line.shape.connections = {
    start: {
      targetObjectId: project.screens[0].objects[0].id,
      anchor: "right",
    },
  };
  const parsed = parseProject(JSON.stringify(project));
  const objects = screenOf(parsed).objects;
  // 終点を始点と同じ anchor へ寄せても吸着しない。
  expect(
    findConnectionSnap(objects, lineOf(parsed), "end", { x: 182, y: 220 }, 12),
  ).toBeNull();
});

it("吸着の対象は画面直下の線の接続していない端だけ", () => {
  const project = fresh();
  const screen = screenOf(project);
  const line = lineOf(project);
  expect(snappableEndpoint(screen, line, 0)).toBe("start");
  expect(snappableEndpoint(screen, line, 3)).toBe("end");
  expect(snappableEndpoint(screen, line, 1)).toBeUndefined();
  expect(
    snappableEndpoint(screen, { ...line, locked: true }, 0),
  ).toBeUndefined();
  const connected = withConnection(line, {
    endpoint: "start",
    connection: { targetObjectId: screen.objects[0].id, anchor: "right" },
    point: { x: 180, y: 220 },
  });
  expect(snappableEndpoint(screen, connected, 0)).toBeUndefined();
  const grouped = {
    ...screen,
    groups: [{ id: "g", memberIds: [line.id, screen.objects[0].id] }],
  } as any;
  expect(snappableEndpoint(grouped, line, 0)).toBeUndefined();
});

it("確定は set-line-connection 1 回で端点が anchor へ移り、Undo 1 回で戻る", () => {
  const project = fresh();
  const line = lineOf(project);
  const snap = findConnectionSnap(
    screenOf(project).objects,
    line,
    "end",
    { x: 357, y: 318 },
    12,
  )!;
  const result = applyCommand(
    project,
    {
      type: "set-line-connection",
      screenId: screenOf(project).id,
      objectId: line.id,
      endpoint: snap.endpoint,
      connection: snap.connection,
    },
    "edit",
  );
  const next = lineOf(result);
  expect(next.shape.connections?.end).toEqual(snap.connection);
  expect(objectToWorld(next, next.shape.points[3])).toEqual(snap.point);
  // 中間の頂点は world の位置を保つ。
  expect(objectToWorld(next, next.shape.points[2])).toEqual(
    objectToWorld(line, line.shape.points[2]),
  );
  // 編集の前の Project は変わらない（Undo はこの 1 件を戻す）。
  expect(lineOf(project).shape.connections).toBeUndefined();
});
