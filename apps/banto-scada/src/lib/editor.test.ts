import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import { parseProject } from "./project";
import { applyCommand } from "./editor";
const fresh = () => parseProject(JSON.stringify(sample));
it("adds UUID v7 objects, changes geometry and removes without changing the input", () => {
  const original = fresh();
  const screenId = original.screens[0].id;
  const added = applyCommand(
    original,
    { type: "add", screenId, kind: "rectangle" },
    "edit",
  );
  const object = added.screens[0].objects.at(-1)!;
  expect(original).toEqual(fresh());
  expect(added.manifest.projectRevision).toBe(2);
  expect(object.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const moved = applyCommand(
    added,
    {
      type: "update",
      screenId,
      objectId: object.id,
      patch: { x: 12.5, width: 200, fill: "#ffffff" },
    },
    "edit",
  );
  expect(moved.screens[0].objects.at(-1)).toMatchObject({
    id: object.id,
    x: 12.5,
    width: 200,
    fill: "#ffffff",
  });
  const removed = applyCommand(
    moved,
    { type: "remove", screenId, objectId: object.id },
    "edit",
  );
  expect(removed.screens).toEqual(original.screens);
  expect(removed.manifest.projectRevision).toBe(4);
});
it("rejects invalid edits atomically and preview mutations", () => {
  const original = fresh();
  const screenId = original.screens[0].id;
  const objectId = original.screens[0].objects[0].id;
  expect(() =>
    applyCommand(
      original,
      { type: "update", screenId, objectId, patch: { width: 0 } },
      "edit",
    ),
  ).toThrow();
  expect(() =>
    applyCommand(original, { type: "remove", screenId, objectId }, "preview"),
  ).toThrow("プレビュー");
  expect(original).toEqual(fresh());
});
it("edits text and rejects a missing target", () => {
  const original = fresh();
  const screenId = original.screens[0].id;
  const text = original.screens[0].objects[2];
  expect(
    applyCommand(
      original,
      { type: "update", screenId, objectId: text.id, patch: { text: "槽 A" } },
      "edit",
    ).screens[0].objects[2].shape,
  ).toEqual({ type: "text", text: "槽 A" });
  expect(() =>
    applyCommand(
      original,
      { type: "remove", screenId, objectId: "missing" },
      "edit",
    ),
  ).toThrow();
});

it("reuses one Symbol definition for multiple independent instances", () => {
  const project = fresh();
  const screenId = project.screens[0].id;
  const first = applyCommand(
    project,
    { type: "add-symbol", screenId, template: "pump" },
    "edit",
  );
  const second = applyCommand(
    first,
    { type: "add-symbol", screenId, template: "pump" },
    "edit",
  );
  expect(second.symbols).toHaveLength(1);
  const instances = second.screens[0].objects.slice(-2);
  expect(instances[0].id).not.toBe(instances[1].id);
  expect(instances[0].shape).toEqual(instances[1].shape);
  const moved = applyCommand(
    second,
    {
      type: "update",
      screenId,
      objectId: instances[1].id,
      patch: { x: 350, width: 140 },
    },
    "edit",
  );
  expect(moved.screens[0].objects.at(-2)!.x).toBe(40);
  expect(moved.symbols).toEqual(second.symbols);
});
it("edits pipe geometry and rejects degenerate paths without mutating input", () => {
  const project = fresh();
  const screenId = project.screens[0].id;
  const added = applyCommand(
    project,
    { type: "add", screenId, kind: "pipe" },
    "edit",
  );
  const objectId = added.screens[0].objects.at(-1)!.id;
  const edited = applyCommand(
    added,
    {
      type: "update",
      screenId,
      objectId,
      patch: {
        points: [
          { x: -20, y: 0 },
          { x: 100, y: 0 },
        ],
        strokeWidth: 6,
        arrow: "end",
      },
    },
    "edit",
  );
  expect(edited.screens[0].objects.at(-1)!.shape).toMatchObject({
    strokeWidth: 6,
    arrow: "end",
  });
  expect(() =>
    applyCommand(
      added,
      {
        type: "update",
        screenId,
        objectId,
        patch: {
          points: [
            { x: 0, y: 0 },
            { x: 0, y: 0 },
          ],
        },
      },
      "edit",
    ),
  ).toThrow();
  expect(added.screens[0].objects.at(-1)!.shape).toMatchObject({
    strokeWidth: 8,
    arrow: "none",
  });
});
