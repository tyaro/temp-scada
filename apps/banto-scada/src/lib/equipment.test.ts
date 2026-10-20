import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import equipmentSample from "../../../../examples/equipment.project.json";
import cases from "../../../../examples/equipment-cases.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand, type EditCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
const fresh = () => parseProject(JSON.stringify(equipmentSample));
it.each(cases)(
  "equipment shared contract: $name",
  ({ name: _, valid, ...config }) => {
    const read = () => parseProject(JSON.stringify({ ...sample, ...config }));
    if (valid) expect(parseProject(serializeProject(read()))).toEqual(read());
    else expect(read).toThrow();
  },
);
it("creates type and instance separately, trims labels/code, and preserves optional absence", () => {
  const original = parseProject(JSON.stringify(sample));
  const renamed = applyCommand(
    original,
    { type: "update-project", name: original.manifest.name },
    "edit",
  );
  expect(renamed).toBe(original);
  expect(renamed.equipment).toBeUndefined();
  const typed = applyCommand(
    original,
    { type: "create-equipment-type", name: " ファン ", slots: [] },
    "edit",
  );
  const type = typed.equipmentTypes![0];
  expect(type.name).toBe("ファン");
  expect(typed.equipment).toBeUndefined();
  const created = applyCommand(
    typed,
    {
      type: "create-equipment",
      typeId: type.id,
      code: " FAN-001 ",
      name: " ファン1 ",
      bindings: [],
    },
    "edit",
  );
  expect(created.equipment![0].code).toBe("FAN-001");
  expect(original.equipmentTypes).toBeUndefined();
});
it("protects adopted slots including null and used types atomically", () => {
  const original = fresh(),
    type = original.equipmentTypes![0];
  const bad: EditCommand[] = [
    { type: "remove-equipment-type", typeId: type.id },
    {
      type: "update-equipment-type",
      typeId: type.id,
      name: type.name,
      slots: [],
    },
    {
      type: "update-equipment-type",
      typeId: type.id,
      name: type.name,
      slots: type.slots.map((slot) => ({ ...slot, type: "number" })),
    },
    {
      type: "update-equipment",
      equipmentId: original.equipment![0].id,
      code: "bad code",
      name: "名称",
      bindings: [],
    },
  ];
  for (const command of bad) {
    const history = emptyHistory();
    expect(() => recordEdit(original, history, command, "edit")).toThrow();
    expect(original).toEqual(fresh());
    expect(history).toEqual(emptyHistory());
    expect(() => applyCommand(original, command, "preview")).toThrow();
  }
});
it("updates bindings once, preserves shared names and round-trips history", () => {
  const original = fresh(),
    item = original.equipment![0],
    history = emptyHistory();
  const command: EditCommand = {
    type: "update-equipment",
    equipmentId: item.id,
    code: item.code,
    name: item.name,
    bindings: [
      { slotName: "running", externalName: " exact " },
      { slotName: "current", externalName: " exact " },
    ],
  };
  const changed = recordEdit(original, history, command, "edit");
  expect(changed.history.past).toHaveLength(1);
  expect(changed.project.equipment![0].bindings[0].externalName).toBe(
    " exact ",
  );
  expect(applyCommand(changed.project, command, "edit")).toBe(changed.project);
  const undo = travelHistory(changed.project, changed.history, "undo", "edit");
  expect(undo.project.equipment).toEqual(original.equipment);
  const redo = travelHistory(undo.project, undo.history, "redo", "edit");
  expect(redo.project.equipment).toEqual(changed.project.equipment);
});
it("allows unadopted type changes and explicit removal before deleting a type", () => {
  let project = fresh();
  const type = project.equipmentTypes![0],
    item = project.equipment![0];
  project = applyCommand(
    project,
    {
      type: "update-equipment-type",
      typeId: type.id,
      name: type.name,
      slots: [type.slots[0]],
    },
    "edit",
  );
  project = applyCommand(
    project,
    {
      type: "update-equipment",
      equipmentId: item.id,
      code: item.code,
      name: item.name,
      bindings: [],
    },
    "edit",
  );
  project = applyCommand(
    project,
    {
      type: "update-equipment-type",
      typeId: type.id,
      name: type.name,
      slots: [],
    },
    "edit",
  );
  project = applyCommand(
    project,
    { type: "remove-equipment", equipmentId: item.id },
    "edit",
  );
  project = applyCommand(
    project,
    { type: "remove-equipment-type", typeId: type.id },
    "edit",
  );
  expect(project.equipment).toEqual([]);
  expect(project.equipmentTypes).toEqual([]);
});
