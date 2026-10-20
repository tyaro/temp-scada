import { expect, it } from "vitest";
import sample from "../../../../examples/process.project.json";
import embedded from "../../../../examples/embedded-screen.project.json";
import { applyCommand, newId, type EditCommand } from "./editor";
import { parseProject, serializeProject } from "./project";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { selectionOpacityCommand } from "./designer/forms/selection-opacity";
const fresh = () => parseProject(JSON.stringify(sample));
const command = (p = fresh(), opacity = 0.4) => ({
  type: "set-opacity" as const,
  screenId: p.screens[0].id,
  objectIds: p.screens[0].objects.map((o) => o.id),
  opacity,
});
it("changes only placement opacity across mixed shapes and definition-colored Symbols, roundtrips and leaves original immutable", () => {
  const p = fresh();
  for (const o of p.screens[0].objects)
    if (o.shape.type === "symbol") o.shape.colorMode = "definition";
  p.screens[0].objects[0].visible = false;
  p.screens[0].objects[1].colorAlpha = 0.3;
  const before = structuredClone(p),
    next = applyCommand(p, command(p, 0.375), "edit");
  expect(next.screens[0].objects).toEqual(
    p.screens[0].objects.map((o) => ({ ...o, opacity: 0.375 })),
  );
  expect(next.symbols).toEqual(p.symbols);
  expect(p).toEqual(before);
  expect(next.manifest.projectRevision).toBe(p.manifest.projectRevision + 1);
  expect(parseProject(serializeProject(next))).toEqual(next);
});
it("supports zero and omitted 100 percent no-op with one shared Undo and Redo", () => {
  const p = fresh(),
    h = emptyHistory();
  expect(recordEdit(p, h, command(p, 1), "edit")).toEqual({
    project: p,
    history: h,
  });
  const edited = recordEdit(p, h, command(p, 0), "edit");
  expect(edited.history.past).toHaveLength(1);
  expect(edited.project.screens[0].objects.every((o) => o.opacity === 0)).toBe(
    true,
  );
  const same = recordEdit(
    edited.project,
    edited.history,
    command(edited.project, 0),
    "edit",
  );
  expect(same.project).toBe(edited.project);
  expect(same.history).toBe(edited.history);
  const undo = travelHistory(edited.project, edited.history, "undo", "edit");
  expect(undo.project.screens[0].objects).toEqual(p.screens[0].objects);
  const redo = travelHistory(undo.project, undo.history, "redo", "edit");
  expect(redo.project.screens[0].objects).toEqual(
    edited.project.screens[0].objects,
  );
});
it("rejects nonnumeric, nonfinite, out-of-range, missing, duplicate, locked, grouped and preview targets atomically", () => {
  const p = fresh(),
    base = command(p),
    before = serializeProject(p);
  for (const opacity of [
    NaN,
    Infinity,
    -Infinity,
    -0.01,
    1.01,
    "0.5",
    null,
    undefined,
  ])
    expect(() =>
      applyCommand(p, { ...base, opacity } as EditCommand, "edit"),
    ).toThrow();
  for (const objectIds of [
    [],
    [base.objectIds[0], base.objectIds[0]],
    [base.objectIds[0], "missing"],
  ])
    expect(() => applyCommand(p, { ...base, objectIds }, "edit")).toThrow();
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
  expect(() => applyCommand(p, base, "preview")).toThrow("プレビュー");
  expect(() =>
    applyCommand(p, { ...base, screenId: "missing" }, "edit"),
  ).toThrow();
  expect(serializeProject(p)).toBe(before);
});
it("preserves image assets, crop and embedded source identity when changing a mixed View selection", () => {
  let p = parseProject(JSON.stringify(embedded));
  const screenId = p.screens[0].id;
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
  const next = applyCommand(p, command(p, 0.25), "edit");
  expect(next.assets).toEqual(p.assets);
  expect(next.screens[1]).toEqual(p.screens[1]);
  expect(next.screens[0].objects).toEqual(
    p.screens[0].objects.map((o) => ({ ...o, opacity: 0.25 })),
  );
});
it("changes only owned definition placements and rejects foreign placement IDs", () => {
  const p = fresh(),
    owner = p.symbols[0],
    ids = owner.objects.slice(0, 2).map((o) => o.id);
  const base = {
    type: "set-opacity" as const,
    screenId: p.screens[0].id,
    definitionId: owner.id,
    objectIds: ids,
    opacity: 0.2,
  };
  const next = applyCommand(p, base, "edit");
  expect(next.screens).toEqual(p.screens);
  expect(next.symbols[0].objects).toEqual(
    owner.objects.map((o) => (ids.includes(o.id) ? { ...o, opacity: 0.2 } : o)),
  );
  expect(() =>
    applyCommand(
      p,
      { ...base, objectIds: [p.screens[0].objects[0].id] },
      "edit",
    ),
  ).toThrow();
});
it("binds staged percent values to the current owner and exact selection and refuses blank or malformed numbers", () => {
  const context = {
    generation: 3,
    screenId: "owner",
    definition: false,
    selectedIds: ["one", "two"],
  };
  const data = new FormData();
  data.set("opacity", "37.5");
  const input = {
    data,
    targetKey: "3:owner:false",
    objectIds: JSON.stringify(context.selectedIds),
  };
  expect(selectionOpacityCommand(input, context)).toEqual({
    type: "set-opacity",
    screenId: "owner",
    objectIds: ["one", "two"],
    opacity: 0.375,
  });
  for (const raw of ["", " ", "1e", "Infinity", "50%", "0x10"]) {
    data.set("opacity", raw);
    expect(() => selectionOpacityCommand(input, context)).toThrow();
  }
  data.set("opacity", "0");
  expect(selectionOpacityCommand(input, context)).toMatchObject({ opacity: 0 });
  expect(() =>
    selectionOpacityCommand({ ...input, targetKey: "2:owner:false" }, context),
  ).toThrow("適用先");
  expect(() =>
    selectionOpacityCommand(input, {
      ...context,
      selectedIds: ["other", "two"],
    }),
  ).toThrow("適用対象");
});
