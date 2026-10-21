import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import symbols from "../../../../examples/symbol-color.project.json";
import { applyCommand, type EditCommand } from "./editor";
import { parseProject, serializeProject, type ScreenObject } from "./project";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import {
  paintAlphaTarget,
  setPaintAlpha,
  type PaintAlphaPatch,
} from "./selection-paint-alpha";
import { selectionPaintAlphaCommand } from "./designer/forms/selection-paint-alpha";
const fresh = () => {
  const p = parseProject(JSON.stringify(sample));
  for (const o of p.screens[0].objects.slice(0, 2)) {
    if (o.shape.type === "rectangle" || o.shape.type === "ellipse")
      o.shape.paint.stroke = { color: "#123456", width: 3 };
    o.opacity = 0.8;
  }
  return p;
};
const command = (
  p = fresh(),
  patch: PaintAlphaPatch = { fill: 0.25, stroke: 0.75 },
) => ({
  type: "set-paint-alpha" as const,
  screenId: p.screens[0].id,
  objectIds: p.screens[0].objects.slice(0, 2).map((o) => o.id),
  patch,
});
it("edits both channels only, retaining RGB, opacity, hidden state and text with one Undo/Redo", () => {
  const p = fresh();
  p.screens[0].objects[0].visible = false;
  const before = structuredClone(p),
    h = emptyHistory();
  const next = recordEdit(p, h, command(p), "edit");
  const expected = structuredClone(p.screens[0].objects);
  for (const o of expected.slice(0, 2))
    if (o.shape.type === "rectangle" || o.shape.type === "ellipse") {
      if (o.shape.paint.fill.paint.type === "solid")
        o.shape.paint.fill.paint.alpha = 0.25;
      o.shape.paint.stroke!.alpha = 0.75;
    }
  expect(next.project.screens[0].objects).toEqual(expected);
  expect(p).toEqual(before);
  expect(next.history.past).toHaveLength(1);
  expect(parseProject(serializeProject(next.project))).toEqual(next.project);
  const undo = travelHistory(next.project, next.history, "undo", "edit");
  expect(undo.project.screens[0].objects).toEqual(p.screens[0].objects);
  expect(
    travelHistory(undo.project, undo.history, "redo", "edit").project.screens[0]
      .objects,
  ).toEqual(expected);
});
it("keeps omitted stroke alpha on 100 percent no-op and supports independent zero values", () => {
  const p = fresh(),
    h = emptyHistory();
  const same = recordEdit(p, h, command(p, { fill: 1, stroke: 1 }), "edit");
  expect(same.project).toBe(p);
  expect(same.history).toBe(h);
  for (const channel of ["fill", "stroke"] as const) {
    const next = applyCommand(p, command(p, { [channel]: 0 }), "edit");
    expect(
      paintAlphaTarget(next.screens[0].objects.slice(0, 2), channel).common,
    ).toBe(0);
    expect(
      paintAlphaTarget(
        next.screens[0].objects.slice(0, 2),
        channel === "fill" ? "stroke" : "fill",
      ).common,
    ).toBe(1);
  }
});
it("rejects unsupported channels before any mutation, but can edit stroke over gradient and disabled fill", () => {
  const objects = fresh().screens[0].objects.slice(0, 2);
  const shape = objects[1].shape;
  if (shape.type !== "ellipse") throw new Error("fixture");
  shape.paint.fill.enabled = false;
  let before = structuredClone(objects);
  expect(() => setPaintAlpha(objects, { fill: 0.2, stroke: 0.3 })).toThrow(
    "単色塗り",
  );
  expect(objects).toEqual(before);
  shape.paint.fill.paint = {
    type: "linearGradient",
    angle: 0,
    start: { color: "#000000", alpha: 1 },
    end: { color: "#ffffff", alpha: 1 },
  };
  shape.paint.fill.enabled = true;
  expect(() => setPaintAlpha(objects, { fill: 0.2 })).toThrow("単色塗り");
  setPaintAlpha(objects, { stroke: 0.3 });
  expect(shape.paint.stroke!.alpha).toBe(0.3);
  shape.paint.stroke = null;
  shape.paint.fill.paint = { type: "solid", color: "#ffffff", alpha: 1 };
  before = structuredClone(objects);
  expect(() => setPaintAlpha(objects, { fill: 0.2, stroke: 0.3 })).toThrow();
  expect(objects).toEqual(before);
});
it("reports per-channel common, mixed and unavailable values", () => {
  const objects = fresh().screens[0].objects;
  expect(paintAlphaTarget(objects.slice(0, 2), "stroke")).toEqual({
    reason: "",
    common: 1,
  });
  setPaintAlpha(objects.slice(0, 1), { fill: 0.2 });
  expect(paintAlphaTarget(objects.slice(0, 2), "fill")).toEqual({
    reason: "",
    common: null,
  });
  expect(paintAlphaTarget(objects, "stroke").reason).toContain("矩形・楕円");
  expect(paintAlphaTarget([], "fill").reason).toBeTruthy();
});
it("rejects malformed patches, invalid targets, groups, locks and preview atomically", () => {
  const p = fresh(),
    base = command(p),
    before = serializeProject(p);
  for (const patch of [
    {},
    null,
    [],
    { unknown: 0.5 },
    ...[NaN, Infinity, -0.01, 1.01, "0.5", null].flatMap((v) => [
      { fill: v },
      { stroke: v },
    ]),
  ])
    expect(() =>
      applyCommand(p, { ...base, patch } as EditCommand, "edit"),
    ).toThrow();
  for (const objectIds of [
    [],
    [base.objectIds[0], base.objectIds[0]],
    [base.objectIds[0], "missing"],
    p.screens[0].objects.map((o) => o.id),
  ])
    expect(() => applyCommand(p, { ...base, objectIds }, "edit")).toThrow();
  const locked = structuredClone(p);
  locked.screens[0].objects[1].locked = true;
  expect(() => applyCommand(locked, base, "edit")).toThrow("ロック");
  const grouped = applyCommand(
    p,
    { type: "group", screenId: base.screenId, objectIds: base.objectIds },
    "edit",
  );
  expect(() => applyCommand(grouped, base, "edit")).toThrow("グループ");
  expect(() => applyCommand(p, base, "preview")).toThrow("プレビュー");
  expect(serializeProject(p)).toBe(before);
});
it("uses the same channel semantics inside shared definitions without changing placements", () => {
  const p = parseProject(JSON.stringify(symbols));
  const owner = p.symbols[0];
  const rectangle = fresh().screens[0].objects[0];
  owner.objects = [rectangle];
  const next = applyCommand(
    p,
    {
      type: "set-paint-alpha",
      screenId: p.screens[0].id,
      definitionId: owner.id,
      objectIds: [rectangle.id],
      patch: { fill: 0 },
    },
    "edit",
  );
  expect(next.screens).toEqual(p.screens);
  expect(paintAlphaTarget(next.symbols[0].objects, "fill").common).toBe(0);
});
it("parses staged fields independently and binds them to the current owner and selection", () => {
  const context = {
    generation: 2,
    screenId: "owner",
    definition: false,
    selectedIds: ["a", "b"],
  };
  const data = new FormData();
  data.set("fillAlpha", "37.5");
  data.set("strokeAlpha", " ");
  const input = { data, targetKey: "2:owner:false", objectIds: '["a","b"]' };
  expect(selectionPaintAlphaCommand(input, context)).toMatchObject({
    patch: { fill: 0.375 },
  });
  data.set("strokeAlpha", "0");
  expect(selectionPaintAlphaCommand(input, context)).toMatchObject({
    patch: { fill: 0.375, stroke: 0 },
  });
  for (const raw of ["1e", "Infinity", "50%", "0x10"]) {
    data.set("fillAlpha", raw);
    expect(() => selectionPaintAlphaCommand(input, context)).toThrow();
  }
  data.set("fillAlpha", "50");
  expect(() =>
    selectionPaintAlphaCommand(
      { ...input, targetKey: "1:owner:false" },
      context,
    ),
  ).toThrow("適用先");
  expect(() =>
    selectionPaintAlphaCommand(input, { ...context, selectedIds: ["a", "c"] }),
  ).toThrow("適用対象");
});
