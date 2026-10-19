import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { parseProject, serializeProject } from "./project";
const fresh = () => parseProject(JSON.stringify(sample));

it("renames only Project metadata, trims it and preserves IDs, content and JSON", () => {
  const original = fresh();
  const result = applyCommand(
    original,
    { type: "update-project", name: "  水処理設備  " },
    "edit",
  );
  expect(result.manifest).toEqual({
    ...original.manifest,
    name: "水処理設備",
    projectRevision: original.manifest.projectRevision + 1,
  });
  expect(result.screens).toEqual(original.screens);
  expect(result.symbols).toEqual(original.symbols);
  expect(parseProject(serializeProject(result))).toEqual(result);
  expect(original).toEqual(fresh());
});
it("retains history for semantic no-ops and restores names with increasing revision", () => {
  const original = fresh(),
    history = emptyHistory();
  expect(
    recordEdit(
      original,
      history,
      { type: "update-project", name: ` ${original.manifest.name} ` },
      "edit",
    ),
  ).toEqual({ project: original, history });
  const renamed = recordEdit(
    original,
    history,
    { type: "update-project", name: "工程A" },
    "edit",
  );
  const undone = travelHistory(
    renamed.project,
    renamed.history,
    "undo",
    "edit",
  );
  expect(undone.project.manifest.name).toBe(original.manifest.name);
  const redone = travelHistory(undone.project, undone.history, "redo", "edit");
  expect(redone.project.manifest.name).toBe("工程A");
  expect(redone.project.manifest.projectRevision).toBe(
    original.manifest.projectRevision + 3,
  );
});
it("rejects empty and oversized names and every preview edit atomically", () => {
  const original = fresh();
  for (const name of ["", "   ", "a".repeat(201)])
    expect(() =>
      applyCommand(original, { type: "update-project", name }, "edit"),
    ).toThrow();
  expect(() =>
    applyCommand(
      original,
      { type: "update-project", name: "工程A" },
      "preview",
    ),
  ).toThrow("プレビュー");
  expect(original).toEqual(fresh());
});
