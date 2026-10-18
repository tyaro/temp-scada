import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import { parseProject } from "./project";
import {
  emptyHistory,
  recordEdit,
  travelHistory,
  HISTORY_LIMIT,
} from "./history";
const fresh = () => parseProject(JSON.stringify(sample));
it("undo and redo restore geometry while advancing revision and preserve identity", () => {
  const original = fresh(),
    screenId = original.screens[0].id,
    objectId = original.screens[0].objects[0].id;
  const edited = recordEdit(
    original,
    emptyHistory(),
    { type: "update", screenId, objectId, patch: { x: 200 } },
    "edit",
  );
  const undone = travelHistory(edited.project, edited.history, "undo", "edit");
  expect(undone.project.screens).toEqual(original.screens);
  expect(undone.project.manifest.projectRevision).toBe(3);
  const redone = travelHistory(undone.project, undone.history, "redo", "edit");
  expect(redone.project.screens).toEqual(edited.project.screens);
  expect(redone.project.manifest.projectRevision).toBe(4);
  expect(redone.project.manifest.projectId).toBe(original.manifest.projectId);
});
it("new edits after undo clear redo; no-ops and invalid edits preserve history", () => {
  const project = fresh(),
    screenId = project.screens[0].id,
    objectId = project.screens[0].objects[0].id;
  const first = recordEdit(
    project,
    emptyHistory(),
    { type: "update", screenId, objectId, patch: { x: 200 } },
    "edit",
  );
  const undone = travelHistory(first.project, first.history, "undo", "edit");
  const noOp = recordEdit(
    undone.project,
    undone.history,
    { type: "update", screenId, objectId, patch: { x: 100 } },
    "edit",
  );
  expect(noOp.project).toBe(undone.project);
  expect(noOp.history).toBe(undone.history);
  expect(() =>
    recordEdit(
      undone.project,
      undone.history,
      { type: "update", screenId, objectId, patch: { width: 0 } },
      "edit",
    ),
  ).toThrow();
  expect(undone.history.future).toHaveLength(1);
  const branched = recordEdit(
    undone.project,
    undone.history,
    { type: "update", screenId, objectId, patch: { x: 300 } },
    "edit",
  );
  expect(branched.history.future).toHaveLength(0);
  expect(
    travelHistory(branched.project, branched.history, "redo", "edit").project,
  ).toBe(branched.project);
});
it("keeps bounded history and rejects preview and cross-Project travel", () => {
  let current = { project: fresh(), history: emptyHistory() };
  const screenId = current.project.screens[0].id;
  for (let i = 0; i < HISTORY_LIMIT + 2; i++)
    current = recordEdit(
      current.project,
      current.history,
      { type: "add", screenId, kind: "line" },
      "edit",
    );
  expect(current.history.past).toHaveLength(HISTORY_LIMIT);
  expect(() =>
    travelHistory(current.project, current.history, "undo", "preview"),
  ).toThrow("プレビュー");
  const another = fresh();
  another.manifest.projectId = "0199f800-0000-7000-8000-000000000001";
  expect(() => travelHistory(another, current.history, "undo", "edit")).toThrow(
    "別の Project",
  );
});
it("deletion of a Symbol instance can be undone without losing the shared definition", () => {
  const project = fresh(),
    screenId = project.screens[0].id;
  const added = recordEdit(
    project,
    emptyHistory(),
    { type: "add-symbol", screenId, template: "pump" },
    "edit",
  );
  const objectId = added.project.screens[0].objects.at(-1)!.id;
  const removed = recordEdit(
    added.project,
    added.history,
    { type: "remove", screenId, objectId },
    "edit",
  );
  const restored = travelHistory(
    removed.project,
    removed.history,
    "undo",
    "edit",
  );
  expect(restored.project.screens).toEqual(added.project.screens);
  expect(restored.project.symbols).toEqual(added.project.symbols);
});
