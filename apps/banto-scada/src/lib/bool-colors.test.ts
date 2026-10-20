import { expect, it } from "vitest";
import sample from "../../../../examples/bool-colors.project.json";
import { parseProject, serializeProject, type BoolColors } from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { boolColorsCommand } from "./designer/forms/bool-colors";
import { objectFormCommand } from "./designer/forms/object-form";
import { objectFormValues } from "./designer/numeric-properties";
import { copyObjects } from "./clipboard";
const fresh = () => parseProject(JSON.stringify(sample));
const colors: BoolColors = {
  trueColor: "#00aa00",
  falseColor: "#666666",
  unknownColor: "#ffaa00",
};
it("persists complete bool colors, atomically updates, supports Undo and preserves slot text when disabled", () => {
  const project = fresh(),
    def = project.symbols[0],
    object = def.objects[5];
  const command = {
    type: "update" as const,
    definitionId: def.id,
    screenId: def.id,
    objectId: object.id,
    patch: { boolColors: colors },
  };
  const edited = recordEdit(project, emptyHistory(), command, "edit");
  expect(
    parseProject(serializeProject(edited.project)).symbols[0].objects[5].shape,
  ).toMatchObject({ boolColors: colors, slotBinding: { slotName: "running" } });
  const undone = travelHistory(
    edited.project,
    edited.history,
    "undo",
    "edit",
  ).project;
  expect(undone.symbols[0].objects).toEqual(def.objects);
  const disabled = applyCommand(
    edited.project,
    { ...command, patch: { boolColors: null } },
    "edit",
  );
  expect(disabled.symbols[0].objects[5].shape).not.toHaveProperty("boolColors");
  expect(disabled.symbols[0].objects[5].shape).toMatchObject({
    slotBinding: { slotName: "running" },
  });
  expect(project.symbols[0].objects[5]).toEqual(object);
});
it("refuses inconsistent direct patches without repairing or mutating the original", () => {
  const project = fresh(),
    def = project.symbols[0],
    id = def.objects[5].id;
  const before = serializeProject(project);
  for (const patch of [
    { slotBinding: null },
    { slotBinding: { slotName: "current" } },
    { boolColors: { ...colors, trueColor: "red" } },
  ])
    expect(() =>
      applyCommand(
        project,
        {
          type: "update",
          definitionId: def.id,
          screenId: def.id,
          objectId: id,
          patch,
        },
        "edit",
      ),
    ).toThrow();
  expect(() =>
    applyCommand(
      project,
      { type: "remove-symbol-slot", symbolId: def.id, slotName: "running" },
      "edit",
    ),
  ).toThrow();
  expect(() => copyObjects(project, def.id, [id], "test")).toThrow();
  expect(serializeProject(project)).toBe(before);
});
it.each(["", "current"])(
  "clears colors explicitly with slot change to %s in a single Undo",
  (slotName) => {
    const project = fresh(),
      def = project.symbols[0],
      selected = def.objects[5];
    const data = new FormData();
    for (const [key, value] of Object.entries(objectFormValues(selected, true)))
      data.set(key, value);
    data.set("slotName", slotName);
    const command = objectFormCommand(data, {
      screenId: def.id,
      definition: true,
      selected,
      readSlots: def.readSlots,
    });
    expect(command).toMatchObject({ patch: { boolColors: null } });
    if (command.type !== "update") throw new Error("expected update");
    command.definitionId = def.id;
    const edited = recordEdit(project, emptyHistory(), command, "edit");
    expect(edited.project.symbols[0].objects[5].shape).not.toHaveProperty(
      "boolColors",
    );
    const restored = travelHistory(
      edited.project,
      edited.history,
      "undo",
      "edit",
    ).project;
    expect(restored.symbols[0].objects).toEqual(def.objects);
  },
);
it("guards color form generation, owner, selection, mode and current bool declaration", () => {
  const project = fresh(),
    def = project.symbols[0],
    selected = def.objects[5];
  const data = new FormData();
  data.set("boolColorsMode", "enabled");
  for (const [key, value] of Object.entries(colors)) data.set(key, value);
  const input = { data, objectId: selected.id, targetKey: `4:${def.id}:true` };
  const context = {
    generation: 4,
    screenId: def.id,
    definition: true,
    selected,
    readSlots: def.readSlots!,
  };
  expect(boolColorsCommand(input, context)).toMatchObject({
    patch: { boolColors: colors },
  });
  for (const change of [
    { generation: 5 },
    { screenId: project.screens[0].id },
    { definition: false },
    { selected: def.objects[6] },
    { readSlots: [] },
  ])
    expect(() => boolColorsCommand(input, { ...context, ...change })).toThrow();
  data.set("boolColorsMode", "other");
  expect(() => boolColorsCommand(input, context)).toThrow();
  data.set("boolColorsMode", "disabled");
  expect(boolColorsCommand(input, context)).toMatchObject({
    patch: { boolColors: null },
  });
});
