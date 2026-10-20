import { describe, expect, it } from "vitest";
import sample from "../../../../examples/embedded-screen.project.json";
import equipmentSample from "../../../../examples/equipment-symbol.project.json";
import {
  parseProject,
  serializeProject,
  getBounds,
  type Screen,
  type ScreenObject,
} from "./project";
import { createProject } from "./new-project";
import { applyCommand, newId } from "./editor";
import { copyObjects, parseClipboard } from "./clipboard";
import { emptyHistory, recordEdit, travelHistory } from "./history";
const fresh = () => parseProject(JSON.stringify(sample));
const copy = (project = fresh()) =>
  copyObjects(
    project,
    project.screens[0].id,
    project.screens[0].objects.slice(1).map((o) => o.id),
    "origin",
  );
describe("embedded screen clipboard v4", () => {
  it("takes one dependency per shared source, keeps hidden placements, and reuses current live screens", () => {
    const p = fresh();
    p.screens[0].objects[2].visible = false;
    const text = copy(p),
      snapshot = parseClipboard(text);
    expect(snapshot.version).toBe(4);
    expect(snapshot.project.screens).toHaveLength(2);
    expect(snapshot.project.screens[1]).toEqual(p.screens[1]);
    expect(snapshot.project.screens[0].objects).toHaveLength(2);
    const updated = structuredClone(p);
    updated.screens[1].name = "現行を再利用";
    const result = recordEdit(
      updated,
      emptyHistory(),
      {
        type: "paste",
        screenId: p.screens[0].id,
        text,
        origin: "origin",
        center: { x: 500, y: 300 },
      },
      "edit",
    );
    expect(result.project.screens).toHaveLength(2);
    expect(result.project.symbols).toHaveLength(p.symbols.length);
    expect(result.project.screens[1].name).toBe("現行を再利用");
    expect(
      result.project.screens[0].objects.slice(-2).map((o) => o.shape),
    ).toEqual(p.screens[0].objects.slice(1).map((o) => o.shape));
    expect(result.project.screens[0].objects.at(-1)!.visible).toBe(false);
    expect(result.history.past).toHaveLength(1);
    expect(
      travelHistory(result.project, result.history, "undo", "edit").project,
    ).toMatchObject({ screens: updated.screens, symbols: updated.symbols });
  });
  it("imports foreign screen, folder, group, object and Symbol identities without shifting source coordinates", () => {
    const p = fresh(),
      source = p.screens[1];
    source.folders.push({
      id: newId(),
      name: "ポンプ",
      order: 0,
    });
    for (const object of source.objects.slice(1, 3))
      object.folderId = source.folders[0].id;
    source.groups.push({
      id: newId(),
      name: "工程",
      memberIds: source.objects.slice(1, 3).map((o) => o.id),
    });
    const destination = createProject();
    const result = applyCommand(
      destination,
      {
        type: "paste",
        screenId: destination.screens[0].id,
        text: copy(p),
        origin: "foreign",
        center: { x: 300, y: 300 },
      },
      "edit",
    );
    expect(result.screens).toHaveLength(2);
    const imported = result.screens[1];
    expect(imported.id).not.toBe(source.id);
    expect(imported.objects.map((o) => [o.x, o.y, getBounds(o)])).toEqual(
      source.objects.map((o) => [o.x, o.y, getBounds(o)]),
    );
    expect(imported.folders[0]).toMatchObject({ name: "ポンプ" });
    expect(imported.folders[0].id).not.toBe(source.folders[0].id);
    expect(imported.groups[0].memberIds).toEqual(
      imported.objects.slice(1, 3).map((o) => o.id),
    );
    expect(imported.groups[0].id).not.toBe(source.groups[0].id);
    expect(imported.objects[1].folderId).toBe(imported.folders[0].id);
    for (const object of imported.objects) {
      expect(source.objects.some((o) => o.id === object.id)).toBe(false);
      const shape = object.shape;
      if (shape.type === "symbol")
        expect(result.symbols.some((s) => s.id === shape.symbolId)).toBe(true);
    }
    expect(result.screens[0].objects.map((o) => o.shape)).toEqual(
      Array(2).fill({
        type: "screenView",
        screenId: imported.id,
        fit: "contain",
      }),
    );
    expect(parseProject(serializeProject(result))).toEqual(result);
    expect(p).toEqual(parseProject(serializeProject(p)));
  });
  it("restores a deleted source from the clipboard snapshot even in the same workspace", () => {
    let p = fresh();
    const text = copy(p),
      host = p.screens[0],
      source = p.screens[1];
    p = applyCommand(
      p,
      {
        type: "remove-many",
        screenId: host.id,
        objectIds: host.objects.slice(1).map((o) => o.id),
      },
      "edit",
    );
    p = applyCommand(p, { type: "remove-screen", screenId: source.id }, "edit");
    const result = applyCommand(
      p,
      {
        type: "paste",
        screenId: host.id,
        text,
        origin: "origin",
        center: { x: 300, y: 300 },
      },
      "edit",
    );
    expect(result.screens).toHaveLength(2);
    expect(result.screens[1].id).not.toBe(source.id);
    expect(result.screens[1].name).toBe(source.name);
    expect(result.symbols).toHaveLength(p.symbols.length);
  });
  it("allows empty referenced screens", () => {
    const p = fresh();
    p.screens[1].objects = [];
    p.symbols = [];
    const fragment = parseClipboard(copy(p));
    expect(fragment.project.screens[1].objects).toEqual([]);
  });
  it("rejects self references, nesting, and Symbol targets atomically", () => {
    const p = fresh(),
      text = copy(p),
      before = serializeProject(p);
    for (const command of [
      { screenId: p.screens[1].id },
      { screenId: p.screens[0].id, definitionId: p.symbols[0].id },
    ])
      expect(() =>
        recordEdit(
          p,
          emptyHistory(),
          {
            type: "paste",
            ...command,
            text,
            origin: "origin",
            center: { x: 50, y: 50 },
          },
          "edit",
        ),
      ).toThrow();
    const nested = structuredClone(p);
    nested.screens.push({
      ...structuredClone(p.screens[1]),
      id: newId(),
      name: "空",
      objects: [],
    });
    // Both host placements now target the empty screen; the former source can acquire a View.
    for (const object of nested.screens[0].objects)
      if (object.shape.type === "screenView")
        object.shape.screenId = nested.screens[2].id;
    nested.screens[1].objects.push({
      ...structuredClone(p.screens[0].objects[1]),
      id: newId(),
      order: 99,
      shape: {
        type: "screenView",
        screenId: nested.screens[2].id,
        fit: "contain",
      },
    } as ScreenObject);
    expect(() =>
      applyCommand(
        nested,
        {
          type: "paste",
          screenId: nested.screens[0].id,
          text,
          origin: "origin",
          center: { x: 50, y: 50 },
        },
        "edit",
      ),
    ).toThrow("入れ子");
    expect(serializeProject(p)).toBe(before);
  });
  it("rejects unreachable screens, extra Symbols/assets, missing sources and incorrect envelopes", () => {
    const fragment = JSON.parse(copy());
    const mutations = [
      (x: any) =>
        x.project.screens.push({
          ...structuredClone(x.project.screens[1]),
          id: newId(),
          objects: [],
        }),
      (x: any) =>
        x.project.symbols.push({
          ...structuredClone(x.project.symbols[0]),
          id: newId(),
          objects: structuredClone(x.project.symbols[0].objects).map(
            (o: any) => ({ ...o, id: newId() }),
          ),
        }),
      (x: any) => x.project.screens.pop(),
      (x: any) => delete x.images,
      (x: any) => x.project.screens[0].objects.splice(0),
      (x: any) => (x.version = 3),
    ];
    for (const mutate of mutations) {
      const x = structuredClone(fragment);
      mutate(x);
      expect(() => parseClipboard(JSON.stringify(x))).toThrow();
    }
  });
  it("preserves the existing refusal for equipment-linked contents in the referenced screen", () => {
    const p = parseProject(JSON.stringify(equipmentSample));
    const source = p.screens[0],
      host: Screen = {
        ...structuredClone(source),
        id: newId(),
        name: "host",
        objects: [],
        groups: [],
        folders: [],
      };
    p.screens.unshift(host);
    host.objects = [
      {
        id: newId(),
        order: 0,
        x: 0,
        y: 0,
        width: 300,
        height: 200,
        rotation: 0,
        shape: { type: "screenView", screenId: source.id, fit: "contain" },
      },
    ] as typeof source.objects;
    expect(() =>
      copyObjects(
        p,
        host.id,
        host.objects.map((o) => o.id),
        "origin",
      ),
    ).toThrow("機器の関連付け");
  });
});
