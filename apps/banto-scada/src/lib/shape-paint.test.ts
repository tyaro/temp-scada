import { it, expect } from "vitest";
import sample from "../../../../examples/process.project.json";
import { applyCommand } from "./editor";
import {
  parseProject,
  serializeProject,
  getBounds,
  strokeOverflowIds,
  getLayoutBounds,
  type ShapePaint,
} from "./project";
import { objectsInRange } from "./range-selection";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { copyObjects } from "./clipboard";
function fixture() {
  const project = parseProject(JSON.stringify(sample)),
    screen = project.screens[0];
  const object = screen.objects.find((o) => o.shape.type === "rectangle")!;
  const command = (paint: ShapePaint) => ({
    type: "update" as const,
    screenId: screen.id,
    objectId: object.id,
    patch: { paint },
  });
  return { project, screen, object, command };
}
it("changes paint atomically with one Undo while retaining geometry and folder", () => {
  const { project, screen, object, command } = fixture();
  const paint = {
    fill: {
      enabled: false,
      paint: { type: "solid" as const, color: "#83bfcd", alpha: 1 },
    },
    stroke: { color: "#123456", width: 6 },
  };
  const result = recordEdit(project, emptyHistory(), command(paint), "edit");
  expect(
    result.project.screens[0].objects.find((o) => o.id === object.id),
  ).toEqual({ ...object, shape: { ...object.shape, paint } });
  expect(
    travelHistory(result.project, result.history, "undo", "edit").project
      .screens,
  ).toEqual(project.screens);
  expect(parseProject(serializeProject(result.project))).toEqual(
    result.project,
  );
  expect(applyCommand(result.project, command(paint), "edit")).toBe(
    result.project,
  );
  expect(screen.objects).toEqual(project.screens[0].objects);
});
it("rejects invalid paint, wrong target types, locks and preview without mutating the source", () => {
  const { project, screen, object, command } = fixture(),
    before = serializeProject(project);
  for (const paint of [
    null,
    {},
    {
      fill: {
        enabled: true,
        paint: { type: "solid" as const, color: "#83bfcd", alpha: 1 },
      },
      stroke: { color: "#123456", width: 0 },
    },
  ])
    expect(() =>
      applyCommand(project, command(paint as unknown as ShapePaint), "edit"),
    ).toThrow();
  const bad = {
    ...command({
      fill: {
        enabled: true,
        paint: { type: "solid" as const, color: "#83bfcd", alpha: 1 },
      },
      stroke: null,
    }),
    objectId: screen.objects.find((o) => o.shape.type === "text")!.id,
  };
  expect(() => applyCommand(project, bad, "edit")).toThrow();
  expect(() =>
    applyCommand(
      project,
      command({
        fill: {
          enabled: false,
          paint: { type: "solid" as const, color: "#83bfcd", alpha: 1 },
        },
        stroke: null,
      }),
      "preview",
    ),
  ).toThrow();
  expect(serializeProject(project)).toBe(before);
  object.locked = true;
  expect(() =>
    applyCommand(
      project,
      command({
        fill: {
          enabled: false,
          paint: { type: "solid" as const, color: "#83bfcd", alpha: 1 },
        },
        stroke: null,
      }),
      "edit",
    ),
  ).toThrow(/ロック/);
});
it("separates body dimensions and painted outline for alignment, range selection and resize", () => {
  const { project, screen, object, command } = fixture();
  const next = applyCommand(
    project,
    command({
      fill: {
        enabled: false,
        paint: { type: "solid" as const, color: "#83bfcd", alpha: 1 },
      },
      stroke: { color: "#123456", width: 10 },
    }),
    "edit",
  );
  const outlined = next.screens[0].objects.find((o) => o.id === object.id)!;
  const body = getLayoutBounds(object),
    paint = getBounds(outlined);
  expect(getLayoutBounds(outlined)).toEqual(body);
  expect(paint).toEqual({
    x: -5,
    y: -5,
    width: body.width + 10,
    height: body.height + 10,
  });
  expect(
    objectsInRange(
      [outlined],
      { x: object.x, y: object.y },
      { x: object.x + body.width, y: object.y + body.height },
    ),
  ).toEqual([]);
  expect(
    objectsInRange(
      [outlined],
      { x: object.x - 5, y: object.y - 5 },
      { x: object.x + body.width + 5, y: object.y + body.height + 5 },
    ),
  ).toEqual([object.id]);
  const resize = applyCommand(
    next,
    {
      type: "update",
      screenId: screen.id,
      objectId: object.id,
      patch: { x: object.x, y: object.y, width: 220, height: 120 },
    },
    "edit",
  );
  expect(
    resize.screens[0].objects.find((o) => o.id === object.id)?.shape,
  ).toEqual(outlined.shape);
});
it("common color changes only enabled channels and rejects an entirely disabled target atomically", () => {
  const { project, screen, object, command } = fixture();
  const lineOnly = applyCommand(
    project,
    command({
      fill: {
        enabled: false,
        paint: { type: "solid" as const, color: "#83bfcd", alpha: 1 },
      },
      stroke: { color: "#123456", width: 2 },
    }),
    "edit",
  );
  const color = {
    type: "set-color" as const,
    screenId: screen.id,
    objectIds: [object.id],
    fill: "#abcdef",
  };
  const next = applyCommand(lineOnly, color, "edit").screens[0].objects.find(
    (o) => o.id === object.id,
  )!;
  expect(next).not.toHaveProperty("fill");
  expect(next.shape).toEqual({
    ...object.shape,
    paint: {
      fill: {
        enabled: false,
        paint: { type: "solid" as const, color: "#83bfcd", alpha: 1 },
      },
      stroke: { color: "#abcdef", width: 2 },
    },
  });
  const both = applyCommand(
    project,
    command({
      fill: {
        enabled: true,
        paint: { type: "solid" as const, color: "#83bfcd", alpha: 1 },
      },
      stroke: { color: "#123456", width: 2 },
    }),
    "edit",
  );
  const colored = applyCommand(both, color, "edit").screens[0].objects.find(
    (o) => o.id === object.id,
  )!;
  expect(
    colored.shape.type === "rectangle" && colored.shape.paint.fill.paint,
  ).toEqual({ type: "solid", color: "#abcdef", alpha: 1 });
  expect(
    colored.shape.type === "rectangle" && colored.shape.paint.stroke?.color,
  ).toBe("#abcdef");
  const empty = applyCommand(
    project,
    command({
      fill: {
        enabled: false,
        paint: { type: "solid" as const, color: "#83bfcd", alpha: 1 },
      },
      stroke: null,
    }),
    "edit",
  );
  expect(() =>
    applyCommand(
      empty,
      {
        ...color,
        objectIds: [
          screen.objects.find((o) => o.shape.type === "text")!.id,
          object.id,
        ],
      },
      "edit",
    ),
  ).toThrow(/塗りと枠線/);
});
it("preserves paint across screen duplication and foreign clipboard", () => {
  const { project, screen, object, command } = fixture();
  const painted = applyCommand(
    project,
    command({
      fill: {
        enabled: false,
        paint: { type: "solid" as const, color: "#83bfcd", alpha: 1 },
      },
      stroke: { color: "#123456", width: 4 },
    }),
    "edit",
  );
  const duplicate = applyCommand(
    painted,
    { type: "duplicate-screen", screenId: screen.id },
    "edit",
  );
  expect(
    duplicate.screens.at(-1)?.objects.find((o) => o.order === object.order)
      ?.shape,
  ).toEqual(painted.screens[0].objects.find((o) => o.id === object.id)?.shape);
  const clip = copyObjects(painted, screen.id, [object.id], "paint");
  const pasted = applyCommand(
    project,
    {
      type: "paste",
      screenId: screen.id,
      text: clip,
      origin: "foreign",
      center: { x: 300, y: 200 },
    },
    "edit",
  );
  expect(pasted.screens[0].objects.at(-1)?.shape).toEqual(
    painted.screens[0].objects.find((o) => o.id === object.id)?.shape,
  );
});

