import { expect, it } from "vitest";
import { render } from "svelte/server";
import sample from "../../../../examples/equipment-property.project.json";
import { parseProject, serializeProject, type LayoutObject } from "./project";
import { resolveEquipmentProperty } from "./equipment-property";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { copyObjects, parseClipboard } from "./clipboard";
import { objectFormValues } from "./designer/numeric-properties";
import { objectFormCommand } from "./designer/forms/object-form";
import ObjectPainting from "./ObjectPainting.svelte";
const fresh = () => parseProject(JSON.stringify(sample));
it("resolves saved metadata by explicit equipment and never reads signals", () => {
  const project = fresh();
  const context = {
    ...project,
    readSlot: () => {
      throw new Error("metadata must not read values");
    },
  };
  for (const item of project.equipment!) {
    expect(resolveEquipmentProperty("code", item.id, context)).toMatchObject({
      state: "resolved",
      text: item.code,
    });
    expect(resolveEquipmentProperty("name", item.id, context).text).toBe(
      item.name,
    );
    expect(resolveEquipmentProperty("typeName", item.id, context).text).toBe(
      project.equipmentTypes!.find((type) => type.id === item.typeId)!.name,
    );
  }
  for (const id of [undefined, "missing", project.equipment![0].id]) {
    expect(resolveEquipmentProperty("name", id)).toMatchObject({
      state: "unbound",
      text: "機器未関連付け",
    });
  }
  expect(resolveEquipmentProperty("name", undefined, project).state).toBe(
    "unbound",
  );
  expect(
    resolveEquipmentProperty("name", undefined, undefined, true),
  ).toMatchObject({ state: "example", text: "〈機器名：例示〉" });
  expect(
    resolveEquipmentProperty("typeName", project.equipment![0].id, {
      equipment: project.equipment,
    }),
  ).toMatchObject({ state: "missingType", text: "機器種別なし" });
});
it("metadata declarations roundtrip without duplicating equipment or slot IDs", () => {
  const project = fresh();
  expect(parseProject(serializeProject(project))).toEqual(project);
  expect(project.symbols[0].objects.at(-1)!.shape).toMatchObject({
    equipmentProperty: { field: "typeName" },
  });
});
it("form changes slot to metadata atomically, clears bool colors and supports no-op and Undo", () => {
  const original = fresh(),
    definition = original.symbols[0];
  const object = definition.objects[5] as LayoutObject;
  if (object.shape.type !== "text") throw new Error("fixture");
  object.shape.boolColors = {
    trueColor: "#00ff00",
    falseColor: "#999999",
    unknownColor: "#777777",
  };
  const form = new Map(Object.entries(objectFormValues(object, true)));
  form.set("slotName", "@name");
  const command = objectFormCommand(
    { get: (key) => form.get(key) ?? null, has: (key) => form.has(key) },
    {
      screenId: definition.id,
      definition: true,
      selected: object,
      readSlots: definition.readSlots,
    },
  );
  if (command.type !== "update") throw new Error("fixture command");
  const result = recordEdit(
    original,
    emptyHistory(),
    { ...command, definitionId: definition.id },
    "edit",
  );
  const shape = result.project.symbols[0].objects[5].shape;
  expect(shape).toMatchObject({ equipmentProperty: { field: "name" } });
  expect(shape).not.toHaveProperty("slotBinding");
  expect(shape).not.toHaveProperty("boolColors");
  expect(
    applyCommand(
      result.project,
      { ...command, definitionId: definition.id },
      "edit",
    ),
  ).toBe(result.project);
  expect(
    travelHistory(result.project, result.history, "undo", "edit").project
      .symbols,
  ).toEqual(original.symbols);
  form.set("slotName", "@unknown");
  expect(() =>
    objectFormCommand(
      { get: (key) => form.get(key) ?? null, has: (key) => form.has(key) },
      { screenId: definition.id, definition: true, selected: object },
    ),
  ).toThrow(/機器情報/);
});
it("rejects non-definition edits and state-color source destruction atomically", () => {
  const project = fresh(),
    definition = project.symbols[0],
    screen = project.screens[0];
  const before = serializeProject(project);
  expect(() =>
    applyCommand(
      project,
      {
        type: "update",
        screenId: screen.id,
        objectId: screen.objects[1].id,
        patch: { equipmentProperty: { field: "name" } },
      },
      "edit",
    ),
  ).toThrow();
  const source = definition.objects[5];
  if (source.shape.type !== "text") throw new Error("fixture");
  source.shape.boolColors = {
    trueColor: "#00ff00",
    falseColor: "#999999",
    unknownColor: "#777777",
  };
  const follower = definition.objects[0];
  if (follower.shape.type !== "polyline") throw new Error("fixture");
  follower.shape.stateColor = { textId: source.id };
  expect(() =>
    applyCommand(
      project,
      {
        type: "update",
        screenId: definition.id,
        definitionId: definition.id,
        objectId: source.id,
        patch: {
          slotBinding: null,
          boolColors: null,
          equipmentProperty: { field: "code" },
        },
      },
      "edit",
    ),
  ).toThrow();
  expect(serializeProject(fresh())).toBe(before);
  expect(source.shape.slotBinding).toEqual({ slotName: "running" });
});
it("copies whole unassociated Symbol with declarations but refuses dependent Text alone", () => {
  const project = fresh(),
    definition = project.symbols[0],
    screen = project.screens[0];
  expect(() =>
    copyObjects(
      project,
      definition.id,
      [definition.objects.at(-1)!.id],
      "test",
    ),
  ).toThrow(/機器情報/);
  const placement = screen.objects.find(
    (object) => object.shape.type === "symbol" && !object.shape.equipmentId,
  )!;
  const clipboard = parseClipboard(
    copyObjects(project, screen.id, [placement.id], "test"),
  );
  expect(clipboard.project.symbols[0].objects.at(-1)!.shape).toMatchObject({
    equipmentProperty: { field: "typeName" },
  });
});
it("actual instances use only their context, definition example is explicitly enabled", () => {
  const project = fresh(),
    definition = project.symbols[0];
  for (const object of project.screens[0].objects.filter(
    (object) => object.shape.type === "symbol",
  )) {
    const markup = render(ObjectPainting, {
      props: { object, symbols: project.symbols, equipmentContext: project },
    }).body;
    const equipmentId =
      object.shape.type === "symbol" ? object.shape.equipmentId : undefined;
    const equipment = project.equipment?.find(
      (item) => item.id === equipmentId,
    );
    expect(markup).toContain(equipment?.name ?? "機器未関連付け");
    expect(markup).not.toContain("：例示");
    expect(markup).not.toContain("STATIC METADATA FALLBACK");
  }
  const text = definition.objects.at(-2)!;
  expect(
    render(ObjectPainting, {
      props: { object: text, ownerDefinition: definition },
    }).body,
  ).toContain("〈機器名：例示〉");
  expect(render(ObjectPainting, { props: { object: text } }).body).toContain(
    "機器未関連付け",
  );
});

it("accepts proxied metadata in same-value command without history", () => {
  const project = fresh(),
    definition = project.symbols[0],
    object = definition.objects.at(-1)!;
  if (object.shape.type !== "text" || !object.shape.equipmentProperty)
    throw new Error("fixture");
  const property = new Proxy(object.shape.equipmentProperty, {});
  const command = {
    type: "update" as const,
    screenId: project.screens[0].id,
    definitionId: definition.id,
    objectId: object.id,
    patch: { equipmentProperty: property },
  };
  expect(applyCommand(project, command, "edit")).toBe(project);
  expect(
    recordEdit(project, emptyHistory(), command, "edit").history.past,
  ).toHaveLength(0);
});
