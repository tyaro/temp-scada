import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import { parseProject, serializeProject, getBounds } from "./project";
import { applyCommand } from "./editor";
import { copyObjects, parseClipboard, CLIPBOARD_LIMIT } from "./clipboard";
import { emptyHistory, recordEdit, travelHistory } from "./history";
const fresh = () => parseProject(JSON.stringify(sample));
it("copies a validated snapshot without changing Project and pastes fresh IDs with relative order, offsets and one undo", () => {
  const project = fresh(),
    screen = project.screens[0],
    ids = screen.objects.slice(0, 2).map((o) => o.id),
    before = serializeProject(project);
  const text = copyObjects(project, screen.id, ids, "workspace-a");
  expect(serializeProject(project)).toBe(before);
  const result = recordEdit(
    project,
    emptyHistory(),
    {
      type: "paste",
      screenId: screen.id,
      text,
      origin: "workspace-a",
      center: { x: 500, y: 300 },
    },
    "edit",
  );
  const copies = result.project.screens[0].objects.slice(3);
  expect(copies).toHaveLength(2);
  expect(copies[0].id).not.toBe(ids[0]);
  expect(copies[1].x - copies[0].x).toBe(470);
  expect(copies.map((o) => o.order)).toEqual([6, 7]);
  const left = Math.min(...copies.map((o) => o.x + getBounds(o).x)),
    right = Math.max(
      ...copies.map((o) => o.x + getBounds(o).x + getBounds(o).width),
    );
  expect((left + right) / 2).toBe(500);
  expect(result.history.past).toHaveLength(1);
  expect(
    travelHistory(result.project, result.history, "undo", "edit").project
      .screens,
  ).toEqual(project.screens);
  expect(parseClipboard(text).project.screens[0].objects[0].id).toBe(ids[0]);
});
it("reuses a live symbol only within the same workspace and imports snapshot definitions otherwise", () => {
  const base = fresh();
  const project = applyCommand(
    base,
    { type: "add-symbol", screenId: base.screens[0].id, template: "pump" },
    "edit",
  );
  const screen = project.screens[0],
    symbol = project.symbols[0],
    text = copyObjects(
      project,
      screen.id,
      [screen.objects.at(-1)!.id],
      "origin-a",
    );
  const updated = applyCommand(
    project,
    {
      type: "update-symbol",
      symbolId: symbol.id,
      name: "最新版",
      width: 120,
      height: 110,
    },
    "edit",
  );
  const live = applyCommand(
    updated,
    {
      type: "paste",
      screenId: screen.id,
      text,
      origin: "origin-a",
      center: { x: 300, y: 200 },
    },
    "edit",
  );
  expect(live.symbols).toHaveLength(1);
  expect(live.screens[0].objects.at(-1)!.shape).toEqual({
    type: "symbol",
    symbolId: symbol.id,
  });
  const imported = applyCommand(
    updated,
    {
      type: "paste",
      screenId: screen.id,
      text,
      origin: "reloaded-origin",
      center: { x: 300, y: 200 },
    },
    "edit",
  );
  expect(imported.symbols).toHaveLength(2);
  expect(imported.symbols[1].name).toBe("ポンプ");
  expect(imported.symbols[1].id).not.toBe(symbol.id);
  expect(imported.symbols[1].objects[0].id).not.toBe(symbol.objects[0].id);
  const foreign = applyCommand(
    base,
    {
      type: "paste",
      screenId: base.screens[0].id,
      text,
      origin: "other",
      center: { x: 300, y: 200 },
    },
    "edit",
  );
  expect(foreign.symbols).toHaveLength(1);
  expect(foreign.screens[0].objects.at(-1)!.shape).toEqual({
    type: "symbol",
    symbolId: foreign.symbols[0].id,
  });
});
it("deduplicates symbol dependencies, preserves binding and rejects nested or bound objects atomically", () => {
  const base = fresh();
  let project = applyCommand(
    base,
    { type: "add-symbol", screenId: base.screens[0].id, template: "pump" },
    "edit",
  );
  const screenId = project.screens[0].id,
    pump = project.screens[0].objects.at(-1)!;
  project = applyCommand(
    project,
    { type: "duplicate", screenId, objectId: pump.id },
    "edit",
  );
  const ids = project.screens[0].objects.slice(3).map((o) => o.id);
  const text = copyObjects(project, screenId, ids, "a");
  const imported = applyCommand(
    base,
    { type: "paste", screenId, text, origin: "b", center: { x: 300, y: 300 } },
    "edit",
  );
  expect(imported.symbols).toHaveLength(1);
  expect(imported.screens[0].objects.slice(3).map((o) => o.shape)).toEqual(
    Array(2).fill({ type: "symbol", symbolId: imported.symbols[0].id }),
  );
  const before = serializeProject(project);
  expect(() =>
    applyCommand(
      project,
      {
        type: "paste",
        screenId,
        definitionId: project.symbols[0].id,
        text,
        origin: "a",
        center: { x: 40, y: 40 },
      },
      "edit",
    ),
  ).toThrow("貼り付けできません");
  expect(serializeProject(project)).toBe(before);
  const textId = project.screens[0].objects[2].id;
  project = applyCommand(
    project,
    {
      type: "update",
      screenId,
      objectId: textId,
      patch: { binding: { externalName: "PLC.Tank.Level" } },
    },
    "edit",
  );
  const bound = copyObjects(project, screenId, [textId], "a");
  const pasted = applyCommand(
    project,
    {
      type: "paste",
      screenId,
      text: bound,
      origin: "a",
      center: { x: 300, y: 300 },
    },
    "edit",
  );
  expect(pasted.screens[0].objects.at(-1)!.shape).toMatchObject({
    binding: { externalName: "PLC.Tank.Level" },
  });
  expect(() =>
    applyCommand(
      project,
      {
        type: "paste",
        screenId,
        definitionId: project.symbols[0].id,
        text: bound,
        origin: "a",
        center: { x: 30, y: 30 },
      },
      "edit",
    ),
  ).toThrow("貼り付けできません");
});
it("rejects invalid envelopes, oversized text, broken references, empty/duplicate selections and preview edits", () => {
  const project = fresh(),
    screen = project.screens[0],
    text = copyObjects(project, screen.id, [screen.objects[0].id], "a");
  for (const bad of [
    "plain text",
    "{}",
    JSON.stringify({ ...JSON.parse(text), version: 2 }),
    JSON.stringify({ ...JSON.parse(text), extra: 1 }),
    "x".repeat(CLIPBOARD_LIMIT + 1),
  ])
    expect(() => parseClipboard(bad)).toThrow();
  const bad = JSON.parse(text);
  bad.project.screens[0].objects[0].shape = {
    type: "symbol",
    symbolId: screen.id,
  };
  expect(() => parseClipboard(JSON.stringify(bad))).toThrow();
  expect(() => copyObjects(project, screen.id, [], "a")).toThrow();
  expect(() =>
    copyObjects(
      project,
      screen.id,
      [screen.objects[0].id, screen.objects[0].id],
      "a",
    ),
  ).toThrow();
  expect(() =>
    applyCommand(
      project,
      {
        type: "paste",
        screenId: screen.id,
        text,
        origin: "a",
        center: { x: 0, y: 0 },
      },
      "preview",
    ),
  ).toThrow();
});
