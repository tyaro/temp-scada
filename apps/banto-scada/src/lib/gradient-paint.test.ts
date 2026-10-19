import { expect, it } from "vitest";
import { render } from "svelte/server";
import gradientSample from "../../../../examples/gradient-paint.project.json";
import sample from "../../../../examples/process.project.json";
import { parseProject, serializeProject, type FillPaint } from "./project";
import { applyCommand } from "./editor";
import { recordEdit, emptyHistory, travelHistory } from "./history";
import { copyObjects } from "./clipboard";
import Primitive from "./Primitive.svelte";
const gradient: FillPaint = {
  type: "linearGradient",
  angle: 45,
  start: { color: "#ee8800", alpha: 0.25 },
  end: { color: "#2266cc", alpha: 0.8 },
};
function fixture() {
  const project = parseProject(JSON.stringify(sample)),
    screen = project.screens[0],
    object = screen.objects.find((o) => o.shape.type === "rectangle")!;
  if (object.shape.type !== "rectangle" || !("width" in object))
    throw new Error("fixture");
  object.shape.paint.fill = { enabled: true, paint: structuredClone(gradient) };
  object.width = 200;
  object.height = 100;
  object.rotation = 30;
  object.opacity = 0.6;
  return { project, screen, object };
}
it("renders a local non-square gradient with independent stop alpha and monochrome RGB override", () => {
  const { object } = fixture();
  const html = render(Primitive, { props: { object } }).body;
  expect(html).toContain('gradientUnits="userSpaceOnUse"');
  for (const [key, value] of Object.entries({
    x1: 25,
    y1: -25,
    x2: 175,
    y2: 125,
  }))
    expect(
      Number(html.match(new RegExp(`${key}="([^\"]+)"`))?.[1]),
    ).toBeCloseTo(value, 10);
  expect(html).toContain('stop-color="#ee8800" stop-opacity="0.25"');
  expect(html).toContain('stop-color="#2266cc" stop-opacity="0.8"');
  const monochrome = render(Primitive, {
    props: { object, color: "#123456" },
  }).body;
  expect(monochrome.match(/stop-color="#123456"/g)).toHaveLength(2);
  expect(monochrome).toContain('stop-opacity="0.25"');
  expect(monochrome).toContain('stop-opacity="0.8"');
});
it("preserves gradient settings through none, resize, rotation, JSON, clipboard and Undo", () => {
  const { project, screen, object } = fixture();
  if (object.shape.type !== "rectangle") throw new Error("fixture");
  const paint = {
    ...object.shape.paint,
    fill: { enabled: false, paint: structuredClone(gradient) },
  };
  const next = recordEdit(
    project,
    emptyHistory(),
    {
      type: "update",
      screenId: screen.id,
      objectId: object.id,
      patch: { paint, width: 300, height: 150, rotation: 120 },
    },
    "edit",
  );
  expect(next.history.past).toHaveLength(1);
  expect(
    next.project.screens[0].objects.find((o) => o.id === object.id)?.shape,
  ).toEqual({ ...object.shape, paint });
  expect(
    travelHistory(next.project, next.history, "undo", "edit").project.screens,
  ).toEqual(project.screens);
  expect(parseProject(serializeProject(next.project))).toEqual(next.project);
  const text = copyObjects(next.project, screen.id, [object.id], "source");
  const pasted = applyCommand(
    project,
    {
      type: "paste",
      screenId: screen.id,
      text,
      origin: "foreign",
      center: { x: 500, y: 300 },
    },
    "edit",
  );
  expect(pasted.screens[0].objects.at(-1)?.shape).toEqual({
    ...object.shape,
    paint,
  });
  expect(
    render(Primitive, {
      props: {
        object: next.project.screens[0].objects.find(
          (o) => o.id === object.id,
        )!,
      },
    }).body,
  ).toContain('fill="none"');
});
it("rejects RGB batch edits atomically for enabled gradients but allows stroke-only color without losing disabled gradient", () => {
  const { project, screen, object } = fixture(),
    before = serializeProject(project);
  const command = {
    type: "set-color" as const,
    screenId: screen.id,
    objectIds: [
      screen.objects.find((o) => o.shape.type === "text")!.id,
      object.id,
    ],
    fill: "#112233",
  };
  expect(() => applyCommand(project, command, "edit")).toThrow(
    /グラデーション/,
  );
  expect(serializeProject(project)).toBe(before);
  if (object.shape.type !== "rectangle") throw new Error("fixture");
  object.shape.paint.fill.enabled = false;
  object.shape.paint.stroke = { color: "#334455", width: 3, alpha: 0.4 };
  const next = applyCommand(project, command, "edit").screens[0].objects.find(
    (o) => o.id === object.id,
  )!;
  expect(next.shape).toEqual({
    ...object.shape,
    paint: {
      fill: object.shape.paint.fill,
      stroke: { color: "#112233", width: 3, alpha: 0.4 },
    },
  });
});
it("rejects duplicate root color stores and malformed gradients even when fill is disabled", () => {
  const { project, object } = fixture();
  for (const patch of [{ fill: "#112233" }, { colorAlpha: 0.5 }]) {
    Object.assign(object, patch);
    expect(() => parseProject(JSON.stringify(project))).toThrow();
    delete object.fill;
    delete object.colorAlpha;
  }
  if (object.shape.type !== "rectangle") throw new Error("fixture");
  object.shape.paint.fill.enabled = false;
  for (const alpha of [NaN, Infinity, -1, 2]) {
    object.shape.paint.fill.paint = {
      ...gradient,
      start: { ...gradient.start, alpha },
    };
    expect(() => parseProject(JSON.stringify(project))).toThrow();
  }
});

it("round trips the gradient demonstration without adding assets", () => {
  const project = parseProject(JSON.stringify(gradientSample));
  expect(parseProject(serializeProject(project))).toEqual(project);
  expect(project.assets).toEqual([]);
});
