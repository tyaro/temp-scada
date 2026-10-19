import { it, expect } from "vitest";
import paintSample from "../../../../examples/shape-paint.project.json";
import sample from "../../../../examples/minimal.project.json";
import {
  applyCommand,
  type EditCommand,
  type OutlineStylePatch,
} from "./editor";
import { parseProject, serializeProject, getBounds } from "./project";
import { emptyHistory, recordEdit, travelHistory } from "./history";
function fixture() {
  const project = parseProject(JSON.stringify(sample)),
    owner = project.screens[0];
  const objects = owner.objects.filter(
    (o) => o.shape.type === "rectangle" || o.shape.type === "ellipse",
  );
  objects.forEach((o, i) => {
    if (o.shape.type === "rectangle" || o.shape.type === "ellipse")
      o.shape.paint.stroke = {
        color: i ? "#ABCDEF" : "#123456",
        width: i ? 4 : 2,
      };
  });
  const command = (patch: OutlineStylePatch): EditCommand => ({
    type: "set-outline-style",
    screenId: owner.id,
    objectIds: objects.map((o) => o.id),
    patch,
  });
  return { project, owner, objects, command };
}
it("changes only specified outline attributes and preserves body, fill and folders with one Undo", () => {
  const { project, owner, objects, command } = fixture();
  const result = recordEdit(
    project,
    emptyHistory(),
    command({ width: 6 }),
    "edit",
  );
  for (const original of objects) {
    const changed = result.project.screens[0].objects.find(
      (o) => o.id === original.id,
    )!;
    expect(changed).toEqual({
      ...original,
      shape: {
        ...original.shape,
        paint: {
          ...("paint" in original.shape ? original.shape.paint : {}),
          stroke: {
            ...("paint" in original.shape ? original.shape.paint.stroke : {}),
            width: 6,
          },
        },
      },
    });
    expect(getBounds(changed).width).toBe(
      ("width" in original ? original.width : 0) + 6,
    );
  }
  expect(parseProject(serializeProject(result.project))).toEqual(
    result.project,
  );
  const undo = travelHistory(result.project, result.history, "undo", "edit");
  expect(undo.project.screens).toEqual(project.screens);
  expect(
    travelHistory(undo.project, undo.history, "redo", "edit").project.screens,
  ).toEqual(result.project.screens);
  const colored = applyCommand(project, command({ color: "#334455" }), "edit");
  expect(
    colored.screens[0].objects
      .filter((o) => objects.some((v) => v.id === o.id))
      .map((o) => ("paint" in o.shape ? o.shape.paint.stroke?.width : 0)),
  ).toEqual([2, 4]);
  expect(owner.objects).toEqual(project.screens[0].objects);
});
it("requires explicit mode, color and width to create outlines and applies shared values to existing ones too", () => {
  const { project, objects, command } = fixture();
  if (objects[0].shape.type !== "rectangle") throw new Error();
  objects[0].shape.paint.stroke = null;
  for (const patch of [
    { width: 3 },
    { color: "#123456" },
    { mode: "enabled" },
    { mode: "enabled", width: 3 },
    { mode: "enabled", color: "#123456" },
  ])
    expect(() =>
      applyCommand(project, command(patch as OutlineStylePatch), "edit"),
    ).toThrow(/明示/);
  const next = applyCommand(
    project,
    command({ mode: "enabled", color: "#334455", width: 3 }),
    "edit",
  );
  for (const object of next.screens[0].objects)
    if (object.shape.type === "rectangle" || object.shape.type === "ellipse")
      expect(object.shape.paint.stroke).toEqual({ color: "#334455", width: 3 });
});
it("supports explicit removal and semantic no-ops without changing stored fill", () => {
  const { project, objects, command } = fixture();
  const removed = applyCommand(project, command({ mode: "none" }), "edit");
  for (const object of removed.screens[0].objects)
    if (object.shape.type === "rectangle" || object.shape.type === "ellipse")
      expect(object.shape.paint.stroke).toBeNull();
  expect(removed.screens[0].objects.map((o) => o.fill)).toEqual(
    project.screens[0].objects.map((o) => o.fill),
  );
  expect(applyCommand(removed, command({ mode: "none" }), "edit")).toBe(
    removed,
  );
  expect(applyCommand(project, command({ mode: "enabled" }), "edit")).toBe(
    project,
  );
  if (objects[0].shape.type === "rectangle")
    objects[0].shape.paint.stroke = { color: "#ABCDEF", width: 4 };
  expect(
    applyCommand(project, command({ color: "#abcdef", width: 4 }), "edit"),
  ).toBe(project);
});
it("rejects contradictory or malformed patches and invalid target sets atomically", () => {
  const { project, owner, objects, command } = fixture(),
    before = serializeProject(project);
  for (const patch of [
    {},
    null,
    [],
    { mode: "auto" },
    { mode: false },
    { mode: "none", width: 2 },
    { mode: "none", color: "#123456" },
    { width: 0 },
    { width: -1 },
    { width: 64.1 },
    { width: Infinity },
    { width: NaN },
    { width: "2" },
    { width: null },
    { color: "#fff" },
    { color: 1 },
    { color: null },
    { width: 2, fill: "#ffffff" },
  ])
    expect(() =>
      applyCommand(project, { ...command({}), patch } as EditCommand, "edit"),
    ).toThrow();
  for (const ids of [
    [],
    [objects[0].id, objects[0].id],
    [objects[0].id, "missing"],
    [objects[0].id, owner.objects.find((o) => o.shape.type === "text")!.id],
  ])
    expect(() =>
      applyCommand(
        project,
        { ...command({ width: 2 }), objectIds: ids } as EditCommand,
        "edit",
      ),
    ).toThrow();
  expect(() =>
    applyCommand(project, command({ width: 2 }), "preview"),
  ).toThrow();
  expect(serializeProject(project)).toBe(before);
});
it("rejects locked mixtures but edits hidden shapes without showing them", () => {
  const { project, objects, command } = fixture();
  objects[0].visible = false;
  const hidden = applyCommand(project, command({ width: 8 }), "edit");
  expect(
    hidden.screens[0].objects.find((o) => o.id === objects[0].id)?.visible,
  ).toBe(false);
  objects[1].locked = true;
  const before = serializeProject(project);
  expect(() =>
    applyCommand(project, command({ mode: "none" }), "edit"),
  ).toThrow(/ロック/);
  expect(serializeProject(project)).toBe(before);
});

it("changes shared definition outlines while keeping parent modes and dimensions independent", () => {
  const project = parseProject(JSON.stringify(paintSample)),
    definition = project.symbols[0];
  const objects = definition.objects.filter(
    (object) =>
      object.shape.type === "rectangle" || object.shape.type === "ellipse",
  );
  const next = applyCommand(
    project,
    {
      type: "set-outline-style",
      screenId: project.screens[0].id,
      definitionId: definition.id,
      objectIds: objects.map((object) => object.id),
      patch: { width: 8 },
    },
    "edit",
  );
  expect(next.screens).toEqual(project.screens);
  for (const original of objects) {
    const changed = next.symbols[0].objects.find(
      (object) => object.id === original.id,
    )!;
    expect(changed.fill).toBe(original.fill);
    expect("paint" in changed.shape && changed.shape.paint.stroke?.width).toBe(
      8,
    );
  }
  expect(parseProject(serializeProject(next))).toEqual(next);
});
