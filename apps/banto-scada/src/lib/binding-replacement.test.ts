import { expect, it } from "vitest";
import sample from "../../../../examples/tag-binding.project.json";
import { parseProject, serializeProject, type Project } from "./project";
import { previewBindingReplacement } from "./binding-replacement";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { bindingReferences } from "./binding-references";

const from = "PLC01.Fast.Tank01.Level";
function fresh() {
  return parseProject(JSON.stringify(sample));
}
function text(project: Project, screenIndex = 0) {
  const object = project.screens[screenIndex].objects[2];
  if (object.shape.type !== "text" || !object.shape.binding)
    throw new Error("fixture");
  return object.shape;
}
function command(project: Project, to = "Tank.NewLevel") {
  const { expectedProject } = previewBindingReplacement(project, from, to);
  return {
    type: "replace-binding-reference" as const,
    from,
    to,
    expectedProject,
  };
}
function twoScreens() {
  const project = fresh();
  return applyCommand(
    project,
    { type: "duplicate-screen", screenId: project.screens[0].id },
    "edit",
  );
}
it("previews every screen including hidden placements without changing source, and only replaces exact saved names", () => {
  const project = twoScreens();
  project.screens[1].objects[2].visible = false;
  const before = serializeProject(project);
  const preview = previewBindingReplacement(project, from, "Tank.NewLevel");
  expect(preview.usages).toHaveLength(2);
  expect(preview.usages[1].visible).toBe(false);
  expect(preview.blocked).toEqual([]);
  expect(serializeProject(project)).toBe(before);
  const next = applyCommand(project, command(project), "edit");
  const expected = parseProject(before);
  text(expected).binding!.externalName = "Tank.NewLevel";
  text(expected, 1).binding!.externalName = "Tank.NewLevel";
  expected.manifest.projectRevision++;
  expect(next).toEqual(expected);
  expect(serializeProject(project)).toBe(before);
  expect(parseProject(serializeProject(next))).toEqual(next);
});
it("keeps case and full-width names separate and reports an existing destination", () => {
  const project = twoScreens();
  text(project, 1).binding!.externalName = from.toLowerCase();
  const preview = previewBindingReplacement(project, from, from.toLowerCase());
  expect(preview.usages).toHaveLength(1);
  expect(preview.existingDestinationUsages).toHaveLength(1);
  const next = applyCommand(
    project,
    command(project, from.toLowerCase()),
    "edit",
  );
  expect(bindingReferences(next)).toHaveLength(1);
  expect(bindingReferences(next)[0].usages).toHaveLength(2);
  const wide = "ＰＬＣ01.Fast.Tank01.Level";
  expect(() => previewBindingReplacement(project, wide, "other")).toThrow(
    /見つかりません/,
  );
});
it("preserves whitespace in valid names rather than silently normalizing", () => {
  const project = fresh();
  expect(
    text(applyCommand(project, command(project, "  Tank.Level  "), "edit"))
      .binding!.externalName,
  ).toBe("  Tank.Level  ");
});
it.each(["", " ", "\n\t", "x".repeat(1025), "😀".repeat(1025)])(
  "rejects an invalid destination atomically: %j",
  (to) => {
    const project = fresh();
    const before = serializeProject(project);
    expect(() => previewBindingReplacement(project, from, to)).toThrow();
    expect(() =>
      applyCommand(project, { ...command(project), to }, "edit"),
    ).toThrow();
    expect(serializeProject(project)).toBe(before);
  },
);
it.each(["lock", "group"])(
  "rejects all screens when one target is blocked by %s",
  (kind) => {
    const project = twoScreens();
    const screen = project.screens[1];
    if (kind === "lock") screen.objects[2].locked = true;
    else {
      // Existing group command creates a valid contiguous group.
      const grouped = applyCommand(
        project,
        {
          type: "group",
          screenId: screen.id,
          objectIds: [screen.objects[1].id, screen.objects[2].id],
        },
        "edit",
      );
      project.screens = grouped.screens;
    }
    const before = serializeProject(project);
    expect(
      previewBindingReplacement(project, from, "other").blocked,
    ).toHaveLength(1);
    expect(() => applyCommand(project, command(project), "edit")).toThrow(
      /全件/,
    );
    expect(serializeProject(project)).toBe(before);
  },
);
it("records one history entry for all targets and supports Undo, Redo and no-op", () => {
  const project = twoScreens();
  const history = emptyHistory();
  const noop = recordEdit(project, history, command(project, from), "edit");
  expect(noop.project).toBe(project);
  expect(noop.history).toBe(history);
  const changed = recordEdit(project, history, command(project), "edit");
  expect(changed.history.past).toHaveLength(1);
  const undone = travelHistory(
    changed.project,
    changed.history,
    "undo",
    "edit",
  );
  expect(bindingReferences(undone.project)[0].externalName).toBe(from);
  const redone = travelHistory(undone.project, undone.history, "redo", "edit");
  expect(bindingReferences(redone.project)[0].externalName).toBe(
    "Tank.NewLevel",
  );
  expect(redone.project.manifest.projectRevision).toBe(
    project.manifest.projectRevision + 3,
  );
});
it("rejects stale content, revision, foreign Project and Undo roundtrips", () => {
  const project = fresh(),
    request = command(project);
  const changed = recordEdit(
    project,
    emptyHistory(),
    { type: "update-project", name: "Changed" },
    "edit",
  );
  const undone = travelHistory(
    changed.project,
    changed.history,
    "undo",
    "edit",
  );
  const other = fresh();
  other.manifest.projectId = "01900000-0000-7000-8000-000000000001";
  const contentOnly = fresh();
  contentOnly.manifest.name = "Same revision, different content";
  for (const current of [changed.project, undone.project, other, contentOnly]) {
    const before = serializeProject(current);
    expect(() => applyCommand(current, request, "edit")).toThrow(/再確認/);
    expect(serializeProject(current)).toBe(before);
  }
});
it("recomputes targets and ignores forged preview arrays, rejects preview mode and missing source", () => {
  const project = fresh();
  const request = { ...command(project), usages: [], blocked: [] };
  expect(
    text(applyCommand(project, request, "edit")).binding!.externalName,
  ).toBe("Tank.NewLevel");
  expect(() => applyCommand(project, request, "preview")).toThrow(/プレビュー/);
  expect(() =>
    applyCommand(project, { ...request, from: "missing" }, "edit"),
  ).toThrow(/見つかりません/);
});

it("keeps a locked no-op out of history and rejects a revision overflow without partial edits", () => {
  const project = twoScreens();
  project.screens[1].objects[2].locked = true;
  const history = emptyHistory();
  expect(recordEdit(project, history, command(project, from), "edit")).toEqual({
    project,
    history,
  });
  project.screens[1].objects[2].locked = false;
  project.manifest.projectRevision = Number.MAX_SAFE_INTEGER;
  const before = serializeProject(project);
  expect(() =>
    recordEdit(project, history, command(project), "edit"),
  ).toThrow();
  expect(serializeProject(project)).toBe(before);
  expect(history).toEqual(emptyHistory());
});
