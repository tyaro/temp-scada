import { it, expect } from "vitest";
import sample from "../../../../examples/process.project.json";
import minimal from "../../../../examples/minimal.project.json";
import { applyCommand, type EditCommand } from "./editor";
import { parseProject, serializeProject } from "./project";
import { recordEdit, emptyHistory, travelHistory } from "./history";
import { copyObjects } from "./clipboard";
function fixture() {
  const project = parseProject(JSON.stringify(sample));
  const owner = project.screens[0];
  const object = owner.objects.find(
    (object) => object.shape.type === "symbol",
  )!;
  const setMode = (colorMode: "monochrome" | "definition"): EditCommand => ({
    type: "update",
    screenId: owner.id,
    objectId: object.id,
    patch: { colorMode },
  });
  return { project, owner, object, setMode };
}
it("changes mode with one Undo, preserves stored fill and layout, and round-trips JSON", () => {
  const { project, owner, object, setMode } = fixture();
  const result = recordEdit(
    project,
    emptyHistory(),
    setMode("definition"),
    "edit",
  );
  expect(
    result.project.screens[0].objects.find((item) => item.id === object.id),
  ).toEqual({ ...object, shape: { ...object.shape, colorMode: "definition" } });
  expect(result.project.symbols).toEqual(project.symbols);
  expect(parseProject(serializeProject(result.project))).toEqual(
    result.project,
  );
  const undo = travelHistory(result.project, result.history, "undo", "edit");
  expect(undo.project.screens[0]).toEqual(owner);
  expect(
    travelHistory(undo.project, undo.history, "redo", "edit").project.screens,
  ).toEqual(result.project.screens);
  expect(applyCommand(project, setMode("monochrome"), "edit")).toBe(project);
  expect(applyCommand(result.project, setMode("definition"), "edit")).toBe(
    result.project,
  );
  const back = applyCommand(result.project, setMode("monochrome"), "edit");
  expect(
    back.screens[0].objects.find((item) => item.id === object.id)?.fill,
  ).toBe(object.fill);
});
it("rejects invalid modes, non-Symbol targets, preview and locked changes without partial edits", () => {
  const { project, owner, object, setMode } = fixture();
  const before = serializeProject(project);
  for (const value of ["auto", "", null, 1])
    expect(() =>
      applyCommand(
        project,
        {
          ...setMode("definition"),
          patch: { colorMode: value },
        } as EditCommand,
        "edit",
      ),
    ).toThrow();
  expect(() =>
    applyCommand(
      project,
      {
        ...setMode("definition"),
        objectId: owner.objects.find((item) => item.shape.type !== "symbol")!
          .id,
      } as EditCommand,
      "edit",
    ),
  ).toThrow();
  expect(() =>
    applyCommand(project, setMode("definition"), "preview"),
  ).toThrow();
  expect(serializeProject(project)).toBe(before);
  object.locked = true;
  expect(() => applyCommand(project, setMode("definition"), "edit")).toThrow(
    /ロック/,
  );
});
it("requires an explicit conversion before common color can change definition-mode Symbols", () => {
  const { project, owner, object, setMode } = fixture();
  const source = applyCommand(project, setMode("definition"), "edit");
  const command: EditCommand = {
    type: "set-color",
    screenId: owner.id,
    objectIds: [object.id, owner.objects[0].id],
    fill: "#aabbcc",
  };
  expect(() => applyCommand(source, command, "edit")).toThrow(/明示/);
  expect(() =>
    applyCommand(
      source,
      { ...command, convertDefinitionSymbols: false },
      "edit",
    ),
  ).toThrow(/明示/);
  for (const value of ["yes", null, 1])
    expect(() =>
      applyCommand(
        source,
        {
          ...command,
          convertDefinitionSymbols: value,
        } as unknown as EditCommand,
        "edit",
      ),
    ).toThrow();
  const result = recordEdit(
    source,
    emptyHistory(),
    { ...command, convertDefinitionSymbols: true },
    "edit",
  );
  expect(
    result.project.screens[0].objects.find((item) => item.id === object.id),
  ).toEqual({
    ...object,
    fill: "#aabbcc",
    shape: { ...object.shape, colorMode: "monochrome" },
  });
  expect(result.project.screens[0].objects[0].fill).toBe("#aabbcc");
  expect(result.project.symbols).toEqual(source.symbols);
  expect(
    travelHistory(result.project, result.history, "undo", "edit").project
      .screens,
  ).toEqual(source.screens);
});
it("records mode conversion even when fill matches, and treats fully matching color/mode as no-op", () => {
  const { project, owner, object, setMode } = fixture();
  const source = applyCommand(project, setMode("definition"), "edit");
  const command: EditCommand = {
    type: "set-color",
    screenId: owner.id,
    objectIds: [object.id],
    fill: object.fill,
    convertDefinitionSymbols: true,
  };
  const result = recordEdit(source, emptyHistory(), command, "edit");
  expect(result.history.past).toHaveLength(1);
  expect(applyCommand(result.project, command, "edit")).toBe(result.project);
});
it("conversion rejects locked mixtures atomically and preserves hidden placement metadata", () => {
  const { project, owner, object, setMode } = fixture();
  const source = applyCommand(project, setMode("definition"), "edit");
  source.screens[0].objects[0].locked = true;
  const command: EditCommand = {
    type: "set-color",
    screenId: owner.id,
    objectIds: [object.id, owner.objects[0].id],
    fill: "#112233",
    convertDefinitionSymbols: true,
  };
  const before = serializeProject(source);
  expect(() => applyCommand(source, command, "edit")).toThrow(/ロック/);
  expect(serializeProject(source)).toBe(before);
  delete source.screens[0].objects[0].locked;
  source.screens[0].objects.find((item) => item.id === object.id)!.visible =
    false;
  const result = applyCommand(source, command, "edit");
  expect(
    result.screens[0].objects.find((item) => item.id === object.id)?.visible,
  ).toBe(false);
});
it("reference replacement, independent copies and placement duplication preserve color mode and stored fill", () => {
  const { project, owner, object, setMode } = fixture();
  const source = applyCommand(project, setMode("definition"), "edit");
  for (const command of [
    {
      type: "update",
      screenId: owner.id,
      objectId: object.id,
      patch: { symbolId: project.symbols[1].id },
    },
    { type: "make-symbol-unique", screenId: owner.id, objectId: object.id },
    { type: "duplicate", screenId: owner.id, objectId: object.id },
    { type: "duplicate-screen", screenId: owner.id },
  ] as EditCommand[]) {
    const result = applyCommand(source, command, "edit");
    const target =
      command.type === "duplicate-screen"
        ? result.screens[1].objects.find(
            (item) => item.shape.type === "symbol",
          )!
        : command.type === "duplicate"
          ? result.screens[0].objects.at(-1)!
          : result.screens[0].objects.find((item) => item.id === object.id)!;
    expect(target.shape).toMatchObject({ colorMode: "definition" });
    expect(target.fill).toBe(object.fill);
  }
});
it("same and cross-project clipboard retain mode and fill while importing the definition independently", () => {
  const { project, owner, object, setMode } = fixture();
  const source = applyCommand(project, setMode("definition"), "edit");
  const text = copyObjects(source, owner.id, [object.id], "source");
  const target = parseProject(JSON.stringify(minimal));
  for (const current of [source, target]) {
    const result = applyCommand(
      current,
      {
        type: "paste",
        screenId: current.screens[0].id,
        text,
        origin: "source",
        center: { x: 100, y: 100 },
      },
      "edit",
    );
    expect(result.screens[0].objects.at(-1)!.shape).toMatchObject({
      colorMode: "definition",
    });
    expect(result.screens[0].objects.at(-1)!.fill).toBe(object.fill);
    expect(parseProject(serializeProject(result))).toEqual(result);
  }
});
it("new built-in and custom placements start monochrome", () => {
  const { project, owner } = fixture();
  for (const command of [
    { type: "add-symbol", screenId: owner.id, template: "pump" },
    {
      type: "place-symbol",
      screenId: owner.id,
      symbolId: project.symbols[0].id,
    },
  ] as EditCommand[])
    expect(
      applyCommand(project, command, "edit").screens[0].objects.at(-1)!.shape,
    ).toMatchObject({ colorMode: "monochrome" });
});
