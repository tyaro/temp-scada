import { describe, expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import { applyCommand, type EditCommand } from "./editor";
import { parseProject, serializeProject } from "./project";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import {
  layerOrderSnapshot,
  relativeFolderOrder,
  relativeObjectOrder,
} from "./relative-layer-order";
const id = (n: number) =>
  `0199fc80-0000-7000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const p = parseProject(JSON.stringify(sample)),
    s = p.screens[0];
  s.folders = [
    { id: id(1), name: "A", order: 0 },
    { id: id(2), name: "nested", order: 2, parentId: id(1) },
    { id: id(3), name: "B", order: 5 },
    { id: id(4), name: "C", order: 9 },
  ];
  s.objects.forEach((o, i) => {
    o.order = i * 5;
    o.folderId = id(1);
  });
  for (let n = 3; n < 6; n++)
    s.objects.push({
      ...structuredClone(s.objects[0]),
      id: id(100 + n),
      order: n * 5,
    });
  s.objects[3].folderId = id(3);
  return parseProject(serializeProject(p));
}
const ordered = (s: ReturnType<typeof fixture>["screens"][number]) =>
  [...s.objects].sort((a, b) => a.order - b.order).map((o) => o.id);
describe("relative sibling ordering", () => {
  it("moves only sibling folders through existing sparse slots, preserving drawing and parent membership", () => {
    const p = fixture(),
      s = p.screens[0];
    s.objects[0].locked = true;
    s.objects[1].visible = false;
    const before = serializeProject(p),
      result = recordEdit(
        p,
        emptyHistory(),
        {
          type: "reorder-folder-relative",
          screenId: s.id,
          folderId: id(1),
          targetFolderId: id(4),
          position: "after",
        },
        "edit",
      );
    expect(result.project.screens[0].folders.map((f) => f.order)).toEqual([
      9, 2, 0, 5,
    ]);
    expect(result.project.screens[0].objects).toEqual(s.objects);
    expect(result.project.screens[0].folders.map((f) => f.parentId)).toEqual(
      s.folders.map((f) => f.parentId),
    );
    expect(result.history.past).toHaveLength(1);
    expect(
      travelHistory(result.project, result.history, "undo", "edit").project
        .screens,
    ).toEqual(p.screens);
    expect(serializeProject(p)).toBe(before);
  });
  it.each(["before", "after"] as const)(
    "keeps folder self-insertion %s a no-op",
    (position) => {
      const p = fixture();
      expect(
        applyCommand(
          p,
          {
            type: "reorder-folder-relative",
            screenId: p.screens[0].id,
            folderId: id(1),
            targetFolderId: id(1),
            position,
          },
          "edit",
        ),
      ).toBe(p);
    },
  );
  it("moves a placement across sibling ranks while preserving other placements' relative order and contents", () => {
    const p = fixture(),
      s = p.screens[0],
      ids = ordered(s);
    const next = applyCommand(
      p,
      {
        type: "reorder-relative",
        screenId: s.id,
        objectIds: [ids[0]],
        targetObjectId: ids[4],
        position: "after",
      },
      "edit",
    );
    expect(ordered(next.screens[0])).toEqual([
      ids[1],
      ids[2],
      ids[3],
      ids[4],
      ids[0],
      ids[5],
    ]);
    for (const o of next.screens[0].objects) {
      const { order, ...a } = o;
      const { order: old, ...b } = s.objects.find((item) => item.id === o.id)!;
      expect(a).toEqual(b);
    }
    expect(p.screens[0]).toBe(s);
  });
  it("moves and targets whole groups without splitting either group, with one Undo/Redo", () => {
    const p = fixture(),
      s = p.screens[0],
      ids = ordered(s);
    s.objects[3].folderId = id(1);
    s.groups = [
      { id: id(20), memberIds: ids.slice(0, 2) },
      { id: id(21), memberIds: ids.slice(3, 5) },
    ];
    const result = recordEdit(
      p,
      emptyHistory(),
      {
        type: "reorder-relative",
        screenId: s.id,
        objectIds: ids.slice(0, 2),
        targetObjectId: ids[3],
        position: "after",
      },
      "edit",
    );
    expect(ordered(result.project.screens[0])).toEqual([
      ids[2],
      ids[3],
      ids[4],
      ids[0],
      ids[1],
      ids[5],
    ]);
    expect(result.project.screens[0].groups).toEqual(s.groups);
    const undo = travelHistory(result.project, result.history, "undo", "edit");
    expect(undo.project.screens).toEqual(p.screens);
    expect(
      travelHistory(undo.project, undo.history, "redo", "edit").project.screens,
    ).toEqual(result.project.screens);
  });
  it("does not renumber sparse object ranks or add Undo for self and adjacent no-ops", () => {
    const p = fixture(),
      s = p.screens[0],
      ids = ordered(s);
    for (const [target, position] of [
      [ids[0], "after"],
      [ids[1], "before"],
    ] as const) {
      const result = recordEdit(
        p,
        emptyHistory(),
        {
          type: "reorder-relative",
          screenId: s.id,
          objectIds: [ids[0]],
          targetObjectId: target,
          position,
        },
        "edit",
      );
      expect(result.project).toBe(p);
      expect(result.history.past).toHaveLength(0);
    }
  });
  it("rejects foreign parents, missing/duplicate/locked sources and multiple units before any change", () => {
    const p = fixture(),
      s = p.screens[0],
      ids = ordered(s),
      before = serializeProject(p);
    const bad: EditCommand[] = [
      {
        type: "reorder-folder-relative",
        screenId: s.id,
        folderId: id(1),
        targetFolderId: id(2),
        position: "before",
      },
      {
        type: "reorder-folder-relative",
        screenId: s.id,
        folderId: id(1),
        targetFolderId: id(99),
        position: "after",
      },
      ...[[ids[0], ids[1]], [ids[0], ids[0]], [id(99)], []].map(
        (objectIds) => ({
          type: "reorder-relative" as const,
          screenId: s.id,
          objectIds,
          targetObjectId: ids[4],
          position: "before" as const,
        }),
      ),
      {
        type: "reorder-relative",
        screenId: s.id,
        objectIds: [ids[0]],
        targetObjectId: ids[3],
        position: "before",
      },
      {
        type: "reorder-relative",
        screenId: s.id,
        objectIds: [ids[0]],
        targetObjectId: id(99),
        position: "after",
      },
      {
        type: "reorder-relative",
        screenId: s.id,
        objectIds: [ids[0]],
        targetObjectId: ids[1],
        position: "else" as never,
      },
    ];
    for (const command of bad) {
      expect(() => applyCommand(p, command, "edit")).toThrow();
      expect(serializeProject(p)).toBe(before);
    }
    s.objects[0].locked = true;
    expect(() =>
      applyCommand(
        p,
        {
          type: "reorder-relative",
          screenId: s.id,
          objectIds: [ids[0]],
          targetObjectId: ids[4],
          position: "after",
        },
        "edit",
      ),
    ).toThrow(/ロック/);
  });
  it("rejects partial groups but permits hidden sources and locked destination anchors", () => {
    const p = fixture(),
      s = p.screens[0],
      ids = ordered(s);
    s.groups = [{ id: id(20), memberIds: ids.slice(0, 2) }];
    expect(() => relativeObjectOrder(s, [ids[0]], ids[4], "after")).toThrow(
      /グループ/,
    );
    s.objects[0].visible = false;
    s.objects[4].locked = true;
    expect(relativeObjectOrder(s, ids.slice(0, 2), ids[4], "after")).toEqual([
      ids[2],
      ids[3],
      ids[4],
      ids[0],
      ids[1],
      ids[5],
    ]);
  });
  it("keeps owner-specific orders and supports Symbol definition placements", () => {
    const p = fixture(),
      s = p.screens[0];
    p.symbols = [
      {
        id: id(50),
        name: "symbol",
        width: 960,
        height: 540,
        objects: [...s.objects.slice(0, 3)].map((o, i) => ({
          ...structuredClone(o),
          id: id(60 + i),
        })),
        folders: [],
      },
    ];
    p.symbols[0].objects.forEach((o) => delete o.folderId);
    const validated = parseProject(serializeProject(p)),
      symbol = validated.symbols[0];
    const next = applyCommand(
      validated,
      {
        type: "reorder-relative",
        screenId: s.id,
        definitionId: symbol.id,
        objectIds: [symbol.objects[0].id],
        targetObjectId: symbol.objects[2].id,
        position: "after",
      },
      "edit",
    );
    expect(next.symbols[0].objects.map((o) => o.id)).toEqual([
      symbol.objects[1].id,
      symbol.objects[2].id,
      symbol.objects[0].id,
    ]);
    expect(next.screens).toEqual(validated.screens);
    expect(() =>
      applyCommand(
        validated,
        {
          type: "reorder-relative",
          screenId: s.id,
          objectIds: [symbol.objects[0].id],
          targetObjectId: symbol.objects[2].id,
          position: "after",
        },
        "edit",
      ),
    ).toThrow();
  });
  it("checks runtime positions even on self-targets and snapshots ordering rather than names or geometry", () => {
    const s = fixture().screens[0],
      before = layerOrderSnapshot(s);
    s.objects[0].name = "changed";
    s.objects[0].x += 10;
    expect(layerOrderSnapshot(s)).toBe(before);
    s.objects[0].order += 1;
    expect(layerOrderSnapshot(s)).not.toBe(before);
    expect(() =>
      relativeFolderOrder(s.folders, id(1), id(1), "else" as never),
    ).toThrow();
  });
});

it("reorders Symbol folders while preserving its placements and other owners", () => {
  const p = fixture(),
    s = p.screens[0];
  const folders = s.folders.map((f) => ({
    ...f,
    id: f.id.replace("fc80", "fc81"),
    ...(f.parentId ? { parentId: f.parentId.replace("fc80", "fc81") } : {}),
  }));
  p.symbols = [
    {
      id: id(50),
      name: "symbol",
      width: 960,
      height: 540,
      objects: s.objects.slice(0, 2).map((o, i) => ({
        ...structuredClone(o),
        id: id(60 + i),
        folderId: folders[0].id,
      })),
      folders,
    },
  ];
  const validated = parseProject(serializeProject(p)),
    symbol = validated.symbols[0];
  const next = applyCommand(
    validated,
    {
      type: "reorder-folder-relative",
      screenId: s.id,
      definitionId: symbol.id,
      folderId: folders[0].id,
      targetFolderId: folders[3].id,
      position: "after",
    },
    "edit",
  );
  expect(next.symbols[0].folders.map((f) => f.order)).toEqual([9, 2, 0, 5]);
  expect(next.symbols[0].objects).toEqual(symbol.objects);
  expect(next.screens).toEqual(validated.screens);
});
