import { expect, it } from "vitest";
import sample from "../../../../examples/process.project.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand, symbolUsage, type EditCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
const fresh = () => parseProject(JSON.stringify(sample));
it("edits a definition without rewriting its placements and supports history", () => {
  const original = fresh(),
    definition = original.symbols[0];
  const command: EditCommand = {
    type: "move-many",
    screenId: definition.id,
    definitionId: definition.id,
    objectIds: definition.objects.map((o) => o.id),
    dx: 5,
    dy: -10,
  };
  let state = recordEdit(original, emptyHistory(), command, "edit");
  expect(state.project.screens).toEqual(original.screens);
  expect(state.project.symbols[0].objects[0]).toMatchObject({
    x: definition.objects[0].x + 5,
    y: definition.objects[0].y - 10,
  });
  expect(state.project.symbols[1]).toEqual(original.symbols[1]);
  expect(symbolUsage(state.project, definition.id)).toBeGreaterThan(0);
  const changed = state.project.symbols;
  state = travelHistory(state.project, state.history, "undo", "edit");
  expect(state.project.symbols).toEqual(original.symbols);
  state = travelHistory(state.project, state.history, "redo", "edit");
  expect(state.project.symbols).toEqual(changed);
  expect(original).toEqual(fresh());
});
it("creates and edits a custom definition, places it and protects used definitions", () => {
  let project = fresh();
  project = applyCommand(
    project,
    { type: "create-symbol", name: "  タンク  ", width: 120, height: 180 },
    "edit",
  );
  const definitionId = project.symbols.at(-1)!.id,
    screenId = project.screens[0].id;
  project = applyCommand(
    project,
    { type: "add", definitionId, screenId: definitionId, kind: "rectangle" },
    "edit",
  );
  project = applyCommand(
    project,
    {
      type: "update-symbol",
      symbolId: definitionId,
      name: "タンク A",
      width: 200,
      height: 300,
    },
    "edit",
  );
  const before = project;
  expect(
    applyCommand(
      project,
      {
        type: "update-symbol",
        symbolId: definitionId,
        name: "タンク A",
        width: 200,
        height: 300,
      },
      "edit",
    ),
  ).toBe(before);
  project = applyCommand(
    project,
    { type: "place-symbol", symbolId: definitionId, screenId },
    "edit",
  );
  expect(project.screens[0].objects.at(-1)).toMatchObject({
    width: 200,
    height: 300,
    shape: { type: "symbol", symbolId: definitionId },
  });
  expect(() =>
    applyCommand(
      project,
      { type: "remove-symbol", symbolId: definitionId },
      "edit",
    ),
  ).toThrow("使用中");
  expect(parseProject(serializeProject(project))).toEqual(project);
});
it("duplicates definition and child IDs without retargeting existing placements", () => {
  const original = fresh(),
    definition = original.symbols[0];
  let project = applyCommand(
    original,
    { type: "duplicate-symbol", symbolId: definition.id },
    "edit",
  );
  const clone = project.symbols.at(-1)!;
  expect(clone.name).toBe(definition.name + " コピー");
  expect(clone.objects.map(({ id: _, ...o }) => o)).toEqual(
    definition.objects.map(({ id: _, ...o }) => o),
  );
  expect(
    new Set([...definition.objects, ...clone.objects].map((o) => o.id)).size,
  ).toBe(definition.objects.length * 2);
  expect(project.screens).toEqual(original.screens);
  expect(symbolUsage(project, clone.id)).toBe(0);
  project = applyCommand(
    project,
    { type: "remove-symbol", symbolId: clone.id },
    "edit",
  );
  expect(project.symbols).toEqual(original.symbols);
});
it("rejects nested symbols, missing references and invalid metadata atomically", () => {
  const project = fresh(),
    definitionId = project.symbols[0].id,
    screenId = project.screens[0].id;
  const commands: EditCommand[] = [
    { type: "add-symbol", definitionId, screenId, template: "pump" },
    { type: "add", definitionId: "missing", screenId, kind: "rectangle" },
    { type: "place-symbol", symbolId: "missing", screenId },
    {
      type: "update-symbol",
      symbolId: definitionId,
      name: " ",
      width: 100,
      height: 100,
    },
    { type: "create-symbol", name: "A", width: 0, height: 100 },
  ];
  commands.forEach((command) =>
    expect(() => applyCommand(project, command, "edit")).toThrow(),
  );
  expect(() =>
    applyCommand(
      project,
      { type: "duplicate-symbol", symbolId: definitionId },
      "preview",
    ),
  ).toThrow("プレビュー");
  expect(project).toEqual(fresh());
});
it("retains at least one primitive in every definition and enforces the definition limit", () => {
  const created = applyCommand(
    fresh(),
    { type: "create-symbol", name: "A", width: 100, height: 100 },
    "edit",
  );
  const definition = created.symbols.at(-1)!;
  expect(() =>
    applyCommand(
      created,
      {
        type: "remove-many",
        screenId: definition.id,
        definitionId: definition.id,
        objectIds: definition.objects.map((o) => o.id),
      },
      "edit",
    ),
  ).toThrow("1 つ以上");
  let project = fresh();
  while (project.symbols.length < 100)
    project = applyCommand(
      project,
      { type: "create-symbol", name: "A", width: 100, height: 100 },
      "edit",
    );
  expect(() =>
    applyCommand(
      project,
      { type: "create-symbol", name: "A", width: 100, height: 100 },
      "edit",
    ),
  ).toThrow();
  expect(project.symbols).toHaveLength(100);
});
