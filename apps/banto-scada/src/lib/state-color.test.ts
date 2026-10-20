import { expect, it } from "vitest";
import sample from "../../../../examples/state-color.project.json";
import cases from "../../../../examples/state-color-cases.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { copyObjects, parseClipboard } from "./clipboard";
import { copySymbol } from "./editor/model-helpers";
import { resolveStateColor, stateColorUsages } from "./state-color";
import { stateColorCommand } from "./designer/forms/state-color";
const fresh = () => parseProject(JSON.stringify(sample));
it.each(cases)(
  "state color contract: $name",
  ({ target, key, valid, ...change }) => {
    const value = structuredClone(sample),
      node = target
        .split("/")
        .slice(1)
        .reduce((node, key) => node[key], value as any);
    if ("remove" in change) delete node[key];
    else node[key] = change.value;
    if (valid)
      expect(
        parseProject(serializeProject(parseProject(JSON.stringify(value)))),
      ).toEqual(value);
    else expect(() => parseProject(JSON.stringify(value))).toThrow();
  },
);
it("protects source and authored paint atomically and supports detach with Undo", () => {
  const project = fresh(),
    d = project.symbols[0],
    source = d.objects[5],
    follower = d.objects[7],
    before = serializeProject(project);
  expect(stateColorUsages(d, source.id)).toHaveLength(7);
  const update = (objectId: string, patch: any) => ({
    type: "update" as const,
    screenId: d.id,
    definitionId: d.id,
    objectId,
    patch,
  });
  for (const patch of [
    { boolColors: null },
    { slotBinding: { slotName: "current" }, boolColors: null },
    { slotBinding: null, boolColors: null },
  ])
    expect(() =>
      applyCommand(project, update(source.id, patch), "edit"),
    ).toThrow(/配色元/);
  expect(() =>
    applyCommand(
      project,
      {
        type: "remove",
        screenId: d.id,
        definitionId: d.id,
        objectId: source.id,
      },
      "edit",
    ),
  ).toThrow(/配色元/);
  if (follower.shape.type !== "rectangle")
    throw new Error("expected rectangle");
  const paint = follower.shape.paint;
  expect(() =>
    applyCommand(
      project,
      update(follower.id, {
        paint: {
          ...paint,
          fill: { ...paint.fill, enabled: false },
        },
      }),
      "edit",
    ),
  ).toThrow();
  expect(serializeProject(project)).toBe(before);
  const detached = recordEdit(
    project,
    emptyHistory(),
    update(follower.id, { stateColor: null }),
    "edit",
  );
  expect(detached.project.symbols[0].objects[7].shape).not.toHaveProperty(
    "stateColor",
  );
  expect(
    travelHistory(detached.project, detached.history, "undo", "edit").project
      .symbols,
  ).toEqual(project.symbols);
  const removed = applyCommand(
    project,
    {
      type: "remove-many",
      screenId: d.id,
      definitionId: d.id,
      objectIds: [
        source.id,
        ...stateColorUsages(d, source.id).map((o) => o.id),
      ],
    },
    "edit",
  );
  expect(removed.symbols[0].objects).toHaveLength(1);
});
it("remaps definition and multi-selection copies while follower-only duplication shares the original", () => {
  const project = fresh(),
    d = project.symbols[0],
    source = d.objects[5],
    follower = d.objects[0];
  const copy = copySymbol(d),
    copiedSource = copy.objects[5];
  expect(copiedSource.id).not.toBe(source.id);
  expect(stateColorUsages(copy, copiedSource.id)).toHaveLength(7);
  const duplicated = applyCommand(
    project,
    {
      type: "duplicate-many",
      screenId: d.id,
      definitionId: d.id,
      objectIds: [source.id, follower.id],
    },
    "edit",
  );
  const added = duplicated.symbols[0].objects.slice(d.objects.length),
    newSource = added.find((o) => o.shape.type === "text")!;
  expect(added.find((o) => o.shape.type === "polyline")!.shape).toMatchObject({
    stateColor: { textId: newSource.id },
  });
  const single = applyCommand(
    project,
    {
      type: "duplicate",
      screenId: d.id,
      definitionId: d.id,
      objectId: follower.id,
    },
    "edit",
  );
  expect(single.symbols[0].objects.at(-1)!.shape).toMatchObject({
    stateColor: { textId: source.id },
  });
  expect(() => copyObjects(project, d.id, [follower.id], "test")).toThrow(
    /状態色/,
  );
  const screen = project.screens[0],
    unbound = screen.objects[4];
  const fragment = parseClipboard(
    copyObjects(project, screen.id, [unbound.id], "test"),
  );
  expect(stateColorUsages(fragment.project.symbols[0], source.id)).toHaveLength(
    7,
  );
});
it("resolves each equipment independently and ignores source transparency", () => {
  const project = fresh(),
    d = project.symbols[0],
    source = d.objects[5];
  source.visible = false;
  source.opacity = 0;
  source.colorAlpha = 0;
  expect(resolveStateColor(d.objects[0], d)).toBe("#d97706");
  const context = {
    ...project,
    readSlot: (id: string) => ({
      state: "good" as const,
      label: "Good",
      text: "misleading",
      value: { type: "bool" as const, value: id === project.equipment![1].id },
      provenance: {
        catalogRevision: 1,
        runId: 1,
        collectionMode: "configured" as const,
        valueSource: "real" as const,
        sourceTimestampMs: 1,
      },
    }),
  };
  for (const equipment of project.equipment!)
    equipment.bindings = [{ slotName: "running", externalName: "Demo.Value" }];
  expect(
    resolveStateColor(d.objects[0], d, project.equipment![0].id, context),
  ).toBe("#64748b");
  expect(
    resolveStateColor(d.objects[0], d, project.equipment![1].id, context),
  ).toBe("#16a34a");
});
it("guards the form target, sources and unsupported paint", () => {
  const project = fresh(),
    owner = project.symbols[0],
    selected = owner.objects[0],
    data = new FormData();
  data.set("stateColorTextId", owner.objects[5].id);
  const input = {
    data,
    targetKey: `3:${owner.id}:true`,
    objectId: selected.id,
  };
  const context = {
    generation: 3,
    screenId: owner.id,
    definition: true,
    selected,
    owner,
  };
  expect(stateColorCommand(input, context)).toMatchObject({
    patch: { stateColor: { textId: owner.objects[5].id } },
  });
  for (const change of [
    { generation: 4 },
    { definition: false },
    { selected: owner.objects[5] },
  ])
    expect(() => stateColorCommand(input, { ...context, ...change })).toThrow();
  data.set("stateColorTextId", owner.objects[6].id);
  expect(() => stateColorCommand(input, context)).toThrow();
  data.set("stateColorTextId", "");
  expect(stateColorCommand(input, context)).toMatchObject({
    patch: { stateColor: null },
  });
});
