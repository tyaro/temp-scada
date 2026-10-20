import { expect, it } from "vitest";
import { render } from "svelte/server";
import sample from "../../../../examples/symbol-slots.project.json";
import cases from "../../../../examples/symbol-slot-cases.json";
import { parseProject, serializeProject } from "./project";
import { resolveSymbolSlot } from "./symbol-slots";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { copyObjects, parseClipboard } from "./clipboard";
import ObjectPainting from "./ObjectPainting.svelte";
import ScreenPainting from "./ScreenPainting.svelte";
const fresh = () => parseProject(JSON.stringify(sample));
it.each(cases)(
  "Symbol slot contract: $name",
  ({ valid, target, key, ...change }) => {
    const input = structuredClone(sample);
    const node = target
      .split("/")
      .slice(1)
      .reduce((node, key) => node[key], input as any);
    if ("remove" in change) delete node[key];
    else node[key] = change.value;
    const read = () => parseProject(JSON.stringify(input));
    if (valid) expect(parseProject(serializeProject(read()))).toEqual(read());
    else expect(read).toThrow();
  },
);
it("resolves each placement and used slot independently without inventing false or zero", () => {
  const project = fresh(),
    definition = project.symbols[0];
  const resolve = (slot: string, id?: string) =>
    resolveSymbolSlot(definition, slot, id, project).state;
  expect(resolve("running")).toBe("unbound");
  expect(resolve("running", project.equipment![0].id)).toBe("unassigned");
  expect(resolve("current", project.equipment![0].id)).toBe("unadopted");
  expect(resolve("running", project.equipment![1].id)).toBe("disconnected");
  project.equipmentTypes![0].slots[0].type = "number";
  expect(resolve("running", project.equipment![1].id)).toBe("typeMismatch");
  expect(resolve("current", project.equipment![1].id)).toBe("unassigned");
  project.equipmentTypes![0].slots[0].name = "other";
  for (const item of project.equipment!)
    item.bindings = item.bindings.filter(
      (binding) => binding.slotName !== "running",
    );
  expect(() => parseProject(serializeProject(project))).not.toThrow();
  expect(resolve("running", project.equipment![1].id)).toBe("missingSlot");
  expect(resolve("undeclared")).toBe("missingSlot");
});
it("adds declaration and text in one edit, reuses declarations, rejects type conflicts atomically and supports Undo", () => {
  const original = fresh(),
    history = emptyHistory(),
    symbolId = original.symbols[0].id;
  const command = {
    type: "add-symbol-readout" as const,
    symbolId,
    slotName: "fault",
    slotType: "bool" as const,
  };
  const edited = recordEdit(original, history, command, "edit");
  const next = edited.project;
  expect(next.symbols[0].readSlots).toHaveLength(3);
  expect(next.symbols[0].objects.at(-1)!.shape).toMatchObject({
    slotBinding: { slotName: "fault" },
  });
  const restored = travelHistory(next, edited.history, "undo", "edit").project;
  expect(restored.symbols).toEqual(original.symbols);
  expect(restored.manifest.projectRevision).toBe(
    next.manifest.projectRevision + 1,
  );
  const reused = applyCommand(next, command, "edit");
  expect(reused.symbols[0].readSlots).toHaveLength(3);
  const baseline = serializeProject(reused);
  expect(() =>
    applyCommand(reused, { ...command, slotType: "number" }, "edit"),
  ).toThrow(/型/);
  expect(() =>
    applyCommand(reused, { ...command, slotName: "bad.name" }, "edit"),
  ).toThrow();
  expect(serializeProject(reused)).toBe(baseline);
});
it("copies declarations with a whole unassociated Symbol but refuses slot Text selection as a whole", () => {
  const project = fresh(),
    symbol = project.symbols[0],
    screen = project.screens[0];
  expect(() =>
    copyObjects(
      project,
      symbol.id,
      [symbol.objects[0].id, symbol.objects[5].id],
      "test",
    ),
  ).toThrow(/slot表示単体/);
  const fragment = parseClipboard(
    copyObjects(project, screen.id, [screen.objects[4].id], "test"),
  );
  expect(fragment.project.symbols[0].readSlots).toEqual(symbol.readSlots);
});
it("renders each status without static fallback through placed and embedded screens", () => {
  const project = fresh(),
    screen = project.screens[0];
  const { body } = render(ScreenPainting, {
    props: {
      screen,
      screens: project.screens,
      symbols: project.symbols,
      equipmentContext: project,
    },
  });
  for (const state of ["unassigned", "unadopted", "disconnected", "unbound"])
    expect(body).toContain(`data-tag-state="${state}"`);
  expect(body).not.toContain("STATIC FALLBACK");
  const text = project.symbols[0].objects[5];
  const standalone = render(ObjectPainting, { props: { object: text } }).body;
  expect(standalone).toContain('data-tag-state="unbound"');
  expect(standalone).not.toContain("STATIC FALLBACK");
});

it("passes equipment context into embedded screens without borrowing the owner placement", () => {
  const project = fresh(),
    source = project.screens[0];
  const owner = structuredClone(source);
  owner.id = "0199f600-0000-7000-8000-000000000100";
  owner.objects = [
    {
      id: "0199f600-0000-7000-8000-000000000101",
      order: 0,
      x: 0,
      y: 0,
      width: 960,
      height: 540,
      rotation: 0,
      shape: { type: "screenView", screenId: source.id, fit: "contain" },
    },
  ];
  project.screens.push(owner);
  const valid = parseProject(serializeProject(project));
  const { body } = render(ScreenPainting, {
    props: {
      screen: valid.screens[1],
      screens: valid.screens,
      symbols: valid.symbols,
      equipmentContext: valid,
    },
  });
  for (const state of ["unassigned", "unadopted", "disconnected", "unbound"])
    expect(body).toContain(`data-tag-state="${state}"`);
  expect(body).not.toContain("STATIC FALLBACK");
});
