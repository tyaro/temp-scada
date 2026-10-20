import { expect, it } from "vitest";
import sample from "../../../../examples/process.project.json";
import definitionSample from "../../../../examples/symbol-color.project.json";
import embedded from "../../../../examples/embedded-screen.project.json";
import { applyCommand, newId, type EditCommand } from "./editor";
import { parseProject, serializeProject, type LayoutObject } from "./project";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { setSelectionSize } from "./editor/size-arrangement";
import { selectionSizeCommand } from "./designer/forms/selection-size";
const fresh = () => parseProject(JSON.stringify(sample));
const command = (p = fresh()) => ({
  type: "set-size" as const,
  screenId: p.screens[0].id,
  objectIds: p.screens[0].objects.filter((o) => "width" in o).map((o) => o.id),
  width: 160,
});
it("unifies local widths while preserving each rotated center, height, paint and shared reference", () => {
  const p = fresh(),
    base = command(p);
  p.screens[0].objects[0].rotation = 37;
  p.screens[0].objects[1].rotation = 270;
  p.screens[0].objects[0].visible = false;
  const before = structuredClone(p),
    next = applyCommand(p, base, "edit");
  for (const [i, old] of p.screens[0].objects.entries()) {
    const changed = next.screens[0].objects[i];
    if (!("width" in old)) {
      expect(changed).toEqual(old);
      continue;
    }
    if (!("width" in changed)) throw Error("fixture");
    expect(changed).toEqual({
      ...old,
      width: 160,
      x: old.x + (old.width - 160) / 2,
    });
    expect(changed.x + changed.width / 2).toBeCloseTo(
      old.x + old.width / 2,
      10,
    );
    expect(changed.y + changed.height / 2).toBeCloseTo(
      old.y + old.height / 2,
      10,
    );
  }
  expect(p).toEqual(before);
  expect(next.symbols).toEqual(p.symbols);
  expect(parseProject(serializeProject(next))).toEqual(next);
});
it("supports height-only and both dimensions, one Undo/Redo and exact same-value no-op", () => {
  const p = fresh(),
    base = command(p);
  const heightOnly = applyCommand(
    p,
    { ...base, width: undefined, height: 80 },
    "edit",
  );
  for (const o of heightOnly.screens[0].objects) {
    const old = p.screens[0].objects.find((x) => x.id === o.id)!;
    if ("width" in o && "width" in old) {
      expect(o.width).toBe(old.width);
      expect(o.x).toBe(old.x);
      expect(o.height).toBe(80);
    }
  }
  const state = recordEdit(p, emptyHistory(), { ...base, height: 90 }, "edit");
  expect(state.history.past).toHaveLength(1);
  const same = recordEdit(
    state.project,
    state.history,
    { ...base, height: 90 },
    "edit",
  );
  expect(same.project).toBe(state.project);
  expect(same.history).toBe(state.history);
  const undo = travelHistory(state.project, state.history, "undo", "edit");
  expect(undo.project.screens[0].objects).toEqual(p.screens[0].objects);
  const redo = travelHistory(undo.project, undo.history, "redo", "edit");
  expect(redo.project.screens[0].objects).toEqual(
    state.project.screens[0].objects,
  );
});
it("rejects empty, malformed, nonpositive, missing, duplicate, line, group, lock and preview edits atomically", () => {
  const p = fresh(),
    base = command(p),
    before = serializeProject(p);
  for (const width of [0, -1, NaN, Infinity, "100", null])
    expect(() =>
      applyCommand(p, { ...base, width } as EditCommand, "edit"),
    ).toThrow();
  expect(() =>
    applyCommand(p, { ...base, width: undefined }, "edit"),
  ).toThrow();
  for (const ids of [
    [],
    [base.objectIds[0], base.objectIds[0]],
    [base.objectIds[0], "missing"],
    p.screens[0].objects.map((o) => o.id),
  ])
    expect(() =>
      applyCommand(p, { ...base, objectIds: ids }, "edit"),
    ).toThrow();
  const grouped = applyCommand(
    p,
    {
      type: "group",
      screenId: base.screenId,
      objectIds: base.objectIds.slice(0, 2),
    },
    "edit",
  );
  expect(() => applyCommand(grouped, base, "edit")).toThrow("グループ");
  const locked = applyCommand(
    p,
    {
      type: "set-lock",
      screenId: base.screenId,
      objectId: base.objectIds[0],
      locked: true,
    },
    "edit",
  );
  expect(() => applyCommand(locked, base, "edit")).toThrow("ロック");
  expect(() => applyCommand(p, base, "preview")).toThrow("プレビュー");
  expect(serializeProject(p)).toBe(before);
});
it("prepares all candidates before edits and rejects finite sizes that cannot preserve the world center", () => {
  const p = fresh(),
    objects = p.screens[0].objects
      .filter((o): o is LayoutObject => "width" in o)
      .slice(0, 2);
  objects[1].x = Number.MAX_VALUE;
  objects[1].width = Number.MAX_VALUE;
  const before = structuredClone(objects);
  expect(() =>
    setSelectionSize(objects, { ...command(p), height: 80 }),
  ).toThrow();
  expect(objects).toEqual(before);
  const rect = fresh().screens[0].objects[0];
  if (!("width" in rect)) throw Error("fixture");
  const original = structuredClone(rect);
  expect(() =>
    setSelectionSize([rect], { ...command(p), width: Number.MAX_VALUE }),
  ).toThrow("中心");
  expect(rect).toEqual(original);
});
it("keeps image fit/crop/assets, Symbol internals and embedded sources while changing only the selected frames", () => {
  let p = parseProject(JSON.stringify(embedded)),
    screenId = p.screens[0].id;
  p = applyCommand(
    p,
    {
      type: "add-image",
      screenId,
      asset: {
        id: newId(),
        sha256: "0".repeat(64),
        mime: "image/png",
        byteLength: 100,
        width: 400,
        height: 200,
        name: "設備.png",
      },
      frame: { x: 20, y: 30, width: 80, height: 60 },
    },
    "edit",
  );
  const image = p.screens[0].objects.at(-1)!;
  p = applyCommand(
    p,
    {
      type: "set-image-crop",
      screenId,
      objectId: image.id,
      crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    },
    "edit",
  );
  const next = applyCommand(p, { ...command(p), height: 90 }, "edit");
  expect(next.assets).toEqual(p.assets);
  expect(next.screens[1]).toEqual(p.screens[1]);
  expect(next.symbols).toEqual(p.symbols);
  for (const [i, o] of next.screens[0].objects.entries())
    expect(o.shape).toEqual(p.screens[0].objects[i].shape);
});
it("changes owned definition placements without modifying placed Symbols or foreign definitions", () => {
  const p = parseProject(JSON.stringify(definitionSample)),
    owner = p.symbols[0],
    ids = owner.objects
      .filter((o) => "width" in o)
      .slice(0, 2)
      .map((o) => o.id),
    base = {
      type: "set-size" as const,
      screenId: p.screens[0].id,
      definitionId: owner.id,
      objectIds: ids,
      width: 20,
    };
  const next = applyCommand(p, base, "edit");
  expect(next.screens).toEqual(p.screens);
  for (const id of ids)
    expect(next.symbols[0].objects.find((o) => o.id === id)).toMatchObject({
      width: 20,
    });
  expect(() =>
    applyCommand(
      p,
      { ...base, objectIds: [p.screens[0].objects[0].id] },
      "edit",
    ),
  ).toThrow();
});
it("parses optional dimensions without blank coercion and binds to current owner and exact selected targets", () => {
  const data = new FormData(),
    context = {
      generation: 3,
      screenId: "owner",
      definition: false,
      selectedIds: ["a", "b"],
    },
    input = { data, targetKey: "3:owner:false", objectIds: '["a","b"]' };
  data.set("width", "160.5");
  expect(selectionSizeCommand(input, context)).toEqual({
    type: "set-size",
    screenId: "owner",
    objectIds: ["a", "b"],
    width: 160.5,
  });
  data.set("width", " ");
  data.set("height", "8e1");
  expect(selectionSizeCommand(input, context)).toMatchObject({ height: 80 });
  expect(selectionSizeCommand(input, context)).not.toHaveProperty("width");
  data.set("height", "1e");
  expect(() => selectionSizeCommand(input, context)).toThrow();
  data.set("height", "80");
  expect(() =>
    selectionSizeCommand({ ...input, targetKey: "2:owner:false" }, context),
  ).toThrow("適用先");
  expect(() =>
    selectionSizeCommand(input, { ...context, selectedIds: ["a", "other"] }),
  ).toThrow("適用対象");
});
