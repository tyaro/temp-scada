// Issue #306 E4: クリックで頂点を足して線を描く作図と、add-polyline の確定。
import { expect, it } from "vitest";
import sample from "../../../../examples/connection.project.json";
import { parseProject, type PolylineObject, type Project } from "./project";
import { applyCommand } from "./editor";
import { objectToWorld } from "./rotation";
import {
  clickDraft,
  constrainToAxis,
  draftPointer,
  emptyDraft,
  finishDraft,
  removeLastVertex,
  type DrawPointer,
  type LineDraft,
} from "./line-drawing";

/** 見本から線を除いた画面（ポンプ1 の right は (180,220)、ポンプ2 の left は (360,320)）。 */
function fresh(): Project {
  const project: any = structuredClone(sample);
  project.screens[0].objects = project.screens[0].objects.slice(0, 2);
  return parseProject(JSON.stringify(project));
}
const screenOf = (project: Project) => project.screens[0];
const pump = (project: Project, index: number) =>
  screenOf(project).objects[index];
function at(
  x: number,
  y: number,
  extra: Partial<DrawPointer> = {},
): DrawPointer {
  return {
    grid: { x: Math.round(x / 10) * 10, y: Math.round(y / 10) * 10 },
    raw: { x, y },
    shift: false,
    noSnap: false,
    radius: 12,
    repeatRadius: 5,
    ...extra,
  };
}

it("始点・終点を anchor へ吸着させ、途中はグリッドの点を足す", () => {
  const project = fresh();
  const objects = screenOf(project).objects;
  let draft: LineDraft = emptyDraft("pipe");
  let step = clickDraft(draft, objects, at(184, 223));
  expect(step.finished).toBeNull();
  expect(step.draft.points).toEqual([{ x: 180, y: 220 }]);
  expect(step.draft.start).toEqual({
    targetObjectId: pump(project, 0).id,
    anchor: "right",
  });
  draft = clickDraft(step.draft, objects, at(268, 222)).draft;
  draft = clickDraft(draft, objects, at(271, 318)).draft;
  expect(draft.points).toEqual([
    { x: 180, y: 220 },
    { x: 270, y: 220 },
    { x: 270, y: 320 },
  ]);
  step = clickDraft(draft, objects, at(355, 317));
  expect(step.draft).toEqual(emptyDraft("pipe"));
  expect(step.finished).toEqual({
    kind: "pipe",
    points: [
      { x: 180, y: 220 },
      { x: 270, y: 220 },
      { x: 270, y: 320 },
      { x: 360, y: 320 },
    ],
    connections: {
      start: { targetObjectId: pump(project, 0).id, anchor: "right" },
      end: { targetObjectId: pump(project, 1).id, anchor: "left" },
    },
  });
});

it("Alt と Symbol 定義では吸着しない", () => {
  const project = fresh();
  const objects = screenOf(project).objects;
  const draft = emptyDraft("line");
  expect(
    clickDraft(draft, objects, at(184, 223, { noSnap: true })).draft,
  ).toEqual({ kind: "line", points: [{ x: 180, y: 220 }] });
  expect(clickDraft(draft, null, at(184, 223)).draft.start).toBeUndefined();
  expect(draftPointer(draft, objects, at(250, 250)).snap).toBeNull();
});

it("終点の候補は始点の接続を含めて検査し、解決できない anchor を除く", () => {
  const project = fresh();
  const objects = screenOf(project).objects;
  // 2 点の線で始点と同じ anchor へ終点を寄せても吸着しない（両端が同じ点になる）。
  const draft = clickDraft(emptyDraft("line"), objects, at(180, 220)).draft;
  expect(draft.start?.anchor).toBe("right");
  expect(draftPointer(draft, objects, at(182, 221)).snap).toBeNull();
});