it("aligns the painted edges without changing shape dimensions", () => {
  const { project, screen, object, command } = fixture();
  const outlined = applyCommand(
    project,
    command({
      fill: {
        enabled: true,
        paint: { type: "solid" as const, color: "#83bfcd", alpha: 1 },
      },
      stroke: { color: "#123456", width: 12 },
    }),
    "edit",
  );
  const other = screen.objects.find((o) => o.shape.type === "text")!;
  const next = applyCommand(
    outlined,
    {
      type: "align",
      screenId: screen.id,
      objectIds: [object.id, other.id],
      alignment: "left",
    },
    "edit",
  );
  const items = next.screens[0].objects.filter((o) =>
    [object.id, other.id].includes(o.id),
  );
  const edge = Math.min(object.x - 6, other.x);
  expect(items.map((o) => o.x + getBounds(o).x)).toEqual([edge, edge]);
  expect(getLayoutBounds(items.find((o) => o.id === object.id)!)).toEqual(
    getLayoutBounds(object),
  );
});
it("detects stroke clipping without growing a Symbol viewport or warning for hidden children", () => {
  const { project, screen, object, command } = fixture();
  const next = applyCommand(
    project,
    command({
      fill: {
        enabled: false,
        paint: { type: "solid" as const, color: "#83bfcd", alpha: 1 },
      },
      stroke: { color: "#123456", width: 10 },
    }),
    "edit",
  );
  const painted = next.screens[0].objects.find((o) => o.id === object.id)!;
  painted.x = 0;
  painted.y = 5;
  expect(strokeOverflowIds(next.screens[0])).toEqual([object.id]);
  painted.x = 5;
  expect(strokeOverflowIds(next.screens[0])).toEqual([]);
  painted.x = 0;
  painted.visible = false;
  expect(strokeOverflowIds(next.screens[0])).toEqual([]);
  expect(next.screens[0].width).toBe(screen.width);
});

it("keeps equivalent uppercase colors as a semantic no-op for enabled paint channels", () => {
  const { project, screen, object } = fixture();

  if (object.shape.type !== "rectangle") throw new Error("rectangle fixture");
  object.shape.paint = {
    fill: {
      enabled: true,
      paint: { type: "solid" as const, color: "#ABCDEF", alpha: 1 },
    },
    stroke: { color: "#ABCDEF", width: 2 },
  };
  const command = {
    type: "set-color" as const,
    screenId: screen.id,
    objectIds: [object.id],
    fill: "#abcdef",
  };
  expect(applyCommand(project, command, "edit")).toBe(project);
  object.shape.paint.fill.enabled = false;
  expect(applyCommand(project, command, "edit")).toBe(project);
});

it("treats equivalent paint key order as no change without adding an Undo step", () => {
  const { project, object, command } = fixture();
  if (object.shape.type !== "rectangle") throw new Error("fixture");
  object.shape.paint.stroke = {
    lineStyle: "solid",
    width: 4,
    color: "#334155",
  };
  const before = serializeProject(project);
  const paint: ShapePaint = {
    fill: structuredClone(object.shape.paint.fill),
    stroke: { color: "#334155", width: 4, lineStyle: "solid" },
  };
  expect(recordEdit(project, emptyHistory(), command(paint), "edit")).toEqual({
    project,
    history: emptyHistory(),
  });
  expect(serializeProject(project)).toBe(before);
});
