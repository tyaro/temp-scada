import { expect, it } from "vitest";
import { shapePaintCommand, type ShapePaintContext } from "./shape-paint";
import { createProject } from "../../new-project";
import { applyCommand } from "../../editor";
import { serializeProject } from "../../project";
function fixture() {
  const empty = createProject(),
    screenId = empty.screens[0].id;
  const project = applyCommand(
    empty,
    { type: "add", screenId, kind: "rectangle" },
    "edit",
  );
  const selected = project.screens[0].objects[0];
  if (
    selected.shape.type !== "rectangle" ||
    selected.shape.paint.fill.paint.type !== "solid"
  )
    throw new Error("fixture");
  const context: ShapePaintContext = {
    generation: 3,
    screenId,
    definition: false,
    selected,
  };
  const data = new FormData();
  for (const [name, value] of Object.entries({
    fillEnabled: "true",
    fillType: "solid",
    fillColor: selected.shape.paint.fill.paint.color,
    fillAlpha: "100",
    strokeEnabled: "false",
    strokeColor: "#203040",
    strokeSize: "2",
    strokeAlpha: "100",
    strokeStyle: "solid",
  }))
    data.set(name, value);
  return {
    project,
    context,
    input: { data, objectId: selected.id, targetKey: `3:${screenId}:false` },
  };
}
it("keeps unchanged paint a no-op and does not materialize optional default outline fields", () => {
  const { project, context, input } = fixture();
  expect(applyCommand(project, shapePaintCommand(input, context), "edit")).toBe(
    project,
  );
  input.data.set("strokeEnabled", "true");
  const result = applyCommand(
    project,
    shapePaintCommand(input, context),
    "edit",
  );
  expect(result.screens[0].objects[0].shape).toMatchObject({
    paint: { stroke: { color: "#203040", width: 2 } },
  });
  const shape = result.screens[0].objects[0].shape;
  if (shape.type !== "rectangle") throw new Error("fixture");
  expect(shape.paint.stroke).not.toHaveProperty("alpha");
  expect(shape.paint.stroke).not.toHaveProperty("lineStyle");
});
it("rejects captured forms for another generation, owner, definition or placement before editing", () => {
  const { project, context, input } = fixture(),
    before = serializeProject(project);
  for (const patch of [
    { generation: 4 },
    { screenId: "another-owner" },
    { definition: true },
    { selected: undefined },
  ])
    expect(() => shapePaintCommand(input, { ...context, ...patch })).toThrow(
      /適用先/,
    );
  expect(() =>
    shapePaintCommand({ ...input, objectId: "another-object" }, context),
  ).toThrow(/適用先/);
  expect(serializeProject(project)).toBe(before);
});
it("preserves rejection of invalid whole forms and model paint without partial edits", () => {
  const { project, context, input } = fixture(),
    before = serializeProject(project);
  for (const [name, value] of [
    ["fillType", "unknown"],
    ["fillAlpha", "NaN"],
    ["fillColor", "invalid"],
    ["fillAlpha", "101"],
  ]) {
    const data = new FormData();
    for (const [key, value] of input.data) data.set(key, value);
    data.set(name, value);
    expect(() =>
      applyCommand(
        project,
        shapePaintCommand({ ...input, data }, context),
        "edit",
      ),
    ).toThrow();
    expect(serializeProject(project)).toBe(before);
  }
});
