import { expect, it } from "vitest";
import sample from "../../../../examples/process.project.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand, type EditCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
const fresh = () => parseProject(JSON.stringify(sample));
it("creates, renames and resizes a screen without scaling placements", () => {
  const original = fresh();
  const screen = original.screens[0];
  const resized = applyCommand(
    original,
    {
      type: "update-screen",
      screenId: screen.id,
      name: "  工程 A  ",
      width: 1920,
      height: 1080,
    },
    "edit",
  );
  expect(resized.screens[0]).toEqual({
    ...screen,
    name: "工程 A",
    width: 1920,
    height: 1080,
  });
  expect(
    applyCommand(
      resized,
      {
        type: "update-screen",
        screenId: screen.id,
        name: "工程 A",
        width: 1920,
        height: 1080,
      },
      "edit",
    ),
  ).toBe(resized);
  const created = applyCommand(
    resized,
    { type: "create-screen", name: "工程 B", width: 800, height: 600 },
    "edit",
  );
  expect(created.screens[1]).toMatchObject({
    name: "工程 B",
    width: 800,
    height: 600,
    objects: [],
  });
  expect(original).toEqual(fresh());
});
it("duplicates placement data with fresh IDs and shared symbol definitions", () => {
  const original = fresh();
  const copy = applyCommand(
    original,
    { type: "duplicate-screen", screenId: original.screens[0].id },
    "edit",
  );
  const [source, target] = copy.screens;
  expect(target.id).not.toBe(source.id);
  expect(target.objects.map(({ id: _id, ...o }) => o)).toEqual(
    source.objects.map(({ id: _id, ...o }) => o),
  );
  expect(
    new Set(copy.screens.flatMap((s) => [s.id, ...s.objects.map((o) => o.id)]))
      .size,
  ).toBe(2 + source.objects.length * 2);
  expect(copy.symbols).toEqual(original.symbols);
  const line = target.objects.find((o) => o.shape.type === "polyline")!;
  const edited = applyCommand(
    copy,
    {
      type: "move-vertex",
      screenId: target.id,
      objectId: line.id,
      index: 0,
      point: { x: -25, y: 15 },
    },
    "edit",
  );
  expect(edited.screens[0]).toEqual(original.screens[0]);
  expect(copy.screens[1]).toEqual(target);
  expect(parseProject(serializeProject(edited))).toEqual(edited);
});
it("rejects invalid screen changes atomically, including last deletion and preview edits", () => {
  const original = fresh(),
    screenId = original.screens[0].id;
  const commands: EditCommand[] = [
    { type: "remove-screen", screenId },
    { type: "duplicate-screen", screenId: "missing" },
    { type: "create-screen", name: "  ", width: 800, height: 600 },
    { type: "create-screen", name: "A", width: Infinity, height: 600 },
    { type: "update-screen", screenId, name: "A", width: 0, height: 600 },
    {
      type: "update-screen",
      screenId,
      name: "a".repeat(201),
      width: 800,
      height: 600,
    },
  ];
  commands.forEach((command) =>
    expect(() => applyCommand(original, command, "edit")).toThrow(),
  );
  expect(() =>
    applyCommand(original, { type: "duplicate-screen", screenId }, "preview"),
  ).toThrow("プレビュー");
  expect(original).toEqual(fresh());
});
it("restores screen collections through history with increasing revisions", () => {
  let state = recordEdit(
    fresh(),
    emptyHistory(),
    { type: "duplicate-screen", screenId: fresh().screens[0].id },
    "edit",
  );
  const duplicated = state.project.screens;
  state = recordEdit(
    state.project,
    state.history,
    { type: "remove-screen", screenId: state.project.screens[0].id },
    "edit",
  );
  expect(state.project.screens).toHaveLength(1);
  state = travelHistory(state.project, state.history, "undo", "edit");
  expect(state.project.screens).toEqual(duplicated);
  state = travelHistory(state.project, state.history, "redo", "edit");
  expect(state.project.screens).toEqual([duplicated[1]]);
  expect(state.project.manifest.projectRevision).toBe(
    fresh().manifest.projectRevision + 4,
  );
});

it("reorders complete screens without changing identities, data or selection targets, with one history operation", () => {
  let original = fresh();
  original = applyCommand(
    original,
    { type: "duplicate-screen", screenId: original.screens[0].id },
    "edit",
  );
  original = applyCommand(
    original,
    { type: "create-screen", name: "工程 C", width: 800, height: 600 },
    "edit",
  );
  const ids = original.screens.map((s) => s.id);
  const command: EditCommand = {
    type: "reorder-screen",
    screenId: ids[1],
    direction: "up",
  };
  let state = recordEdit(original, emptyHistory(), command, "edit");
  expect(state.project.screens).toEqual([
    original.screens[1],
    original.screens[0],
    original.screens[2],
  ]);
  expect(state.project.symbols).toEqual(original.symbols);
  expect(state.project.manifest.projectRevision).toBe(
    original.manifest.projectRevision + 1,
  );
  expect(state.history.past).toHaveLength(1);
  expect(parseProject(serializeProject(state.project))).toEqual(state.project);
  state = travelHistory(state.project, state.history, "undo", "edit");
  expect(state.project.screens).toEqual(original.screens);
  state = travelHistory(state.project, state.history, "redo", "edit");
  expect(state.project.screens[0].id).toBe(ids[1]);
  const down = applyCommand(
    state.project,
    { type: "reorder-screen", screenId: ids[1], direction: "down" },
    "edit",
  );
  expect(down.screens).toEqual(original.screens);
  expect(original.screens.map((s) => s.id)).toEqual(ids);
});
it("does not record moves beyond screen boundaries and rejects missing targets and preview changes", () => {
  const original = fresh(),
    screenId = original.screens[0].id;
  for (const direction of ["up", "down"] as const) {
    const command: EditCommand = {
      type: "reorder-screen",
      screenId,
      direction,
    };
    expect(
      recordEdit(original, emptyHistory(), command, "edit").history.past,
    ).toHaveLength(0);
    expect(applyCommand(original, command, "edit")).toBe(original);
    expect(() => applyCommand(original, command, "preview")).toThrow(
      "プレビュー",
    );
  }
  expect(() =>
    applyCommand(
      original,
      { type: "reorder-screen", screenId: "missing", direction: "up" },
      "edit",
    ),
  ).toThrow("画面");
});
