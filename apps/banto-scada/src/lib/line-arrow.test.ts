import { expect, it } from "vitest";
import { render } from "svelte/server";
import sample from "../../../../examples/process.project.json";
import cases from "../../../../examples/line-arrow-cases.json";
import { parseProject, getLayoutBounds, type PolylineObject } from "./project";
import { applyCommand } from "./editor";
import { arrowHeadPoints, arrowHeads, parseLineArrow } from "./line-arrow";
import { selectionLineCommand } from "./designer/forms/selection-line";
import Primitive from "./Primitive.svelte";

it("shares the arrow enum with Rust for screen and definition lines", () => {
  let checked = 0;
  for (const owner of ["screens", "symbols"] as const)
    for (let i = 0; i < sample[owner][0].objects.length; i++) {
      if (sample[owner][0].objects[i].shape.type !== "polyline") continue;
      for (const entry of cases) {
        const project: any = structuredClone(sample),
          shape = project[owner][0].objects[i].shape;
        if ("missing" in entry) delete shape.arrow;
        else shape.arrow = entry.value;
        if (entry.valid)
          expect(parseProject(JSON.stringify(project))).toEqual(project);
        else expect(() => parseProject(JSON.stringify(project))).toThrow();
      }
      checked++;
    }
  expect(checked).toBeGreaterThanOrEqual(2);
});

const line = (arrow: PolylineObject["shape"]["arrow"]) => ({
  points: [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 0 },
  ],
  strokeWidth: 2,
  arrow,
});

it("draws heads at the requested ends, skipping coincident vertices", () => {
  expect(arrowHeads(line("none"))).toEqual([]);
  expect(arrowHeads(line("end"))).toEqual(["100,0 92,4 92,-4"]);
  expect(arrowHeads(line("start"))).toEqual(["0,0 8,-4 8,4"]);
  expect(arrowHeads(line("both"))).toEqual([
    "0,0 8,-4 8,4",
    "100,0 92,4 92,-4",
  ]);
  // ドラッグ途中で全頂点が重なっても描画を保つ。
  expect(
    arrowHeads({
      points: [
        { x: 5, y: 5 },
        { x: 5, y: 5 },
      ],
      strokeWidth: 2,
      arrow: "both",
    }),
  ).toEqual([]);
  expect(arrowHeads({ points: [], strokeWidth: 2, arrow: "both" })).toEqual([]);
});

it("draws both heads of a returning pipe even when they coincide", () => {
  const shape = {
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 0 },
    ],
    strokeWidth: 2,
    arrow: "both" as const,
  };
  expect(arrowHeads(shape)).toEqual(["0,0 8,-4 8,4", "0,0 8,-4 8,4"]);
  const { body } = render(Primitive, {
    props: {
      object: {
        id: "0199f100-0000-7000-8000-00000000f001",
        order: 0,
        x: 0,
        y: 0,
        rotation: 0,
        fill: "#83bfcd",
        shape: { type: "polyline", ...shape },
      },
    },
  });
  expect(body.match(/<polygon/g)?.length).toBe(2);
});

it("pads bounds for any arrow and renders one polygon per head", () => {
  const object = (arrow: PolylineObject["shape"]["arrow"]): PolylineObject => ({
    id: "l",
    rotation: 0,
    order: 0,
    x: 0,
    y: 0,
    fill: "#123456",
    shape: { type: "polyline", ...line(arrow), strokeWidth: 4 },
  });
  expect(getLayoutBounds(object("none"))).toEqual({
    x: -2,
    y: -2,
    width: 104,
    height: 4,
  });
  for (const arrow of ["start", "end", "both"] as const)
    expect(getLayoutBounds(object(arrow))).toEqual({
      x: -12,
      y: -12,
      width: 124,
      height: 24,
    });
  for (const [arrow, count] of [
    ["none", 0],
    ["start", 1],
    ["end", 1],
    ["both", 2],
  ] as const) {
    const { body } = render(Primitive, { props: { object: object(arrow) } });
    expect(body.match(/<polygon/g)?.length ?? 0).toBe(count);
  }
});

it("keeps diagonal arrowheads inside the layout bounds", () => {
  for (const arrow of ["start", "end", "both"] as const) {
    const shape = {
      type: "polyline" as const,
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 2 },
      ],
      strokeWidth: 64,
      arrow,
    };
    const bounds = getLayoutBounds({
      id: "0199f100-0000-7000-8000-00000000f002",
      order: 0,
      x: 0,
      y: 0,
      rotation: 0,
      fill: "#123456",
      shape,
    });
    const vertices = arrowHeadPoints(shape).flat();
    expect(vertices.length).toBeGreaterThan(0);
    // 余白（arrowSize = 192）だけの矩形 x: -192〜193, y: -192〜194 からは頂点がはみ出していた
    // （例: 始点の矢印の y ≈ 214.7）。
    expect(
      vertices.some((p) => p.x < -192 || p.x > 193 || p.y < -192 || p.y > 194),
    ).toBe(true);
    for (const p of vertices) {
      expect(p.x).toBeGreaterThanOrEqual(bounds.x);
      expect(p.y).toBeGreaterThanOrEqual(bounds.y);
      expect(p.x).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect(p.y).toBeLessThanOrEqual(bounds.y + bounds.height);
    }
  }
});

it("applies start/both through single and selection edits and rejects unknown values", () => {
  expect(() => parseLineArrow("middle")).toThrow("矢印は");
  const project = parseProject(JSON.stringify(sample));
  const screen = project.screens[0];
  const ids = screen.objects
    .filter((o) => o.shape.type === "polyline")
    .map((o) => o.id);
  const data = new FormData();
  data.set("arrow", "both");
  const command = selectionLineCommand(
    { data, targetKey: `1:${screen.id}:false`, objectIds: JSON.stringify(ids) },
    { generation: 1, screenId: screen.id, definition: false, selectedIds: ids },
  );
  const both = applyCommand(project, command, "edit");
  for (const object of both.screens[0].objects)
    if (object.shape.type === "polyline")
      expect(object.shape.arrow).toBe("both");
  const start = applyCommand(
    both,
    {
      type: "update",
      screenId: screen.id,
      objectId: ids[0],
      patch: { arrow: "start" },
    },
    "edit",
  );
  expect(
    (start.screens[0].objects.find((o) => o.id === ids[0]) as PolylineObject)
      .shape.arrow,
  ).toBe("start");
  expect(() =>
    applyCommand(
      both,
      {
        type: "update",
        screenId: screen.id,
        objectId: ids[0],
        patch: { arrow: "middle" as any },
      },
      "edit",
    ),
  ).toThrow("矢印は");
  expect(() =>
    applyCommand(
      both,
      {
        type: "set-line-style",
        screenId: screen.id,
        objectIds: ids,
        patch: { arrow: "middle" as any },
      },
      "edit",
    ),
  ).toThrow("矢印は");
});
