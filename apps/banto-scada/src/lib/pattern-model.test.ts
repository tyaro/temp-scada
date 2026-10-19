import { expect, it } from "vitest";
import { render } from "svelte/server";
import patternSample from "../../../../examples/pattern-paint.project.json";
import sample from "../../../../examples/minimal.project.json";
import {
  parseProject,
  serializeProject,
  getBounds,
  type FillPaint,
} from "./project";
import { applyCommand } from "./editor";
import { copyObjects } from "./clipboard";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import Primitive from "./Primitive.svelte";
const pattern: FillPaint = {
  type: "pattern",
  kind: "crosshatch",
  spacing: 12,
  size: 4,
  angle: 45,
  foreground: { color: "#22aa66", alpha: 0.5 },
  background: { color: "#eeeeff", alpha: 0.25 },
};
function fixture() {
  const project = parseProject(JSON.stringify(sample)),
    screen = project.screens[0],
    object = screen.objects[0];
  if (object.shape.type !== "rectangle") throw new Error("fixture");
  object.shape.paint.fill.paint = structuredClone(pattern);
  return { project, screen, object };
}
it("renders one local pattern path with independent background alpha and monochrome RGB without adding geometry", () => {
  const { object } = fixture(),
    bounds = getBounds(object),
    html = render(Primitive, { props: { object, color: "#123456" } }).body;
  expect(html).toContain('patternUnits="userSpaceOnUse"');
  expect(html).toContain('patternContentUnits="userSpaceOnUse"');
  expect(html).toContain('patternTransform="rotate(45)"');
  expect(html.match(/fill="#123456"/g)).toHaveLength(2);
  expect(html).toContain('fill-opacity="0.25"');
  expect(html).toContain('fill-opacity="0.5"');
  expect(html).toContain('fill-rule="nonzero"');
  expect(getBounds(object)).toEqual(bounds);
});
it("retains pattern in disabled fill, resize, JSON, foreign clipboard and one-step Undo", () => {
  const { project, screen, object } = fixture();
  if (object.shape.type !== "rectangle") throw new Error("fixture");
  const paint = {
    ...object.shape.paint,
    fill: { enabled: false, paint: structuredClone(pattern) },
  };
  const result = recordEdit(
    project,
    emptyHistory(),
    {
      type: "update",
      screenId: screen.id,
      objectId: object.id,
      patch: { paint, width: 300, height: 150, rotation: 30 },
    },
    "edit",
  );
  expect(result.history.past).toHaveLength(1);
  expect(parseProject(serializeProject(result.project))).toEqual(
    result.project,
  );
  expect(
    travelHistory(result.project, result.history, "undo", "edit").project
      .screens,
  ).toEqual(project.screens);
  const text = copyObjects(result.project, screen.id, [object.id], "source");
  const pasted = applyCommand(
    project,
    {
      type: "paste",
      screenId: screen.id,
      text,
      origin: "foreign",
      center: { x: 300, y: 300 },
    },
    "edit",
  );
  expect(pasted.screens[0].objects.at(-1)?.shape).toEqual({
    ...object.shape,
    paint,
  });
  const html = render(Primitive, {
    props: { object: result.project.screens[0].objects[0] },
  }).body;
  expect(html).toContain('fill="none"');
  expect(html).toContain('width="12"');
});
it("rejects enabled pattern RGB edits atomically and preserves disabled pattern during stroke-only coloring", () => {
  const { project, screen, object } = fixture(),
    before = serializeProject(project),
    command = {
      type: "set-color" as const,
      screenId: screen.id,
      objectIds: [screen.objects[2].id, object.id],
      fill: "#112233",
    };
  expect(() => applyCommand(project, command, "edit")).toThrow(/模様/);
  expect(serializeProject(project)).toBe(before);
  if (object.shape.type !== "rectangle") throw new Error("fixture");
  object.shape.paint.fill.enabled = false;
  object.shape.paint.stroke = { color: "#334455", width: 2, alpha: 0.4 };
  const changed = applyCommand(project, command, "edit").screens[0].objects[0];
  expect(changed.shape).toEqual({
    ...object.shape,
    paint: {
      fill: object.shape.paint.fill,
      stroke: { color: "#112233", width: 2, alpha: 0.4 },
    },
  });
});

it("round trips the independent pattern demonstration without raster assets", () => {
  const project = parseProject(JSON.stringify(patternSample));
  expect(parseProject(serializeProject(project))).toEqual(project);
  expect(project.assets).toEqual([]);
});
