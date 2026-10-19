import { expect, it } from "vitest";
import sample from "../../../../examples/process.project.json";
import cases from "../../../../examples/opacity-cases.json";
import { parseProject, serializeProject, getBounds } from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { copyObjects, parseClipboard } from "./clipboard";
import { objectFormValues } from "./designer/numeric-properties";
it("shares optional bounded opacity with Rust for every placement and definition primitive", () => {
  for (const owner of ["screens", "symbols"] as const)
    for (let i = 0; i < sample[owner][0].objects.length; i++)
      for (const entry of cases) {
        const project: any = structuredClone(sample);
        if ("missing" in entry) delete project[owner][0].objects[i].opacity;
        else project[owner][0].objects[i].opacity = entry.value;
        if (entry.valid)
          expect(parseProject(JSON.stringify(project))).toEqual(project);
        else expect(() => parseProject(JSON.stringify(project))).toThrow();
      }
  const old: any = structuredClone(sample);
  old.manifest.schemaVersion = old.manifest.minRuntimeVersion = "0.13.0";
  expect(() => parseProject(JSON.stringify(old))).toThrow();
});
it("changes only opacity, retains transparent hit bounds, and preserves history/JSON/clipboard", () => {
  const project = parseProject(JSON.stringify(sample)),
    owner = project.screens[0],
    object = owner.objects[0];
  const command = {
    type: "update" as const,
    screenId: owner.id,
    objectId: object.id,
    patch: { opacity: 0 },
  };
  expect(
    recordEdit(
      project,
      emptyHistory(),
      { ...command, patch: { opacity: 1 } },
      "edit",
    ).project,
  ).toBe(project);
  const changed = recordEdit(project, emptyHistory(), command, "edit");
  const next = changed.project.screens[0].objects[0];
  expect(next).toEqual({ ...object, opacity: 0 });
  expect(getBounds(next)).toEqual(getBounds(object));
  expect(parseProject(serializeProject(changed.project))).toEqual(
    changed.project,
  );
  expect(
    parseClipboard(copyObjects(changed.project, owner.id, [object.id], "test"))
      .project.screens[0].objects[0].opacity,
  ).toBe(0);
  const undone = travelHistory(
    changed.project,
    changed.history,
    "undo",
    "edit",
  );
  expect(undone.project.screens).toEqual(project.screens);
  expect(
    travelHistory(undone.project, undone.history, "redo", "edit").project
      .screens,
  ).toEqual(changed.project.screens);
  for (const opacity of [NaN, Infinity, -Infinity, -1, 2])
    expect(() =>
      applyCommand(project, { ...command, patch: { opacity } }, "edit"),
    ).toThrow();
  expect(() => applyCommand(project, command, "preview")).toThrow();
  object.locked = true;
  expect(() => applyCommand(project, command, "edit")).toThrow(/ロック/);
});
it("keeps default no-ops and edits shared primitives independently of placement color", () => {
  const project = parseProject(JSON.stringify(sample)),
    owner = project.symbols[0],
    object = owner.objects[0];
  object.opacity = 1;
  const command = {
    type: "update" as const,
    screenId: project.screens[0].id,
    definitionId: owner.id,
    objectId: object.id,
    patch: { opacity: 1 },
  };
  expect(applyCommand(project, command, "edit")).toBe(project);
  const next = applyCommand(
    project,
    { ...command, patch: { opacity: 0.4 } },
    "edit",
  );
  expect(next.screens).toEqual(project.screens);
  expect(next.symbols[0].objects[0]).toEqual({ ...object, opacity: 0.4 });
  expect(objectFormValues({ ...object, opacity: 0.29 }, true).opacity).toBe(
    "29",
  );
  expect(objectFormValues(next.symbols[0].objects[0], true).opacity).toBe("40");
});
