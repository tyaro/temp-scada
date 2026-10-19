import { expect, it } from "vitest";
import sample from "../../../../../../examples/minimal.project.json";
import { selectionOutlineCommand } from "./selection-outline";
import { applyCommand } from "../../editor";
import { parseProject, serializeProject } from "../../project";
function fixture() {
  const project = parseProject(JSON.stringify(sample)),
    screen = project.screens[0];
  const selectedIds = screen.objects
    .filter((o) => o.shape.type === "rectangle" || o.shape.type === "ellipse")
    .map((o) => o.id);
  const context = {
    generation: 5,
    screenId: screen.id,
    definition: false,
    selectedIds,
  };
  const data = new FormData();
  for (const key of [
    "outlineMode",
    "outlineColor",
    "outlineWidth",
    "outlineStyle",
  ])
    data.set(key, "");
  return {
    project,
    context,
    input: {
      data,
      targetKey: `5:${screen.id}:false`,
      objectIds: JSON.stringify(selectedIds),
    },
  };
}
it("preserves empty-patch rejection, explicit outline creation and repeated no-op", () => {
  const { project, context, input } = fixture();
  expect(() =>
    applyCommand(project, selectionOutlineCommand(input, context), "edit"),
  ).toThrow(/変更する項目/);
  input.data.set("outlineMode", "enabled");
  input.data.set("outlineColor", "#123456");
  input.data.set("outlineWidth", "6");
  const changed = applyCommand(
    project,
    selectionOutlineCommand(input, context),
    "edit",
  );
  expect(
    applyCommand(changed, selectionOutlineCommand(input, context), "edit"),
  ).toBe(changed);
  for (const object of changed.screens[0].objects.filter((o) =>
    context.selectedIds.includes(o.id),
  ))
    expect(object.shape).toMatchObject({
      paint: { stroke: { color: "#123456", width: 6 } },
    });
  expect(
    changed.screens[0].objects.find((o) => o.shape.type === "text"),
  ).toEqual(project.screens[0].objects.find((o) => o.shape.type === "text"));
});
it("rejects stale scope, missing selections, malformed IDs and replaced targets", () => {
  const { context, input } = fixture();
  for (const objectIds of [
    undefined,
    "null",
    "{}",
    "[1,2]",
    "[]",
    JSON.stringify([context.selectedIds[0], "different-id"]),
  ])
    expect(() =>
      selectionOutlineCommand({ ...input, objectIds }, context),
    ).toThrow();
  for (const patch of [
    { generation: 6 },
    { screenId: "other-owner" },
    { definition: true },
    { selectedIds: context.selectedIds.slice(0, 1) },
  ])
    expect(() =>
      selectionOutlineCommand(input, { ...context, ...patch }),
    ).toThrow(/適用/);
});
it("preserves whole-selection rejection of contradictory and invalid patches", () => {
  const { project, context, input } = fixture(),
    before = serializeProject(project);
  for (const patch of [
    { outlineMode: "none", outlineWidth: "6" },
    { outlineMode: "invalid" },
    { outlineWidth: "NaN" },
    { outlineMode: "enabled", outlineColor: "invalid", outlineWidth: "6" },
  ]) {
    const data = new FormData();
    for (const [key, value] of input.data) data.set(key, value);
    for (const [key, value] of Object.entries(patch)) data.set(key, value);
    expect(() =>
      applyCommand(
        project,
        selectionOutlineCommand({ ...input, data }, context),
        "edit",
      ),
    ).toThrow();
    expect(serializeProject(project)).toBe(before);
  }
});
