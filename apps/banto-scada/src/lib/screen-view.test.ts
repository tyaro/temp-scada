import { expect, it } from "vitest";
import sample from "../../../../examples/embedded-screen.project.json";
import cases from "../../../../examples/screen-view-cases.json";
import { parseProject, serializeProject } from "./project";
import {
  projectScreenReferences,
  screenViewOptions,
} from "./screen-references";
import { applyCommand } from "./editor";
import { copyObjects } from "./clipboard";
import { recordEdit, travelHistory, emptyHistory } from "./history";
const fresh = () => parseProject(JSON.stringify(sample));
for (const c of cases)
  it(`shared screen View: ${c.name}`, () => {
    const p: any = structuredClone(sample),
      parts = c.path.slice(1).split("/");
    let target = p;
    for (const key of parts.slice(0, -1)) target = target[key];
    target[parts.at(-1)!] = c.value;
    if (c.valid) expect(parseProject(JSON.stringify(p))).toEqual(p);
    else expect(() => parseProject(JSON.stringify(p))).toThrow();
  });
it("shares source identity across duplicate placements and screens, and roundtrips", () => {
  const p = fresh(),
    host = p.screens[0],
    view = host.objects[1];
  const next = applyCommand(
    p,
    { type: "duplicate", screenId: host.id, objectId: view.id },
    "edit",
  );
  expect(next.screens[0].objects.at(-1)?.shape).toEqual(view.shape);
  const copied = applyCommand(
    next,
    { type: "duplicate-screen", screenId: host.id },
    "edit",
  );
  expect(
    copied.screens
      .at(-1)!
      .objects.filter((o) => o.shape.type === "screenView")
      .map((o) => o.shape),
  ).toEqual(
    next.screens[0].objects
      .filter((o) => o.shape.type === "screenView")
      .map((o) => o.shape),
  );
  expect(parseProject(serializeProject(copied))).toEqual(copied);
});
it("protects used screen deletion with names, including hidden references", () => {
  const p = fresh();
  p.screens[0].objects[1].visible = false;
  const before = structuredClone(p);
  expect(() =>
    applyCommand(
      p,
      { type: "remove-screen", screenId: p.screens[1].id },
      "edit",
    ),
  ).toThrow("設備監視・埋込先／循環設備の埋込表示");
  expect(p).toEqual(before);
});
it("copies view snapshots and still rejects mixed color edits atomically", () => {
  const p = fresh(),
    screen = p.screens[0];
  expect(
    copyObjects(
      p,
      screen.id,
      screen.objects.map((o) => o.id),
      "session",
    ),
  ).toContain('"version":4');
  expect(() =>
    applyCommand(
      p,
      {
        type: "set-color",
        screenId: screen.id,
        objectIds: screen.objects.map((o) => o.id),
        fill: "#ff0000",
      },
      "edit",
    ),
  ).toThrow("埋込画面");
  expect(p).toEqual(fresh());
});
it("insertion and reference change are globally validated and undoable", () => {
  let p = fresh();
  p = applyCommand(
    p,
    { type: "create-screen", name: "空の画面", width: 200, height: 100 },
    "edit",
  );
  const host = p.screens[0],
    source = p.screens[1],
    empty = p.screens[2];
  const inserted = recordEdit(
    p,
    emptyHistory(),
    {
      type: "add-screen-view",
      screenId: empty.id,
      sourceScreenId: source.id,
      frame: { x: 10, y: 20, width: 80, height: 50 },
    },
    "edit",
  );
  expect(
    projectScreenReferences(inserted.project).byTarget.get(source.id),
  ).toHaveLength(3);
  const undone = travelHistory(
    inserted.project,
    inserted.history,
    "undo",
    "edit",
  );
  expect(undone.project.screens).toEqual(p.screens);
  const redone = travelHistory(undone.project, undone.history, "redo", "edit");
  expect(redone.project.screens).toEqual(inserted.project.screens);
  expect(() =>
    applyCommand(
      redone.project,
      {
        type: "add-screen-view",
        screenId: source.id,
        sourceScreenId: empty.id,
        frame: { x: 0, y: 0, width: 100, height: 100 },
      },
      "edit",
    ),
  ).toThrow("入れ子");
  const changed = applyCommand(
    p,
    {
      type: "update",
      screenId: host.id,
      objectId: host.objects[1].id,
      patch: { sourceScreenId: empty.id, opacity: 0.5, rotation: 35 },
    },
    "edit",
  );
  expect(changed.screens[0].objects[1]).toMatchObject({
    opacity: 0.5,
    rotation: 35,
    shape: { screenId: empty.id },
  });
  expect(() =>
    applyCommand(
      p,
      {
        type: "update",
        screenId: host.id,
        objectId: host.objects[1].id,
        patch: { fill: "#000000" },
      },
      "edit",
    ),
  ).toThrow();
  expect(() =>
    applyCommand(
      p,
      {
        type: "update",
        screenId: host.id,
        objectId: host.objects[0].id,
        patch: { sourceScreenId: empty.id },
      },
      "edit",
    ),
  ).toThrow();
  expect(() =>
    applyCommand(
      p,
      {
        type: "add-screen-view",
        screenId: host.id,
        sourceScreenId: source.id,
        frame: { x: 0, y: 0, width: 100, height: 100 },
      },
      "preview",
    ),
  ).toThrow();
  expect(screenViewOptions(p, source.id).every((o) => o.reason)).toBe(true);
});
it("counts hidden symbol children in amplified cost without limiting plain screens", () => {
  const p = fresh(),
    source = p.screens[1],
    symbol = p.symbols[0];
  symbol.objects = Array.from({ length: 100 }, (_, i) => ({
    ...structuredClone(symbol.objects[0]),
    id: `0199ff01-0000-7000-8000-${i.toString().padStart(12, "0")}`,
    order: i,
    visible: false,
  }));
  symbol.folders = [];
  for (const child of symbol.objects) delete child.folderId;
  const instance = source.objects.find((o) => o.shape.type === "symbol")!;
  source.folders = [];
  source.objects = Array.from({ length: 200 }, (_, i) => ({
    ...structuredClone(instance),
    width: 5,
    height: 5,
    id: `0199ff02-0000-7000-8000-${i.toString().padStart(12, "0")}`,
    order: i,
    folderId: undefined,
    visible: false,
  }));
  expect(() => parseProject(JSON.stringify(p))).toThrow("20,000");
  p.screens[0].objects = p.screens[0].objects.slice(0, 1);
  expect(() => parseProject(JSON.stringify(p))).not.toThrow();
});

