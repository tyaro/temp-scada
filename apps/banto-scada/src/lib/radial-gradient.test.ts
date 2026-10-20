import { expect, it } from "vitest";
import { render } from "svelte/server";
import sample from "../../../../examples/radial-paint.project.json";
import {
  parseProject,
  serializeProject,
  paintBaseColor,
  type FillPaint,
} from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { copyObjects } from "./clipboard";
import Primitive from "./Primitive.svelte";
import {
  radialGradientFromForm,
  radialPercent,
} from "./designer/radial-gradient-fields";
import { shapePaintCommand } from "./designer/forms/shape-paint";
const radial: Extract<FillPaint, { type: "radialGradient" }> = {
  type: "radialGradient",
  center: { x: 0.123456789, y: 0.987654321 },
  radius: 0.39999999999999997,
  start: { color: "#ee8800", alpha: 0.39999999999999997 },
  end: { color: "#2266cc", alpha: 0.8 },
};
function form() {
  const values = new Map([
    ["radialStartColor", radial.start.color],
    ["radialStartAlpha", radialPercent(radial.start.alpha)],
    ["radialEndColor", radial.end.color],
    ["radialEndAlpha", radialPercent(radial.end.alpha)],
    ["radialCenterX", radialPercent(radial.center.x)],
    ["radialCenterY", radialPercent(radial.center.y)],
    ["radialRadius", radialPercent(radial.radius)],
    ["fillEnabled", "true"],
    ["fillType", "radialGradient"],
    ["strokeEnabled", "false"],
  ]);
  const data = new FormData();
  for (const [key, value] of values) data.set(key, value);
  return data;
}
function fixture() {
  const project = parseProject(JSON.stringify(sample));
  const screen = project.screens[0],
    object = screen.objects.find((o) => o.shape.type === "rectangle")!;
  if (!("width" in object) || object.shape.type !== "rectangle")
    throw new Error("fixture");
  object.width = 240;
  object.height = 80;
  object.opacity = 0.6;
  object.rotation = 37;
  object.shape.paint.fill = { enabled: true, paint: structuredClone(radial) };
  return { project, screen, object };
}
it("renders normalized elliptical geometry with explicit focus/pad and preserves independent alpha in monochrome", () => {
  const { object } = fixture();
  for (const color of [undefined, "#123456"]) {
    const html = render(Primitive, { props: { object, color } }).body;
    expect(html).toContain("<radialGradient");
    expect(html).toContain('gradientUnits="objectBoundingBox"');
    expect(html).toContain('spreadMethod="pad"');
    for (const [key, value] of Object.entries({
      cx: radial.center.x,
      cy: radial.center.y,
      fx: radial.center.x,
      fy: radial.center.y,
      r: radial.radius,
    }))
      expect(Number(html.match(new RegExp(`${key}="([^"]+)"`))?.[1])).toBe(
        value,
      );
    expect(html).toContain(
      `stop-color="${color ?? radial.start.color}" stop-opacity="${radial.start.alpha}"`,
    );
    expect(html).toContain(
      `stop-color="${color ?? radial.end.color}" stop-opacity="${radial.end.alpha}"`,
    );
  }
  expect(paintBaseColor(radial)).toEqual(radial.start);
});
it("preserves untouched percentage f64 values and treats an identical form as a no-op", () => {
  expect(radialGradientFromForm(form(), radial)).toEqual(radial);
  const { project, screen, object } = fixture();
  const command = shapePaintCommand(
    { data: form(), objectId: object.id, targetKey: `1:${screen.id}:false` },
    { generation: 1, screenId: screen.id, definition: false, selected: object },
  );
  expect(applyCommand(project, command, "edit")).toBe(project);
});
it("validates center, radius, color and alpha without clamping, including nonfinite values", () => {
  for (const [key, value] of [
    ["radialCenterX", "-1"],
    ["radialCenterY", "101"],
    ["radialRadius", "0"],
    ["radialRadius", "200.1"],
    ["radialStartAlpha", "-1"],
    ["radialEndAlpha", "101"],
    ["radialEndColor", "#123"],
    ["radialCenterX", "NaN"],
    ["radialRadius", "Infinity"],
    ["radialRadius", ""],
  ]) {
    const data = form();
    data.set(key, value);
    expect(() => radialGradientFromForm(data, radial)).toThrow();
  }
  const edge = form();
  edge.set("radialCenterX", "0");
  edge.set("radialCenterY", "100");
  edge.set("radialRadius", "200");
  expect(radialGradientFromForm(edge, radial)).toMatchObject({
    center: { x: 0, y: 1 },
    radius: 2,
  });
});
it("retains radial parameters through explicit apply, resize/rotation, JSON, clipboard and single Undo", () => {
  const { project, screen, object } = fixture();
  const data = form();
  data.set("radialRadius", "150");
  const command = shapePaintCommand(
    { data, objectId: object.id, targetKey: `1:${screen.id}:false` },
    { generation: 1, screenId: screen.id, definition: false, selected: object },
  );
  const result = recordEdit(project, emptyHistory(), command, "edit");
  expect(result.history.past).toHaveLength(1);
  expect(
    travelHistory(result.project, result.history, "undo", "edit").project
      .screens,
  ).toEqual(project.screens);
  const resized = applyCommand(
    result.project,
    {
      type: "update",
      screenId: screen.id,
      objectId: object.id,
      patch: { width: 360, height: 120, rotation: 90 },
    },
    "edit",
  );
  const text = copyObjects(resized, screen.id, [object.id], "one");
  const pasted = applyCommand(
    resized,
    {
      type: "paste",
      screenId: screen.id,
      text,
      origin: "two",
      center: { x: 500, y: 300 },
    },
    "edit",
  );
  const shape = pasted.screens[0].objects.at(-1)!.shape;
  expect(shape).toMatchObject({
    paint: { fill: { paint: { ...radial, radius: 1.5 } } },
  });
  expect(parseProject(serializeProject(pasted))).toEqual(pasted);
  expect(() =>
    shapePaintCommand(
      { data, objectId: object.id, targetKey: `0:${screen.id}:false` },
      {
        generation: 1,
        screenId: screen.id,
        definition: false,
        selected: object,
      },
    ),
  ).toThrow("適用先");
});
