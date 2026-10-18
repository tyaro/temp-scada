import { expect, it } from "vitest";
import sample from "../../../../examples/process.project.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand, type EditCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
function fresh() {
  return parseProject(JSON.stringify(sample));
}
function target(project = fresh()) {
  const screen = project.screens[0];
  return {
    screenId: screen.id,
    object: screen.objects.find((object) => object.shape.type === "symbol")!,
  };
}
it("replaces only the selected placement reference and keeps geometry, identity and shared definitions intact", () => {
  const project = fresh(),
    { screenId, object } = target(project);
  const nextDefinition = project.symbols.find(
    (definition) =>
      object.shape.type === "symbol" && definition.id !== object.shape.symbolId,
  )!;
  const command: EditCommand = {
    type: "update",
    screenId,
    objectId: object.id,
    patch: { symbolId: nextDefinition.id },
  };
  let state = recordEdit(project, emptyHistory(), command, "edit");
  expect(state.project.screens[0].objects).toEqual(
    project.screens[0].objects.map((item) =>
      item.id === object.id
        ? { ...item, shape: { type: "symbol", symbolId: nextDefinition.id } }
        : item,
    ),
  );
  expect(state.project.symbols).toEqual(project.symbols);
  expect(state.history.past).toHaveLength(1);
  expect(applyCommand(state.project, command, "edit")).toBe(state.project);
  const changed = state.project.screens;
  state = travelHistory(state.project, state.history, "undo", "edit");
  expect(state.project.screens).toEqual(project.screens);
  state = travelHistory(state.project, state.history, "redo", "edit");
  expect(state.project.screens).toEqual(changed);
  expect(parseProject(serializeProject(state.project))).toEqual(state.project);
  expect(project).toEqual(fresh());
});
it("makes a deep independent definition and reassigns one placement in a single history step", () => {
  const initial = fresh(),
    { screenId, object } = target(initial);
  const project = applyCommand(
    initial,
    { type: "duplicate-screen", screenId },
    "edit",
  );
  const source = project.symbols.find(
    (definition) =>
      object.shape.type === "symbol" && definition.id === object.shape.symbolId,
  )!;
  let state = recordEdit(
    project,
    emptyHistory(),
    { type: "make-symbol-unique", screenId, objectId: object.id },
    "edit",
  );
  expect(state.history.past).toHaveLength(1);
  expect(state.project.manifest.projectRevision).toBe(
    project.manifest.projectRevision + 1,
  );
  expect(state.project.symbols).toHaveLength(project.symbols.length + 1);
  const copy = state.project.symbols.at(-1)!;
  expect(copy.id).not.toBe(source.id);
  expect(copy.objects.map(({ id, ...rest }) => rest)).toEqual(
    source.objects.map(({ id, ...rest }) => rest),
  );
  const originalIds = new Set([
    source.id,
    ...source.objects.map((object) => object.id),
  ]);
  expect(
    [copy.id, ...copy.objects.map((object) => object.id)].every(
      (id) => !originalIds.has(id),
    ),
  ).toBe(true);
  expect(
    state.project.screens[0].objects.find((item) => item.id === object.id),
  ).toEqual({ ...object, shape: { type: "symbol", symbolId: copy.id } });
  expect(state.project.screens[1]).toEqual(project.screens[1]);
  const changed = state.project;
  state = travelHistory(state.project, state.history, "undo", "edit");
  expect(state.project.screens).toEqual(project.screens);
  expect(state.project.symbols).toEqual(project.symbols);
  state = travelHistory(state.project, state.history, "redo", "edit");
  expect(state.project.screens).toEqual(changed.screens);
  expect(state.project.symbols).toEqual(changed.symbols);
  const edited = applyCommand(
    changed,
    {
      type: "update",
      screenId: copy.id,
      definitionId: copy.id,
      objectId: copy.objects[0].id,
      patch: { x: copy.objects[0].x + 10 },
    },
    "edit",
  );
  expect(
    edited.symbols.find((definition) => definition.id === source.id),
  ).toEqual(source);
  expect(edited.screens[1]).toEqual(project.screens[1]);
  expect(parseProject(serializeProject(edited))).toEqual(edited);
});
it("rejects invalid targets, missing references, nested definitions and preview edits without changing the source", () => {
  const project = fresh(),
    { screenId, object } = target(project);
  const commands: EditCommand[] = [
    {
      type: "make-symbol-unique",
      screenId,
      objectId: project.screens[0].objects.find(
        (item) => item.shape.type !== "symbol",
      )!.id,
    },
    { type: "make-symbol-unique", screenId, objectId: "missing" },
    {
      type: "update",
      screenId,
      objectId: object.id,
      patch: { symbolId: "missing" },
    },
    {
      type: "update",
      screenId,
      objectId: project.screens[0].objects.find(
        (item) => item.shape.type !== "symbol",
      )!.id,
      patch: { symbolId: project.symbols[0].id },
    },
    {
      type: "update",
      screenId,
      definitionId: project.symbols[0].id,
      objectId: project.symbols[0].objects[0].id,
      patch: { symbolId: project.symbols[1].id },
    },
    {
      type: "make-symbol-unique",
      screenId,
      definitionId: project.symbols[0].id,
      objectId: project.symbols[0].objects[0].id,
    },
  ];
  for (const command of commands)
    expect(() =>
      recordEdit(project, emptyHistory(), command, "edit"),
    ).toThrow();
  expect(() =>
    applyCommand(
      project,
      { type: "make-symbol-unique", screenId, objectId: object.id },
      "preview",
    ),
  ).toThrow("プレビュー");
  expect(project).toEqual(fresh());
});