import budgets from "../../../../examples/screen-view-budget-cases.json";
for (const c of budgets)
  it(`shared View budget: ${c.name}`, () => {
    const p = fresh(),
      host = p.screens[0],
      source = p.screens[1],
      symbol = p.symbols[0];
    const instance = source.objects.find((o) => o.shape.type === "symbol")!;
    symbol.folders = [];
    symbol.objects = Array.from({ length: c.children }, (_, i) => ({
      id: `0199ff03-0000-7000-8000-${i.toString().padStart(12, "0")}`,
      order: i,
      x: 0,
      y: 0,
      width: 5,
      height: 5,
      rotation: 0,
      visible: false,
      shape: {
        type: "rectangle",
        paint: {
          fill: {
            enabled: true,
            paint: { type: "solid", color: "#000000", alpha: 1 },
          },
          stroke: null,
        },
      },
    }));
    source.folders = [];
    source.objects = Array.from({ length: c.instances }, (_, i) => ({
      ...structuredClone(instance),
      width: 5,
      height: 5,
      id: `0199ff04-0000-7000-8000-${i.toString().padStart(12, "0")}`,
      order: i,
      folderId: undefined,
      visible: false,
      shape: { type: "symbol", symbolId: symbol.id, colorMode: "definition" },
    }));
    host.objects = [
      host.objects[0],
      ...Array.from({ length: c.views }, (_, i) => ({
        ...structuredClone(host.objects[1]),
        id: `0199ff05-0000-7000-8000-${i.toString().padStart(12, "0")}`,
        order: i + 1,
        visible: false,
      })),
    ];
    if (c.valid) expect(() => parseProject(JSON.stringify(p))).not.toThrow();
    else
      expect(() => parseProject(JSON.stringify(p))).toThrow(
        c.views > 32 ? "32" : "20,000",
      );
  });
