import { expect, it } from "vitest";
import sample from "../../../../examples/state-text-color.project.json";
import {
  parseProject,
  serializeProject,
  type StateTextColors,
} from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { stateTextColorCommand } from "./designer/forms/state-text-color";
import { objectFormCommand } from "./designer/forms/object-form";
import { objectFormValues } from "./designer/numeric-properties";
import { copyObjects } from "./clipboard";
const fresh = () => parseProject(JSON.stringify(sample));
const colors: StateTextColors = { unknownColor: "#ffaa00" };
it("persists the state-color follow setting, atomically updates, supports Undo and preserves slot text when disabled", () => {
  const project = fresh(),
    def = project.symbols[0],
    object = def.objects[5];
  const command = {
    type: "update" as const,
    definitionId: def.id,
    screenId: def.id,
    objectId: object.id,
    patch: { stateColors: colors },
  };
  const edited = recordEdit(project, emptyHistory(), command, "edit");
  expect(
    parseProject(serializeProject(edited.project)).symbols[0].objects[5].shape,
  ).toMatchObject({
    stateColors: colors,
    slotBinding: { slotName: "running" },
  });
  const undone = travelHistory(
    edited.project,
    edited.history,
    "undo",
    "edit",
  ).project;
  expect(undone.symbols[0].objects).toEqual(def.objects);
  const disabled = applyCommand(
    edited.project,
    { ...command, patch: { stateColors: null } },
    "edit",
  );
  expect(disabled.symbols[0].objects[5].shape).not.toHaveProperty(
    "stateColors",
  );
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
    { stateColors: { unknownColor: "red" } },
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
    expect(command).toMatchObject({ patch: { stateColors: null } });
    if (command.type !== "update") throw new Error("expected update");
    command.definitionId = def.id;
    const edited = recordEdit(project, emptyHistory(), command, "edit");
    expect(edited.project.symbols[0].objects[5].shape).not.toHaveProperty(
      "stateColors",
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
it("guards color form generation, owner, selection, mode and current bool/state declaration", () => {
  const project = fresh(),
    def = project.symbols[0],
    selected = def.objects[5];
  const data = new FormData();
  data.set("stateColorsMode", "enabled");
  for (const [key, value] of Object.entries(colors)) data.set(key, value);
  const input = { data, objectId: selected.id, targetKey: `4:${def.id}:true` };
  const context = {
    generation: 4,
    screenId: def.id,
    definition: true,
    selected,
    readSlots: def.readSlots!,
  };
  expect(stateTextColorCommand(input, context)).toMatchObject({
    patch: { stateColors: colors },
  });
  for (const change of [
    { generation: 5 },
    { screenId: project.screens[0].id },
    { definition: false },
    { selected: def.objects[6] },
    { readSlots: [] },
  ])
    expect(() =>
      stateTextColorCommand(input, { ...context, ...change }),
    ).toThrow();
  data.set("stateColorsMode", "other");
  expect(() => stateTextColorCommand(input, context)).toThrow();
  data.set("stateColorsMode", "disabled");
  expect(stateTextColorCommand(input, context)).toMatchObject({
    patch: { stateColors: null },
  });
});
it("keeps the setting when the slot changes to a state slot and accepts state slots in the form", () => {
  const project = fresh(),
    def = project.symbols[0],
    selected = def.objects[5];
  const readSlots = [
    ...def.readSlots!,
    { name: "mode", type: "state" as const, direction: "read" as const },
  ];
  const data = new FormData();
  for (const [key, value] of Object.entries(objectFormValues(selected, true)))
    data.set(key, value);
  data.set("slotName", "mode");
  const command = objectFormCommand(data, {
    screenId: def.id,
    definition: true,
    selected,
    readSlots,
  });
  expect(command).not.toMatchObject({ patch: { stateColors: null } });
  const form = new FormData();
  form.set("stateColorsMode", "enabled");
  form.set("unknownColor", "#123456");
  const stateText = {
    ...selected,
    shape: { ...selected.shape, slotBinding: { slotName: "mode" } },
  } as typeof selected;
  expect(
    stateTextColorCommand(
      { data: form, objectId: selected.id, targetKey: `1:${def.id}:true` },
      {
        generation: 1,
        screenId: def.id,
        definition: true,
        selected: stateText,
        readSlots,
      },
    ),
  ).toMatchObject({ patch: { stateColors: { unknownColor: "#123456" } } });
});
