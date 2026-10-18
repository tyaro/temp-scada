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
