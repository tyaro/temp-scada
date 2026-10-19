import { expect, it } from "vitest";
import sample from "../../../../examples/process.project.json";
import { applyCommand, type EditCommand } from "./editor";
import { parseProject, serializeProject } from "./project";
import { emptyHistory, recordEdit, travelHistory } from "./history";
function fixture() {
  const project = parseProject(JSON.stringify(sample));
  const owner = project.screens[0];
  const lines = owner.objects.filter(
    (object) => object.shape.type === "polyline",
  );
  const objectIds = lines.map((object) => object.id);
  const command = (patch: {
    strokeWidth?: number;
    arrow?: "none" | "end";
  }): EditCommand => ({
    type: "set-line-style",
    screenId: owner.id,
    objectIds,
    patch,
  });
  return { project, owner, lines, objectIds, command };
}
it("changes selected line width and arrows atomically with one Undo and preserves drawing data", () => {
  const { project, lines, command } = fixture();
  const result = recordEdit(
    project,
    emptyHistory(),
    command({ strokeWidth: 3.5, arrow: "end" }),
    "edit",
  );
  const changed = result.project.screens[0].objects.filter((object) =>
    lines.some((line) => line.id === object.id),
  );
  expect(changed).toEqual(
    lines.map((line) => ({
      ...line,
      shape: { ...line.shape, strokeWidth: 3.5, arrow: "end" },
    })),
  );
  expect(result.project.symbols).toEqual(project.symbols);
  expect(parseProject(serializeProject(result.project))).toEqual(
    result.project,
  );
  const undo = travelHistory(result.project, result.history, "undo", "edit");
  expect(undo.project.screens).toEqual(project.screens);
  expect(
    travelHistory(undo.project, undo.history, "redo", "edit").project.screens,
  ).toEqual(result.project.screens);
});
it("keeps unspecified properties, permits explicit arrow removal, and does not record no-ops", () => {
  const { project, command, lines } = fixture();
  const arrow = applyCommand(project, command({ arrow: "end" }), "edit");
  expect(
    arrow.screens[0].objects.filter((object) =>
      lines.some((line) => line.id === object.id),
    ),
  ).toEqual(
    lines.map((line) => ({ ...line, shape: { ...line.shape, arrow: "end" } })),
  );
  const width = applyCommand(arrow, command({ strokeWidth: 0.25 }), "edit");
  for (const object of width.screens[0].objects)
    if (object.shape.type === "polyline")
      expect(object.shape.arrow).toBe("end");
  const none = applyCommand(width, command({ arrow: "none" }), "edit");
  for (const object of none.screens[0].objects)
    if (object.shape.type === "polyline")
      expect(object.shape.strokeWidth).toBe(0.25);
  expect(applyCommand(project, command({}), "edit")).toBe(project);
  expect(
    applyCommand(width, command({ strokeWidth: 0.25, arrow: "end" }), "edit"),
  ).toBe(width);
});
it("rejects invalid widths, arrows, partial target sets and non-line mixtures without mutation", () => {
  const { project, owner, objectIds, command } = fixture();
  const serialized = serializeProject(project);
  for (const value of [0, -1, 64.01, Infinity, NaN, "2", null])
    expect(() =>
      applyCommand(project, command({ strokeWidth: value as number }), "edit"),
    ).toThrow();
  for (const patch of [
    { arrow: "start" },
    { arrow: "" },
    { strokeWidth: 4, fill: "#ffffff" },
    [],
    null,
  ])
    expect(() =>
      applyCommand(project, { ...command({}), patch } as EditCommand, "edit"),
    ).toThrow();
  for (const ids of [
    [],
    [objectIds[0], objectIds[0]],
    [...objectIds, "missing"],
    [
      ...objectIds,
      owner.objects.find((object) => object.shape.type !== "polyline")!.id,
    ],
  ])
    expect(() =>
      applyCommand(
        project,
        { ...command({ strokeWidth: 64 }), objectIds: ids } as EditCommand,
        "edit",
      ),
    ).toThrow();
  expect(() =>
    applyCommand(project, command({ strokeWidth: 4 }), "preview"),
  ).toThrow();
  expect(serializeProject(project)).toBe(serialized);
  expect(
    applyCommand(project, command({ strokeWidth: 64 }), "edit")
      .screens[0].objects.filter((object) => object.shape.type === "polyline")
      .every(
        (object) =>
          object.shape.type === "polyline" && object.shape.strokeWidth === 64,
      ),
  ).toBe(true);
});
it("rejects locked mixtures as a whole but includes explicitly selected hidden lines", () => {
  const { project, lines, command } = fixture();
  project.screens[0].folders = [
    { id: "0199ff10-0000-7000-8000-000000000001", name: "配管", order: 0 },
  ];
  lines[0].folderId = project.screens[0].folders[0].id;
  lines[1].locked = true;
  expect(() =>
    applyCommand(project, command({ arrow: "end" }), "edit"),
  ).toThrow(/ロック/);
  delete lines[1].locked;
  lines[0].visible = false;
  const changed = applyCommand(project, command({ strokeWidth: 4 }), "edit");
  expect(
    changed.screens[0].objects.find((object) => object.id === lines[0].id)
      ?.visible,
  ).toBe(false);
  expect(changed.screens[0].folders).toEqual(project.screens[0].folders);
  expect(
    changed.screens[0].objects.find((object) => object.id === lines[0].id)
      ?.folderId,
  ).toBe(lines[0].folderId);
  expect(
    changed.screens[0].objects.find((object) => object.id === lines[0].id)
      ?.shape,
  ).toMatchObject({ strokeWidth: 4 });
});
it("styles definition internals without mutating their parent placements or another owner", () => {
  const { project, owner } = fixture();
  const definition = project.symbols[0];
  const ids = definition.objects.map((object) => object.id);
  const result = applyCommand(
    project,
    {
      type: "set-line-style",
      screenId: owner.id,
      definitionId: definition.id,
      objectIds: ids,
      patch: { strokeWidth: 2.5, arrow: "end" },
    },
    "edit",
  );
  expect(result.screens).toEqual(project.screens);
  expect(result.symbols[1]).toEqual(project.symbols[1]);
  for (const object of result.symbols[0].objects)
    expect(object.shape).toMatchObject({ strokeWidth: 2.5, arrow: "end" });
});
