import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import { parseProject } from "./project";
import { projectContent } from "./save-state";
import { emptyHistory, recordEdit, travelHistory } from "./history";
it("compares content independently of revision and JSON object key ordering", () => {
  const original = parseProject(JSON.stringify(sample));
  const reordered = {
    ...original,
    manifest: { ...original.manifest, projectRevision: 99 },
  };
  expect(projectContent(original)).toBe(projectContent(reordered));
  const reverseKeys = (value: any): any =>
    Array.isArray(value)
      ? value.map(reverseKeys)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, v]) => [key, reverseKeys(v)]),
          )
        : value;
  expect(
    projectContent(parseProject(JSON.stringify(reverseKeys(original)))),
  ).toBe(projectContent(original));
  expect(original.manifest.projectRevision).toBe(1);
});
it("becomes clean on content undo without rolling revision backwards", () => {
  const original = parseProject(JSON.stringify(sample)),
    baseline = projectContent(original);
  let state = recordEdit(
    original,
    emptyHistory(),
    { type: "add", screenId: original.screens[0].id, kind: "rectangle" },
    "edit",
  );
  expect(projectContent(state.project)).not.toBe(baseline);
  state = travelHistory(state.project, state.history, "undo", "edit");
  expect(projectContent(state.project)).toBe(baseline);
  expect(state.project.manifest.projectRevision).toBe(3);
});
it("includes actual geometry, object/screen ordering and project metadata", () => {
  const original = parseProject(JSON.stringify(sample));
  const changed = parseProject(JSON.stringify(sample));
  changed.screens[0].objects[0].x++;
  expect(projectContent(changed)).not.toBe(projectContent(original));
  changed.screens[0].objects[0].x--;
  changed.screens[0].objects.reverse();
  expect(projectContent(changed)).not.toBe(projectContent(original));
  const renamed = parseProject(JSON.stringify(sample));
  renamed.manifest.name = "別名";
  expect(projectContent(renamed)).not.toBe(projectContent(original));
});
