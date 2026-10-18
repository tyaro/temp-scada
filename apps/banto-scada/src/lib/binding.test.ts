import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import boundSample from "../../../../examples/tag-binding.project.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
const fresh = () => parseProject(JSON.stringify(sample));
it("assigns, copies, undoes and removes a direct binding without mutating the input", () => {
  const project = fresh(),
    screenId = project.screens[0].id,
    objectId = project.screens[0].objects[2].id;
  const binding = { externalName: "PLC01.Fast.Tank01.Level" };
  const edit = recordEdit(
    project,
    emptyHistory(),
    { type: "update", screenId, objectId, patch: { binding } },
    "edit",
  );
  expect(project).toEqual(fresh());
  expect(edit.project.screens[0].objects[2].shape).toMatchObject({ binding });
  expect(parseProject(serializeProject(edit.project))).toEqual(edit.project);
  const undo = travelHistory(edit.project, edit.history, "undo", "edit");
  expect(undo.project.screens).toEqual(project.screens);
  const redo = travelHistory(undo.project, undo.history, "redo", "edit");
  expect(redo.project.screens).toEqual(edit.project.screens);
  const copied = applyCommand(
    edit.project,
    { type: "duplicate", screenId, objectId },
    "edit",
  );
  expect(copied.screens[0].objects.at(-1)!.shape).toMatchObject({ binding });
  // 同じ外部名の複数表示を許容する。SDK への要求を作る時に外部名で集約する。
  const unbound = applyCommand(
    edit.project,
    { type: "update", screenId, objectId, patch: { binding: null } },
    "edit",
  );
  expect(unbound.screens).toEqual(project.screens);
  expect(
    applyCommand(
      edit.project,
      { type: "update", screenId, objectId, patch: { binding } },
      "edit",
    ),
  ).toBe(edit.project);
});
it("rejects wrong targets and invalid bindings atomically, also in preview", () => {
  const project = fresh(),
    screenId = project.screens[0].id;
  const command = {
    type: "update" as const,
    screenId,
    objectId: project.screens[0].objects[0].id,
    patch: { binding: { externalName: "PLC01.Fast.Value" } },
  };
  expect(() => applyCommand(project, command, "edit")).toThrow("Text");
  expect(() => applyCommand(project, command, "preview")).toThrow("プレビュー");
  command.objectId = project.screens[0].objects[2].id;
  command.patch.binding.externalName = "   ";
  expect(() => applyCommand(project, command, "edit")).toThrow();
  expect(project).toEqual(fresh());
});
it("round-trips the binding sample and keeps runtime readings out of Project", () => {
  const project = parseProject(JSON.stringify(boundSample));
  expect(parseProject(serializeProject(project))).toEqual(project);
  expect(() =>
    parseProject(JSON.stringify({ ...project, readings: {} })),
  ).toThrow();
});
