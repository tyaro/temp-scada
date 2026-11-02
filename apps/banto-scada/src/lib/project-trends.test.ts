import { it, expect } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import trendSample from "../../../../examples/trend.project.json";
import {
  cases,
  trendPlacementCase,
} from "./__fixtures__/trend-placement-cases";
import { parseProject, serializeProject } from "./project";
import { applyCommand, newId } from "./editor";
import { copyObjects, parseClipboard } from "./clipboard";
import { emptyHistory, recordEdit, travelHistory } from "./history";
const fresh = () => parseProject(JSON.stringify(sample));
const placed = () => parseProject(JSON.stringify(trendSample));
const def = () => ({
  ...structuredClone(trendSample.trends[0]),
  mode: "raw" as const,
});
const frame = { x: 50, y: 50, width: 320, height: 120 };
it.each(cases)("native/TS Project Trend contract: $name", (fixture) => {
  const input = trendPlacementCase(fixture),
    before = structuredClone(input);
  if (fixture.accepted) {
    const project = parseProject(JSON.stringify(input));
    expect(parseProject(serializeProject(project))).toEqual(project);
  } else expect(() => parseProject(JSON.stringify(input))).toThrow();
  expect(input).toEqual(before);
});
it("creates the definition and first placement in one Undo transaction", () => {
  const project = fresh(),
    screenId = project.screens[0].id;
  const result = recordEdit(
    project,
    emptyHistory(),
    {
      type: "save-trend",
      create: true,
      definition: def(),
      placement: { screenId, frame },
    },
    "edit",
  );
  expect(result.history.past).toHaveLength(1);
  expect(result.project.trends).toEqual([def()]);
  expect(result.project.screens[0].objects.at(-1)?.shape).toEqual({
    type: "trend",
    trendId: def().id,
  });
  const undone = travelHistory(result.project, result.history, "undo", "edit");
  expect(undone.project.trends).toBeUndefined();
  expect(undone.project.screens[0].objects).toEqual(project.screens[0].objects);
  const redone = travelHistory(undone.project, undone.history, "redo", "edit");
  expect(redone.project.trends).toEqual(result.project.trends);
  expect(redone.project.manifest.projectRevision).toBeGreaterThan(
    result.project.manifest.projectRevision,
  );
});
it("validates definition and placement before committing either", () => {
  const p = fresh(),
    before = serializeProject(p);
  for (const command of [
    {
      type: "save-trend" as const,
      create: true,
      definition: { ...def(), name: " " },
      placement: { screenId: p.screens[0].id, frame },
    },
    {
      type: "save-trend" as const,
      create: true,
      definition: def(),
      placement: { screenId: "missing", frame },
    },
    {
      type: "save-trend" as const,
      create: true,
      definition: def(),
      placement: { screenId: p.screens[0].id, frame: { ...frame, width: -1 } },
    },
  ])
    expect(() => applyCommand(p, command, "edit")).toThrow();
  expect(serializeProject(p)).toBe(before);
});
it("updates shared definitions, rejects stale create/update and protects referenced deletion", () => {
  const p = placed(),
    value = { ...def(), name: "共有変更" };
  const next = applyCommand(
    p,
    { type: "save-trend", create: false, definition: value },
    "edit",
  );
  expect(next.trends?.[0].name).toBe("共有変更");
  expect(p.trends?.[0].name).toBe(def().name);
  expect(
    applyCommand(
      next,
      { type: "save-trend", create: false, definition: value },
      "edit",
    ),
  ).toBe(next);
  expect(() =>
    applyCommand(
      p,
      { type: "save-trend", create: true, definition: def() },
      "edit",
    ),
  ).toThrow();
  expect(() =>
    applyCommand(
      p,
      {
        type: "save-trend",
        create: false,
        definition: { ...def(), id: "missing" },
      },
      "edit",
    ),
  ).toThrow();
  expect(() =>
    applyCommand(p, { type: "remove-trend", trendId: def().id }, "edit"),
  ).toThrow(/参照/);
  const removed = applyCommand(
    p,
    {
      type: "remove",
      screenId: p.screens[0].id,
      objectId: p.screens[0].objects.at(-1)!.id,
    },
    "edit",
  );
  expect(removed.trends).toHaveLength(1);
  expect(
    applyCommand(removed, { type: "remove-trend", trendId: def().id }, "edit")
      .trends,
  ).toEqual([]);
});
it("keeps definition references for placement/screen duplication but gives an independent definition new IDs", () => {
  const p = placed(),
    screenId = p.screens[0].id,
    objectId = p.screens[0].objects.at(-1)!.id;
  const duplicate = applyCommand(
    p,
    { type: "duplicate", screenId, objectId },
    "edit",
  );
  expect(duplicate.screens[0].objects.at(-1)?.shape).toEqual({
    type: "trend",
    trendId: def().id,
  });
  expect(duplicate.trends).toHaveLength(1);
  const screen = applyCommand(
    p,
    { type: "duplicate-screen", screenId },
    "edit",
  );
  expect(screen.screens.at(-1)?.objects.at(-1)?.shape).toEqual({
    type: "trend",
    trendId: def().id,
  });
  const unique = applyCommand(
    p,
    { type: "make-trend-unique", screenId, objectId },
    "edit",
  );
  expect(unique.trends).toHaveLength(2);
  expect(unique.trends?.[1].id).not.toBe(def().id);
  expect(unique.trends?.[1].pens[0].id).not.toBe(def().pens[0].id);
  expect(unique.trends?.[1].historianNamespace).toBe(def().historianNamespace);
  expect(unique.trends?.[1].pens[0].seriesId).toBe(def().pens[0].seriesId);
});
it("guards locks, preview, missing references, Symbol targets and generic color atomically", () => {
  const p = placed(),
    screenId = p.screens[0].id,
    objectId = p.screens[0].objects.at(-1)!.id;
  expect(() =>
    applyCommand(
      p,
      { type: "make-trend-unique", screenId, objectId },
      "preview",
    ),
  ).toThrow();
  expect(() =>
    applyCommand(
      p,
      { type: "update", screenId, objectId, patch: { trendId: "missing" } },
      "edit",
    ),
  ).toThrow();
  expect(() =>
    applyCommand(
      p,
      {
        type: "set-color",
        screenId,
        objectIds: [p.screens[0].objects[0].id, objectId],
        fill: "#ffffff",
      },
      "edit",
    ),
  ).toThrow();
  const locked = applyCommand(
    p,
    { type: "set-lock", screenId, objectId, locked: true },
    "edit",
  );
  expect(() =>
    applyCommand(
      locked,
      { type: "make-trend-unique", screenId, objectId },
      "edit",
    ),
  ).toThrow(/ロック/);
  const symbol = applyCommand(
    p,
    { type: "create-symbol", name: "test", width: 300, height: 150 },
    "edit",
  );
  expect(() =>
    applyCommand(
      symbol,
      {
        type: "save-trend",
        create: false,
        definition: def(),
        placement: { screenId: symbol.symbols[0].id, frame },
      },
      "edit",
    ),
  ).toThrow();
});
it("refuses system clipboard with trends even when origin and Project IDs match", () => {
  const p = placed(),
    screenId = p.screens[0].id,
    objectId = p.screens[0].objects.at(-1)!.id;
  expect(() => copyObjects(p, screenId, [objectId], "same-origin")).toThrow(
    /トレンド/,
  );
  const envelope = JSON.stringify({
    format: "banto-scada.objects",
    version: 1,
    origin: "same-origin",
    project: p,
  });
  expect(() => parseClipboard(envelope)).toThrow(/トレンド/);
  expect(() =>
    applyCommand(
      p,
      {
        type: "paste",
        screenId,
        text: envelope,
        origin: "same-origin",
        center: { x: 50, y: 50 },
      },
      "edit",
    ),
  ).toThrow();
  expect(() =>
    copyObjects(p, screenId, [p.screens[0].objects[0].id], "same-origin"),
  ).not.toThrow();
});
it("refuses clipboard dependencies containing a trend card", () => {
  const p = placed(),
    source = p.screens[0].id;
  const next = applyCommand(
    p,
    { type: "create-screen", name: "view", width: 960, height: 540 },
    "edit",
  );
  const screenId = next.screens[1].id;
  const embedded = applyCommand(
    next,
    { type: "add-screen-view", screenId, sourceScreenId: source, frame },
    "edit",
  );
  expect(() =>
    copyObjects(
      embedded,
      screenId,
      [embedded.screens[1].objects[0].id],
      "local",
    ),
  ).toThrow(/トレンド/);
});
it("switches an existing placement reference without changing its geometry", () => {
  const p = placed(),
    second = { ...def(), id: newId(), name: "別の定義" };
  const both = applyCommand(
    p,
    { type: "save-trend", create: true, definition: second },
    "edit",
  );
  const object = both.screens[0].objects.at(-1)!;
  const switched = applyCommand(
    both,
    {
      type: "update",
      screenId: both.screens[0].id,
      objectId: object.id,
      patch: { trendId: second.id },
    },
    "edit",
  );
  expect(switched.screens[0].objects.at(-1)).toEqual({
    ...object,
    shape: { type: "trend", trendId: second.id },
  });
});
