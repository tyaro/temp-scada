import { expect, it } from "vitest";
import sample from "../../../../examples/equipment-symbol.project.json";
import cases from "../../../../examples/equipment-reference-cases.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand, type EditCommand } from "./editor";
import { equipmentUsages } from "./equipment";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { copyObjects, parseClipboard } from "./clipboard";
const fresh = () => parseProject(JSON.stringify(sample));
it.each(cases)(
  "equipment placement contract: $name",
  ({ valid, target, key, ...change }) => {
    const input = structuredClone(sample),
      node = target
        .split("/")
        .slice(1)
        .reduce((node, key) => node[key], input as any);
    if ("remove" in change) delete node[key];
    else node[key] = change.value;
    const read = () => parseProject(JSON.stringify(input));
    if (valid) expect(parseProject(serializeProject(read()))).toEqual(read());
    else expect(read).toThrow();
  },
);
it("derives all hidden/locked usages and protects referenced equipment from deletion", () => {
  const original = fresh(),
    id = original.equipment![0].id,
    screen = original.screens[0],
    object = screen.objects[10];
  const duplicated = applyCommand(
    original,
    { type: "duplicate-screen", screenId: screen.id },
    "edit",
  );
  duplicated.screens[1].objects[10].visible = false;
  duplicated.screens[1].objects[10].locked = true;
  expect(equipmentUsages(duplicated, id)).toHaveLength(2);
  const history = emptyHistory();
  expect(() =>
    recordEdit(
      duplicated,
      history,
      { type: "remove-equipment", equipmentId: id },
      "edit",
    ),
  ).toThrow(/使用中/);
  expect(history).toEqual(emptyHistory());
  expect(equipmentUsages(duplicated, id)[1].visible).toBe(false);
  expect(duplicated.equipment).toEqual(original.equipment);
});
it("association, reassignment and clearing are atomic undoable edits; static duplication shares equipment", () => {
  const original = fresh(),
    screenId = original.screens[0].id,
    objectId = original.screens[0].objects[10].id,
    id = original.equipment![0].id;
  const clear: EditCommand = {
    type: "update",
    screenId,
    objectId,
    patch: { equipmentId: null },
  };
  const cleared = recordEdit(original, emptyHistory(), clear, "edit");
  expect(equipmentUsages(cleared.project, id)).toHaveLength(0);
  expect(
    travelHistory(cleared.project, cleared.history, "undo", "edit").project
      .equipment,
  ).toEqual(original.equipment);
  const linked = applyCommand(
    cleared.project,
    { type: "update", screenId, objectId, patch: { equipmentId: id } },
    "edit",
  );
  expect(
    applyCommand(
      linked,
      { type: "update", screenId, objectId, patch: { equipmentId: id } },
      "edit",
    ),
  ).toBe(linked);
  const copied = applyCommand(
    linked,
    { type: "duplicate", screenId, objectId },
    "edit",
  );
  expect(equipmentUsages(copied, id)).toHaveLength(2);
  expect(copied.equipment).toEqual(original.equipment);
  const unique = applyCommand(
    linked,
    { type: "make-symbol-unique", screenId, objectId },
    "edit",
  );
  expect(equipmentUsages(unique, id)).toHaveLength(1);
  expect(unique.equipment).toEqual(original.equipment);
  expect(() =>
    applyCommand(
      original,
      { type: "update", screenId, objectId, patch: { equipmentId: "missing" } },
      "edit",
    ),
  ).toThrow();
  const locked = fresh();
  locked.screens[0].objects[10].locked = true;
  expect(() => applyCommand(locked, clear, "edit")).toThrow();
  expect(() =>
    applyCommand(
      original,
      {
        type: "update",
        screenId,
        objectId: original.screens[0].objects[0].id,
        patch: { equipmentId: id },
      },
      "edit",
    ),
  ).toThrow();
});
it("rejects whole clipboard selections and forged fragments before import or removal", () => {
  const project = fresh(),
    screen = project.screens[0];
  expect(() =>
    copyObjects(
      project,
      screen.id,
      [screen.objects[0].id, screen.objects[10].id],
      "origin",
    ),
  ).toThrow(/機器/);
  const forged = JSON.stringify({
    format: "banto-scada.objects",
    version: 1,
    origin: "origin",
    project,
  });
  expect(() => parseClipboard(forged)).toThrow(/機器/);
  expect(() =>
    applyCommand(
      project,
      {
        type: "paste",
        screenId: screen.id,
        text: forged,
        origin: "origin",
        center: { x: 0, y: 0 },
      },
      "edit",
    ),
  ).toThrow(/機器/);
  expect(project).toEqual(fresh());
});
