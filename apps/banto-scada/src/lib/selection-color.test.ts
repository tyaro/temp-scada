import { expect, it } from "vitest";
import sample from "../../../../examples/process.project.json";
import { applyCommand, type EditCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { parseProject, serializeProject } from "./project";
const fresh = () => parseProject(JSON.stringify(sample));

it("colors mixed primitive, text, pipe and Symbol placements without changing definitions or geometry", () => {
  const original = fresh(),
    screen = original.screens[0];
  const result = applyCommand(
    original,
    {
      type: "set-color",
      screenId: screen.id,
      objectIds: screen.objects.map((o) => o.id),
      fill: "#2563EB",
    },
    "edit",
  );
  expect(result.symbols).toEqual(original.symbols);
  expect(result.screens[0].objects).toEqual(
    screen.objects.map((o) => ({
      ...o,
      fill: o.fill.toLowerCase() === "#2563eb" ? o.fill : "#2563eb",
    })),
  );
  expect(result.manifest.projectRevision).toBe(
    original.manifest.projectRevision + 1,
  );
  expect(parseProject(serializeProject(result))).toEqual(result);
  expect(original).toEqual(fresh());
});
it("refuses missing, duplicate, empty and locked targets or invalid colors atomically", () => {
  const original = fresh(),
    screenId = original.screens[0].id,
    ids = original.screens[0].objects.slice(0, 2).map((o) => o.id);
  const base = {
    type: "set-color" as const,
    screenId,
    objectIds: ids,
    fill: "#123456",
  };
  const commands: EditCommand[] = [
    ...[[], [ids[0], ids[0]], [ids[0], "missing"]].map((objectIds) => ({
      ...base,
      objectIds,
    })),
    ...["", "red", "#123", "#12345678", "#xyzxyz"].map((fill) => ({
      ...base,
      fill,
    })),
  ];
  for (const command of commands)
    expect(() => applyCommand(original, command, "edit")).toThrow();
  const locked = applyCommand(
    original,
    { type: "set-lock", screenId, objectId: ids[1], locked: true },
    "edit",
  );
  const before = serializeProject(locked);
  expect(() => applyCommand(locked, base, "edit")).toThrow("ロック");
  expect(serializeProject(locked)).toBe(before);
  expect(() => applyCommand(original, base, "preview")).toThrow("プレビュー");
  expect(original).toEqual(fresh());
});
it("allows explicit hidden editing, preserves metadata, and keeps the whole color edit in one Undo", () => {
  const original = fresh(),
    screenId = original.screens[0].id,
    ids = original.screens[0].objects.slice(0, 2).map((o) => o.id);
  original.screens[0].objects[0].visible = false;
  original.screens[0].objects[0].name = "原水設備";
  const history = emptyHistory();
  const colored = recordEdit(
    original,
    history,
    { type: "set-color", screenId, objectIds: ids, fill: "#AABBCC" },
    "edit",
  );
  expect(colored.history.past).toHaveLength(1);
  expect(colored.project.screens[0].objects[0]).toMatchObject({
    visible: false,
    name: "原水設備",
    fill: "#aabbcc",
  });
  expect(
    recordEdit(
      colored.project,
      colored.history,
      { type: "set-color", screenId, objectIds: ids, fill: "#aAbBcC" },
      "edit",
    ),
  ).toEqual(colored);
  const undone = travelHistory(
    colored.project,
    colored.history,
    "undo",
    "edit",
  );
  expect(undone.project.screens).toEqual(original.screens);
  expect(
    travelHistory(undone.project, undone.history, "redo", "edit").project
      .screens,
  ).toEqual(colored.project.screens);
});
it("colors shared definition children only when that definition is the explicit editing target", () => {
  const original = fresh(),
    definition = original.symbols[0];
  const result = applyCommand(
    original,
    {
      type: "set-color",
      screenId: definition.id,
      definitionId: definition.id,
      objectIds: definition.objects.slice(0, 2).map((o) => o.id),
      fill: "#16a34a",
    },
    "edit",
  );
  expect(result.screens).toEqual(original.screens);
  expect(
    result.symbols[0].objects.slice(0, 2).every((o) => o.fill === "#16a34a"),
  ).toBe(true);
  expect(result.symbols[0].objects.slice(2)).toEqual(
    definition.objects.slice(2),
  );
});
