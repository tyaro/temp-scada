import { expect, it } from "vitest";
import { createProject } from "./new-project";
import { parseProject, serializeProject } from "./project";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { projectContent } from "./save-state";

it("creates independent blank projects that round-trip the current contract", () => {
  const first = createProject(),
    second = createProject();
  const ids = [
    first.manifest.projectId,
    first.screens[0].id,
    second.manifest.projectId,
    second.screens[0].id,
  ];
  expect(new Set(ids).size).toBe(4);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{14}7[0-9a-f-]{21}$/);
  expect(first.manifest.schemaVersion).toBe("0.13.0");
  expect(first.manifest.projectRevision).toBe(1);
  expect(first.screens).toHaveLength(1);
  expect(first.screens[0]).toMatchObject({
    width: 960,
    height: 540,
    background: "#ffffff",
    objects: [],
  });
  expect(first.symbols).toEqual([]);
  expect(parseProject(serializeProject(first))).toEqual(first);
});

it("returns to the new-project baseline after undoing the first edit", () => {
  const project = createProject(),
    baseline = projectContent(project);
  let result = recordEdit(
    project,
    emptyHistory(),
    { type: "add", screenId: project.screens[0].id, kind: "rectangle" },
    "edit",
  );
  expect(projectContent(result.project)).not.toBe(baseline);
  result = travelHistory(result.project, result.history, "undo", "edit");
  expect(projectContent(result.project)).toBe(baseline);
  expect(result.project.manifest.projectRevision).toBe(3);
});
