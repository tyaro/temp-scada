import { expect, it } from "vitest";
import sample from "../../../../examples/process.project.json";
import bound from "../../../../examples/tag-binding.project.json";
import equipment from "../../../../examples/equipment-property.project.json";
import { applyCommand, type EditCommand } from "./editor";
import { parseProject, serializeProject, type TextStyle } from "./project";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { selectionTextStyleCommand } from "./designer/forms/selection-text-style";
const fresh = () => parseProject(JSON.stringify(sample));
const command = (p = fresh()) => ({
  type: "set-text-style" as const,
  screenId: p.screens[0].id,
  objectIds: p.screens[0].objects
    .filter((o) => o.shape.type === "text")
    .map((o) => o.id),
  patch: { fontWeight: "bold" as const },
});
it("changes only specified Text fields across screens and definitions, preserving bodies, bindings, metadata and geometry", () => {
  for (const fixture of [sample, bound, equipment]) {
    const p = parseProject(JSON.stringify(fixture)),
      before = structuredClone(p);
    for (const owner of [...p.screens, ...p.symbols]) {
      const ids = owner.objects
        .filter((o) => o.shape.type === "text")
        .map((o) => o.id);
      if (!ids.length) continue;
      const next = applyCommand(
        p,
        {
          type: "set-text-style",
          screenId: owner.id,
          ...(p.symbols.includes(owner as any)
            ? { definitionId: owner.id }
            : {}),
          objectIds: ids,
          patch: { fontSize: 18, align: "right" },
        },
        "edit",
      );
      const target = [...next.screens, ...next.symbols].find(
        (o) => o.id === owner.id,
      )!;
      expect(target.objects).toEqual(
        owner.objects.map((o) =>
          o.shape.type === "text"
            ? {
                ...o,
                shape: {
                  ...o.shape,
                  style: { ...o.shape.style, fontSize: 18, align: "right" },
                },
              }
            : o,
        ),
      );
      expect(parseProject(serializeProject(next))).toEqual(next);
      for (const other of [...next.screens, ...next.symbols].filter(
        (o) => o.id !== owner.id,
      ))
        expect(other).toEqual(
          [...p.screens, ...p.symbols].find((o) => o.id === other.id),
        );
    }
    expect(p).toEqual(before);
  }
});
it("records one Undo, treats equivalent patches as no-op and restores prior mixed styles on Undo/Redo", () => {
  const p = fresh(),
    base = command(p),
    h = emptyHistory();
  const edited = recordEdit(p, h, base, "edit");
  expect(edited.history.past).toHaveLength(1);
  const same = recordEdit(edited.project, edited.history, base, "edit");
  expect(same.project).toBe(edited.project);
  expect(same.history).toBe(edited.history);
  const undo = travelHistory(edited.project, edited.history, "undo", "edit");
  expect(undo.project.screens[0].objects).toEqual(p.screens[0].objects);
  const redo = travelHistory(undo.project, undo.history, "redo", "edit");
  expect(redo.project.screens).toEqual(edited.project.screens);
});
it("rejects empty or malformed patches, invalid values and incompatible targets atomically", () => {
  const p = fresh(),
    base = command(p),
    before = serializeProject(p);
  const patches: unknown[] = [
    null,
    undefined,
    [],
    {},
    { unexpected: 1 },
    { fontSize: 0 },
    { fontSize: -1 },
    { fontSize: 513 },
    { fontSize: Infinity },
    { fontSize: NaN },
    { fontSize: "24" },
    { fontWeight: "heavy" },
    { align: "justify" },
    { fontSize: 18, align: "invalid" },
  ];
  for (const patch of patches)
    expect(() =>
      applyCommand(p, { ...base, patch } as EditCommand, "edit"),
    ).toThrow();
  for (const objectIds of [
    [],
    [base.objectIds[0], base.objectIds[0]],
    [base.objectIds[0], "missing"],
    p.screens[0].objects.map((o) => o.id),
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
  expect(serializeProject(p)).toBe(before);
});
it("allows hidden Text without making it visible and refuses cross-owner IDs", () => {
  const p = fresh(),
    base = command(p);
  p.screens[0].objects.find((o) => o.id === base.objectIds[0])!.visible = false;
  const next = applyCommand(
    p,
    {
      ...base,
      patch: { fontSize: 0.5, fontWeight: "normal", align: "center" },
    },
    "edit",
  );
  expect(
    next.screens[0].objects.find((o) => o.id === base.objectIds[0]),
  ).toMatchObject({
    visible: false,
    shape: { style: { fontSize: 0.5, fontWeight: "normal", align: "center" } },
  });
  expect(() =>
    applyCommand(p, { ...base, definitionId: p.symbols[0].id }, "edit"),
  ).toThrow();
});
it("keeps unspecified form fields absent, parses finite sizes, and protects captured selection scope", () => {
  const data = new FormData(),
    context = {
      generation: 3,
      screenId: "owner",
      definition: false,
      selectedIds: ["a", "b"],
    },
    input = { data, targetKey: "3:owner:false", objectIds: '["a","b"]' };
  data.set("fontSize", "24.5");
  expect(selectionTextStyleCommand(input, context)).toEqual({
    type: "set-text-style",
    screenId: "owner",
    objectIds: ["a", "b"],
    patch: { fontSize: 24.5 },
  });
  data.set("fontSize", "");
  data.set("fontWeight", "bold");
  data.set("textAlign", "right");
  expect(selectionTextStyleCommand(input, context)).toMatchObject({
    patch: { fontWeight: "bold", align: "right" },
  });
  expect(
    (selectionTextStyleCommand(input, context) as { patch: Partial<TextStyle> })
      .patch,
  ).not.toHaveProperty("fontSize");
  for (const [key, value] of [
    ["fontSize", "1e"],
    ["fontWeight", "heavy"],
    ["textAlign", "justify"],
  ]) {
    const old = data.get(key)!;
    data.set(key, value);
    expect(() => selectionTextStyleCommand(input, context)).toThrow();
    data.set(key, old);
  }
  expect(() =>
    selectionTextStyleCommand(
      { ...input, targetKey: "2:owner:false" },
      context,
    ),
  ).toThrow("適用先");
  expect(() =>
    selectionTextStyleCommand(input, {
      ...context,
      selectedIds: ["other", "b"],
    }),
  ).toThrow("適用対象");
});
