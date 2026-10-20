import { expect, it } from "vitest";
import sample from "../../../../examples/symbol-slots.project.json";
import { parseProject } from "./project";
import { symbolEquipmentCheck } from "./symbol-equipment-check";
it("checks only used role declarations, counting hidden and duplicate Text as one role", () => {
  const project = parseProject(JSON.stringify(sample)),
    definition = project.symbols[0];
  definition.readSlots!.push({
    name: "unused",
    type: "bool",
    direction: "read",
  });
  const text = definition.objects.find(
    (object) => object.shape.type === "text",
  )!;
  text.visible = false;
  definition.objects.push({
    ...structuredClone(text),
    id: "0199ff70-0000-7000-8000-000000000001",
  });
  const before = structuredClone(project);
  const result = symbolEquipmentCheck(
    project,
    definition.id,
    project.equipment![0].id,
  );
  expect(result.rows.map((row) => [row.name, row.state])).toEqual([
    ["running", "unassigned"],
    ["current", "unadopted"],
  ]);
  expect(result.incomplete).toBe(2);
  expect(result.unused).toBe(1);
  expect(project).toEqual(before);
});
it("separates missing roles, wrong types, adoption, assignment and catalog-unverified configuration", () => {
  const project = parseProject(JSON.stringify(sample)),
    definition = project.symbols[0],
    item = project.equipment![1],
    type = project.equipmentTypes![0];
  let check = () => symbolEquipmentCheck(project, definition.id, item.id);
  expect(check().rows.map((row) => row.state)).toEqual([
    "disconnected",
    "unassigned",
  ]);
  expect(check().rows[0].label).toBe("外部名あり・catalog未確認");
  expect(check().incomplete).toBe(1);
  type.slots[0].type = "number";
  expect(check().rows[0].state).toBe("typeMismatch");
  type.slots.splice(0, 1);
  expect(check().rows[0].state).toBe("missingSlot");
  expect(
    symbolEquipmentCheck(project, definition.id, "").rows.every(
      (row) => row.state === "unbound",
    ),
  ).toBe(true);
});
it("does not invoke any runtime reader and handles static and missing definitions distinctly", () => {
  const project = parseProject(JSON.stringify(sample));
  const withReader = Object.assign(project, {
    readSlot() {
      throw new Error("must not read runtime");
    },
  });
  const checked = symbolEquipmentCheck(
    withReader,
    project.symbols[0].id,
    project.equipment![1].id,
  );
  expect(checked.rows[0].state).toBe("disconnected");
  const missing = symbolEquipmentCheck(project, "missing", "");
  expect(missing.definition).toBeUndefined();
  expect(missing.rows).toEqual([]);
  project.symbols[0].objects = project.symbols[0].objects.filter(
    (object) => object.shape.type !== "text",
  );
  const staticResult = symbolEquipmentCheck(project, project.symbols[0].id, "");
  expect(staticResult.definition).toBeDefined();
  expect(staticResult.rows).toEqual([]);
  expect(staticResult.unused).toBe(2);
});
