import { expect, it } from "vitest";
import sample from "../../../../examples/process.project.json";
import minimal from "../../../../examples/minimal.project.json";
import cases from "../../../../examples/placement-name-cases.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand } from "./editor";
import { recordEdit, emptyHistory, travelHistory } from "./history";
import { copyObjects } from "./clipboard";
import { placementLabel } from "./placement-label";
import { symbolUsages } from "./symbol-usages";
import { bindingReferences, searchReferences } from "./binding-references";
const fresh = () => parseProject(JSON.stringify(sample));
for (const test of cases)
  it(`placement name contract: ${test.name}`, () => {
    for (const path of [
      ["screens", 0, "objects", 2],
      ["screens", 0, "objects", 7],
      ["screens", 0, "objects", 10],
      ["symbols", 0, "objects", 0],
    ] as const) {
      const value: any = structuredClone(sample);
      value[path[0]][path[1]][path[2]][path[3]].name = test.value;
      if (test.valid) {
        const project = parseProject(JSON.stringify(value));
        expect(parseProject(serializeProject(project))).toEqual(project);
      } else expect(() => parseProject(JSON.stringify(value))).toThrow();
    }
  });
it("supports names on ellipses and rejects the previous pre-release contract", () => {
  const value: any = structuredClone(minimal);
  value.screens[0].objects[1].name = "水槽";
  expect(parseProject(JSON.stringify(value)).screens[0].objects[1].name).toBe(
    "水槽",
  );
  value.manifest.schemaVersion = "0.4.0";
  expect(() => parseProject(JSON.stringify(value))).toThrow();
});
it("normalizes and clears a label without touching identity, binding, geometry or the shared definition", () => {
  const original = fresh(),
    screenId = original.screens[0].id,
    object = original.screens[0].objects[10];
  let result = recordEdit(
    original,
    emptyHistory(),
    {
      type: "update",
      screenId,
      objectId: object.id,
      patch: { name: "  P-101 原水ポンプ A  " },
    },
    "edit",
  );
  const named = result.project.screens[0].objects[10];
  expect(named).toEqual({ ...object, name: "P-101 原水ポンプ A" });
  expect(result.project.symbols).toEqual(original.symbols);
  expect(placementLabel(named, result.project.symbols)).toBe(named.name);
  const same = recordEdit(
    result.project,
    result.history,
    {
      type: "update",
      screenId,
      objectId: object.id,
      patch: { name: " P-101 原水ポンプ A " },
    },
    "edit",
  );
  expect(same.project).toBe(result.project);
  expect(same.history).toBe(result.history);
  result = recordEdit(
    result.project,
    result.history,
    { type: "update", screenId, objectId: object.id, patch: { name: "  " } },
    "edit",
  );
  expect(result.project.screens[0].objects[10]).not.toHaveProperty("name");
  expect(
    placementLabel(
      result.project.screens[0].objects[10],
      result.project.symbols,
    ),
  ).toBe("ポンプ · 10");
  result = travelHistory(result.project, result.history, "undo", "edit");
  expect(result.project.screens[0].objects[10].name).toBe(named.name);
});
it("keeps duplicate names through duplicate, clipboard paste and independent shared definitions", () => {
  let project = fresh();
  const screenId = project.screens[0].id,
    objectId = project.screens[0].objects[10].id;
  project = applyCommand(
    project,
    { type: "update", screenId, objectId, patch: { name: "ポンプ A" } },
    "edit",
  );
  const definitionId = project.symbols[0].id,
    child = project.symbols[0].objects[0];
  project = applyCommand(
    project,
    {
      type: "update",
      screenId: definitionId,
      definitionId,
      objectId: child.id,
      patch: { name: "本体線" },
    },
    "edit",
  );
  const fragment = copyObjects(project, screenId, [objectId], "source");
  project = applyCommand(
    project,
    { type: "duplicate", screenId, objectId },
    "edit",
  );
  expect(
    project.screens[0].objects.filter((o) => o.name === "ポンプ A"),
  ).toHaveLength(2);
  project = applyCommand(
    project,
    {
      type: "paste",
      screenId,
      text: fragment,
      origin: "different",
      center: { x: 400, y: 300 },
    },
    "edit",
  );
  const pasted = project.screens[0].objects.at(-1)!;
  expect(pasted.name).toBe("ポンプ A");
  expect(pasted.shape.type).toBe("symbol");
  if (pasted.shape.type !== "symbol") throw Error("not symbol");
  const pastedId = pasted.shape.symbolId;
  expect(pastedId).not.toBe(definitionId);
  expect(project.symbols.find((s) => s.id === pastedId)!.objects[0].name).toBe(
    "本体線",
  );
});
it("finds named usages while preserving exact references and text values", () => {
  const project = fresh(),
    pump = project.screens[0].objects[10],
    text = project.screens[0].objects[6];
  pump.name = "原水ポンプ A";
  text.name = "原水タンク 液位";
  if (text.shape.type !== "text") throw Error("not text");
  text.shape.binding = { externalName: "Exact.Tag.Name" };
  const references = bindingReferences(project);
  expect(searchReferences(references, "原水タンク")[0].externalName).toBe(
    "Exact.Tag.Name",
  );
  expect(searchReferences(references, "原水タンク")[0].usages[0].text).toBe(
    text.shape.text,
  );
  expect(symbolUsages(project, project.symbols[0].id)[0].name).toBe(pump.name);
});
