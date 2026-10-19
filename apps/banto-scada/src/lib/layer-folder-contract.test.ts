import { describe, expect, it } from "vitest";
import sample from "../../../../examples/process.project.json";
import cases from "../../../../examples/layer-folder-cases.json";
import { parseProject, serializeProject } from "./project";

const id = (index: number) =>
  `0199fb00-0000-7000-8000-${String(index + 1).padStart(12, "0")}`;
const foreignId = "0199fb01-0000-7000-8000-000000000001";
const missingId = "0199fbff-0000-7000-8000-000000000001";
// The same recipes are expanded in scada-model's Rust contract test.
function fixture(test: Record<string, any>, definition: boolean) {
  const project: any = structuredClone(sample);
  const owner = definition ? project.symbols[0] : project.screens[0];
  const foreign = definition ? project.screens[0] : project.symbols[0];
  foreign.folders = [{ id: foreignId, name: "別の所有先", order: 0 }];
  owner.folders = Array.from({ length: test.count ?? 2 }, (_, index) => ({
    id: id(index),
    name: test.sameNames ? test.nameValue : `設備 ${index + 1}`,
    order: index,
  }));
  const folders = owner.folders;
  if (folders.length) {
    const first = folders[0];
    if (test.nameValue !== undefined) first.name = test.nameValue;
    if (test.order !== undefined) first.order = test.order;
    const collision = {
      owner: owner.id,
      object: owner.objects[0].id,
      manifest: project.manifest.projectId,
      foreign: foreignId,
    }[test.collision as "owner" | "object" | "manifest" | "foreign"];
    if (collision) first.id = collision;
    if (test.collision === "folder") folders[1].id = first.id;
    if (test.duplicateOrder) folders[1].order = first.order;
    if (test.chain !== false)
      for (let index = 1; index < folders.length; index++)
        folders[index].parentId = folders[index - 1].id;
    if (test.extraField) first.futureFeature = true;
    if (test.parent)
      first.parentId = (
        {
          missing: missingId,
          foreign: foreignId,
          self: first.id,
          cycle: folders[1]?.id,
          null: null,
        } as Record<string, unknown>
      )[test.parent];
    for (const object of owner.objects) object.folderId = folders.at(-1).id;
  }
  if (test.membership)
    owner.objects[0].folderId = (
      {
        missing: missingId,
        foreign: foreignId,
        null: null,
        array: [folders[0]?.id],
      } as Record<string, unknown>
    )[test.membership];
  if (test.folders === "missing") delete owner.folders;
  if (test.folders === "null") owner.folders = null;
  return project;
}

for (const definition of [false, true])
  describe(definition ? "shared definition folders" : "screen folders", () => {
    for (const test of cases)
      it(test.name, () => {
        const value = fixture(test, definition);
        if (test.valid) {
          const project = parseProject(JSON.stringify(value));
          expect(parseProject(serializeProject(project))).toEqual(project);
        } else expect(() => parseProject(JSON.stringify(value))).toThrow();
      });
  });
