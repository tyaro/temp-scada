import { it, expect } from "vitest";
import sample from "../../../../examples/symbol-slots.project.json";
import { equipmentTypeFormCommand } from "./designer/forms/equipment-type";
import { parseProject, serializeProject } from "./project";
import { applyCommand } from "./editor";
const project = parseProject(JSON.stringify(sample));
const slots = [{ name: "pressure", type: "number", direction: "read" }];
function input(typeId = "", encoded = JSON.stringify(slots)) {
  const data = new FormData();
  data.set("name", "圧力計");
  data.set("slots", encoded);
  return {
    connected: true,
    typeId,
    targetKey: `3:${project.manifest.projectId}:${typeId || "new"}`,
    data,
  };
}
it("builds one command containing the name and complete structure; refuses stale targets", () => {
  const source = input();
  expect(equipmentTypeFormCommand(source, project, 3)).toEqual({
    type: "create-equipment-type",
    name: "圧力計",
    slots,
  });
  const id = project.equipmentTypes![0].id;
  expect(equipmentTypeFormCommand(input(id), project, 3)).toEqual({
    type: "update-equipment-type",
    typeId: id,
    name: "圧力計",
    slots,
  });
  for (const changed of [
    { ...source, connected: false },
    { ...source, targetKey: "wrong" },
    input("missing"),
  ])
    expect(() => equipmentTypeFormCommand(changed, project, 3)).toThrow();
  expect(() => equipmentTypeFormCommand(source, project, 4)).toThrow();
});
it.each([
  "oops",
  JSON.stringify([{ name: "pressure\n", type: "number", direction: "read" }]),
  "null",
  "{}",
  JSON.stringify([{ name: "write", type: "bool", direction: "write" }]),
  JSON.stringify([{ name: "", type: "bool", direction: "read" }]),
  JSON.stringify([...slots, ...slots]),
  JSON.stringify(
    Array.from({ length: 65 }, (_, i) => ({ ...slots[0], name: `role${i}` })),
  ),
])("refuses invalid or oversized row structure: %s", (encoded) => {
  expect(() =>
    equipmentTypeFormCommand(input("", encoded), project, 3),
  ).toThrow();
});
it("keeps adopted null slots protected and rejects changes without a partial type rename", () => {
  const id = project.equipmentTypes![0].id;
  const before = serializeProject(project);
  expect(() =>
    applyCommand(
      project,
      equipmentTypeFormCommand(input(id), project, 3),
      "edit",
    ),
  ).toThrow("採用中slot");
  expect(serializeProject(project)).toBe(before);
});
