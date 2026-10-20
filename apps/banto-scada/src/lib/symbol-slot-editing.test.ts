import { expect, it } from "vitest";
import sample from "../../../../examples/symbol-slots.project.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand, type EditCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { symbolSlotUsages } from "./symbol-slots";
import { symbolSlotFormCommand } from "./designer/forms/symbol-slot";
const fresh = () => parseProject(JSON.stringify(sample));
it("protects all used Text, including hidden and locked ones, and treats identical edits as no-op", () => {
  const project = fresh(),
    d = project.symbols[0];
  d.objects[5].visible = false;
  d.objects[5].locked = true;
  expect(symbolSlotUsages(d, "running")).toHaveLength(1);
  const update: EditCommand = {
    type: "update-symbol-slot",
    symbolId: d.id,
    slotName: "running",
    name: "running",
    slotType: "bool",
  };
  const original = serializeProject(project),
    history = emptyHistory();
  expect(recordEdit(project, history, update, "edit")).toEqual({
    project,
    history,
  });
  for (const command of [
    { ...update, name: "active" },
    { ...update, slotType: "number" },
    { type: "remove-symbol-slot", symbolId: d.id, slotName: "running" },
  ] as EditCommand[]) {
    expect(() => recordEdit(project, history, command, "edit")).toThrow(
      /使用中/,
    );
    expect(serializeProject(project)).toBe(original);
    expect(history).toEqual(emptyHistory());
  }
});
it("edits an unused declaration while Symbol placements share it and preserves equipment through Undo", () => {
  const project = fresh(),
    id = project.symbols[0].id;
  const added = recordEdit(
    project,
    emptyHistory(),
    {
      type: "add-symbol-slot",
      symbolId: id,
      name: "pressure",
      slotType: "number",
    },
    "edit",
  );
  expect(added.project.symbols[0].objects).toEqual(project.symbols[0].objects);
  const renamed = recordEdit(
    added.project,
    added.history,
    {
      type: "update-symbol-slot",
      symbolId: id,
      slotName: "pressure",
      name: "enabled",
      slotType: "bool",
    },
    "edit",
  );
  expect(renamed.project.symbols[0].readSlots!.at(-1)).toEqual({
    name: "enabled",
    type: "bool",
    direction: "read",
  });
  expect(renamed.project.equipment).toEqual(project.equipment);
  expect(renamed.project.screens).toEqual(project.screens);
  const undo = travelHistory(renamed.project, renamed.history, "undo", "edit");
  expect(undo.project.symbols).toEqual(added.project.symbols);
  expect(parseProject(serializeProject(renamed.project))).toEqual(
    renamed.project,
  );
});
it("rejects duplicates, invalid names, missing targets and overflow without partial changes", () => {
  const project = fresh(),
    id = project.symbols[0].id;
  const added = applyCommand(
    project,
    {
      type: "add-symbol-slot",
      symbolId: id,
      name: "pressure",
      slotType: "number",
    },
    "edit",
  );
  const original = serializeProject(added);
  for (const command of [
    {
      type: "add-symbol-slot",
      symbolId: id,
      name: "running",
      slotType: "bool",
    },
    {
      type: "add-symbol-slot",
      symbolId: id,
      name: "pressure\n",
      slotType: "bool",
    },
    {
      type: "update-symbol-slot",
      symbolId: id,
      slotName: "pressure",
      name: "current",
      slotType: "number",
    },
    {
      type: "update-symbol-slot",
      symbolId: id,
      slotName: "absent",
      name: "other",
      slotType: "number",
    },
    { type: "remove-symbol-slot", symbolId: id, slotName: "absent" },
  ] as EditCommand[]) {
    expect(() => applyCommand(added, command, "edit")).toThrow();
    expect(serializeProject(added)).toBe(original);
  }
  const full = fresh();
  full.symbols[0].readSlots!.push(
    ...Array.from({ length: 62 }, (_, i) => ({
      name: `s${i}`,
      type: "number" as const,
      direction: "read" as const,
    })),
  );
  expect(() =>
    applyCommand(
      full,
      {
        type: "add-symbol-slot",
        symbolId: id,
        name: "overflow",
        slotType: "number",
      },
      "edit",
    ),
  ).toThrow();
});
it("releases a declaration only after Text is detached and omits the last declaration on removal", () => {
  let project = fresh(),
    d = project.symbols[0];
  project = applyCommand(
    project,
    {
      type: "update",
      screenId: d.id,
      definitionId: d.id,
      objectId: d.objects[5].id,
      patch: { slotBinding: null },
    },
    "edit",
  );
  project = applyCommand(
    project,
    { type: "remove-symbol-slot", symbolId: d.id, slotName: "running" },
    "edit",
  );
  expect(project.symbols[0].readSlots).toHaveLength(1);
  project = applyCommand(
    project,
    {
      type: "update",
      screenId: d.id,
      definitionId: d.id,
      objectId: d.objects[6].id,
      patch: { slotBinding: null },
    },
    "edit",
  );
  project = applyCommand(
    project,
    { type: "remove-symbol-slot", symbolId: d.id, slotName: "current" },
    "edit",
  );
  expect(project.symbols[0]).not.toHaveProperty("readSlots");
  expect(project.equipment).toEqual(fresh().equipment);
});
it("adds a Text for arbitrary declarations through the existing readout command and protects it", () => {
  const project = fresh(),
    id = project.symbols[0].id;
  const declared = applyCommand(
    project,
    {
      type: "add-symbol-slot",
      symbolId: id,
      name: "pressure",
      slotType: "number",
    },
    "edit",
  );
  const shown = applyCommand(
    declared,
    {
      type: "add-symbol-readout",
      symbolId: id,
      slotName: "pressure",
      slotType: "number",
    },
    "edit",
  );
  expect(symbolSlotUsages(shown.symbols[0], "pressure")).toHaveLength(1);
  expect(shown.symbols[0].readSlots).toHaveLength(3);
  expect(() =>
    applyCommand(
      shown,
      { type: "remove-symbol-slot", symbolId: id, slotName: "pressure" },
      "edit",
    ),
  ).toThrow(/使用中/);
});
it("guards form generation, current definition and original name independently of entered names", () => {
  const project = fresh(),
    id = project.symbols[0].id;
  const context = { project, generation: 4, definitionId: id };
  const data = {
    get: (name: string) =>
      ({ slotName: "pressure", slotType: "number" })[
        name as "slotName" | "slotType"
      ],
  };
  const input = {
    connected: true,
    targetKey: `4:${id}`,
    symbolId: id,
    slotName: "running",
    action: "update",
    data,
  };
  expect(symbolSlotFormCommand(input, context)).toEqual({
    type: "update-symbol-slot",
    symbolId: id,
    slotName: "running",
    name: "pressure",
    slotType: "number",
  });
  for (const change of [
    { connected: false },
    { targetKey: `3:${id}` },
    { symbolId: "other" },
    { slotName: "gone" },
    { action: "unknown" },
  ])
    expect(() =>
      symbolSlotFormCommand({ ...input, ...change }, context),
    ).toThrow();
  expect(() =>
    symbolSlotFormCommand(input, { ...context, definitionId: undefined }),
  ).toThrow();
  expect(() =>
    symbolSlotFormCommand({ ...input, data: { get: () => "bad" } }, context),
  ).toThrow();
});

it("does not recreate a declaration renamed while a Text insertion was waiting on drafts", () => {
  const original = fresh(),
    id = original.symbols[0].id;
  const declared = applyCommand(
    original,
    {
      type: "add-symbol-slot",
      symbolId: id,
      name: "pressure",
      slotType: "number",
    },
    "edit",
  );
  const pending: EditCommand = {
    type: "add-symbol-readout",
    symbolId: id,
    slotName: "pressure",
    slotType: "number",
    requireExisting: true,
  };
  const renamed = applyCommand(
    declared,
    {
      type: "update-symbol-slot",
      symbolId: id,
      slotName: "pressure",
      name: "enabled",
      slotType: "bool",
    },
    "edit",
  );
  const before = serializeProject(renamed);
  expect(() => applyCommand(renamed, pending, "edit")).toThrow(/変更/);
  expect(serializeProject(renamed)).toBe(before);
  expect(
    renamed.symbols[0].readSlots!.some((slot) => slot.name === "pressure"),
  ).toBe(false);
});
