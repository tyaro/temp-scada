import { expect, it } from "vitest";
import sample from "../../../../examples/tag-binding.project.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand } from "./editor";
import { bindingReferences, searchReferences } from "./binding-references";
function fresh() {
  return parseProject(JSON.stringify(sample));
}
it("collects all screens, groups exact external names and preserves usage identity without changing Project", () => {
  const original = fresh();
  const project = applyCommand(
    original,
    { type: "duplicate-screen", screenId: original.screens[0].id },
    "edit",
  );
  const before = serializeProject(project);
  const references = bindingReferences(project);
  expect(references).toHaveLength(1);
  expect(references[0].externalName).toBe("PLC01.Fast.Tank01.Level");
  expect(references[0].usages.map((u) => u.screenId)).toEqual(
    project.screens.map((s) => s.id),
  );
  expect(references[0].usages.map((u) => u.objectId)).toEqual(
    project.screens.map((s) => s.objects[2].id),
  );
  expect(serializeProject(project)).toBe(before);
});
it("keeps case-different identities distinct while allowing normalized search across names and usages", () => {
  const original = fresh(),
    screenId = original.screens[0].id;
  const copy = applyCommand(
    original,
    {
      type: "duplicate",
      screenId,
      objectId: original.screens[0].objects[2].id,
    },
    "edit",
  );
  const project = applyCommand(
    copy,
    {
      type: "update",
      screenId,
      objectId: copy.screens[0].objects.at(-1)!.id,
      patch: { binding: { externalName: "plc01.fast.tank01.level" } },
    },
    "edit",
  );
  const references = bindingReferences(project);
  expect(references).toHaveLength(2);
  expect(searchReferences(references, " ＰＬＣ０１ ")).toHaveLength(2);
  expect(searchReferences(references, "Hub 未接続")).toHaveLength(2);
  expect(searchReferences(references, "静的テキスト")).toHaveLength(2);
  expect(searchReferences(references, "not-present")).toEqual([]);
  expect(searchReferences(references, " ")).toBe(references);
  expect(references.map((r) => r.externalName)).toEqual([
    "PLC01.Fast.Tank01.Level",
    "plc01.fast.tank01.level",
  ]);
});
it("removes only the edited reference and excludes unbound objects", () => {
  const project = fresh();
  const next = applyCommand(
    project,
    {
      type: "update",
      screenId: project.screens[0].id,
      objectId: project.screens[0].objects[2].id,
      patch: { binding: null },
    },
    "edit",
  );
  expect(bindingReferences(next)).toEqual([]);
  expect(bindingReferences(project)).toHaveLength(1);
});