it("直前の頂点の再クリック（ダブルクリック）で確定し、2 点未満では確定しない", () => {
  const project = fresh();
  const objects = screenOf(project).objects;
  let draft = clickDraft(emptyDraft("line"), objects, at(100, 400)).draft;
  // 1 点だけで同じ所をもう一度押しても確定しない。
  const single = clickDraft(draft, objects, at(101, 401));
  expect(single.finished).toBeNull();
  expect(single.draft.points).toHaveLength(1);
  draft = clickDraft(draft, objects, at(200, 400)).draft;
  const done = clickDraft(draft, objects, at(201, 402));
  expect(done.finished?.points).toEqual([
    { x: 100, y: 400 },
    { x: 200, y: 400 },
  ]);
  expect(done.finished?.connections).toEqual({});
});

it("Shift は直前の頂点から水平・垂直へそろえる", () => {
  expect(constrainToAxis({ x: 0, y: 0 }, { x: 50, y: 20 })).toEqual({
    x: 50,
    y: 0,
  });
  expect(constrainToAxis({ x: 0, y: 0 }, { x: 20, y: -50 })).toEqual({
    x: 0,
    y: -50,
  });
  const draft = clickDraft(emptyDraft("line"), null, at(100, 100)).draft;
  expect(
    draftPointer(draft, null, at(160, 130, { shift: true })).point,
  ).toEqual({ x: 160, y: 100 });
});

it("最後の頂点を消し、始点を消すと始点の接続も消える。続けて同じ点は確定で除く", () => {
  const project = fresh();
  const objects = screenOf(project).objects;
  const draft = clickDraft(emptyDraft("line"), objects, at(180, 220)).draft;
  expect(removeLastVertex(draft)).toEqual(emptyDraft("line"));
  expect(
    finishDraft({
      kind: "line",
      points: [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    })?.points,
  ).toEqual([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ]);
  expect(
    finishDraft({
      kind: "line",
      points: [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ],
    }),
  ).toBeNull();
});

it("add-polyline は 1 回の編集で接続つきの線を置く（Undo は前の Project に戻す）", () => {
  const project = fresh();
  const objects = screenOf(project).objects;
  let draft = clickDraft(emptyDraft("pipe"), objects, at(184, 223)).draft;
  draft = clickDraft(draft, objects, at(270, 220)).draft;
  const finished = clickDraft(draft, objects, at(270, 318)).finished;
  expect(finished).toBeNull();
  const line = clickDraft(
    clickDraft(draft, objects, at(270, 318)).draft,
    objects,
    at(357, 321),
  ).finished!;
  const result = applyCommand(
    project,
    {
      type: "add-polyline",
      screenId: screenOf(project).id,
      kind: line.kind,
      points: line.points,
      connections: line.connections,
    },
    "edit",
  );
  const added = screenOf(result).objects.at(-1) as PolylineObject;
  expect(added.shape.type).toBe("polyline");
  expect(added.shape.strokeWidth).toBe(8);
  expect(added.shape.connections).toEqual(line.connections);
  expect(added.shape.points.map((p) => objectToWorld(added, p))).toEqual(
    line.points,
  );
  expect(screenOf(project).objects).toHaveLength(2);
});

it("add-polyline は 2 点未満と Symbol 定義の中の接続を拒否する", () => {
  const project = fresh();
  const screenId = screenOf(project).id;
  expect(() =>
    applyCommand(
      project,
      {
        type: "add-polyline",
        screenId,
        kind: "line",
        points: [
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ],
      },
      "edit",
    ),
  ).toThrow("異なる2点");
  const withSymbol = applyCommand(
    project,
    { type: "create-symbol", name: "箱", width: 100, height: 100 },
    "edit",
  );
  const definition = withSymbol.symbols.at(-1)!;
  expect(() =>
    applyCommand(
      withSymbol,
      {
        type: "add-polyline",
        screenId: definition.id,
        definitionId: definition.id,
        kind: "line",
        points: [
          { x: 0, y: 0 },
          { x: 50, y: 0 },
        ],
        connections: {
          start: { targetObjectId: pump(project, 0).id, anchor: "right" },
        },
      } as any,
      "edit",
    ),
  ).toThrow("Symbol定義内の配管接続");
});
