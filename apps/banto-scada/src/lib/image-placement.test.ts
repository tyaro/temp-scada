import { expect, it } from "vitest";
import { createProject } from "./new-project";
import { applyCommand, newId } from "./editor";
import {
  parseProject,
  referencedAssets,
  type ImageAsset,
  type LayoutObject,
} from "./project";
import { copyObjects, parseClipboard } from "./clipboard";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { initialImageFrame } from "./image-frame";
const asset: ImageAsset = {
  id: newId(),
  sha256: "0".repeat(64),
  mime: "image/png",
  byteLength: 100,
  width: 400,
  height: 200,
  name: "設備.png",
};
const frame = { x: 100, y: 120, width: 200, height: 150 };
function fixture() {
  const project = createProject(),
    screenId = project.screens[0].id;
  return {
    project: applyCommand(
      project,
      { type: "add-image", screenId, asset, frame },
      "edit",
    ),
    screenId,
  };
}
it("references one immutable original across a background, images and a duplicated screen; prunes only the last reference and restores history", () => {
  let { project, screenId } = fixture();
  const id = project.screens[0].objects[0].id;
  const alias = { ...asset, id: newId() };
  project = applyCommand(
    project,
    {
      type: "set-background-image",
      screenId,
      asset: alias,
      image: { assetId: alias.id, fit: "contain", opacity: 0.4 },
    },
    "edit",
  );
  project = applyCommand(
    project,
    { type: "duplicate", screenId, objectId: id },
    "edit",
  );
  project = applyCommand(
    project,
    { type: "duplicate-screen", screenId },
    "edit",
  );
  expect(project.assets).toEqual([asset]);
  expect(referencedAssets(project)).toEqual(new Set([asset.id]));
  project = applyCommand(
    project,
    { type: "remove-screen", screenId: project.screens[1].id },
    "edit",
  );
  project = applyCommand(
    project,
    { type: "set-background-image", screenId, image: null },
    "edit",
  );
  expect(project.assets).toEqual([asset]);
  const ids = project.screens[0].objects.map((o) => o.id);
  project = applyCommand(
    project,
    { type: "remove", screenId, objectId: ids[0] },
    "edit",
  );
  expect(project.assets).toEqual([asset]);
  const deleted = recordEdit(
    project,
    emptyHistory(),
    { type: "remove", screenId, objectId: ids[1] },
    "edit",
  );
  expect(deleted.project.assets).toEqual([]);
  const undo = travelHistory(deleted.project, deleted.history, "undo", "edit");
  expect(undo.project.assets).toEqual([asset]);
  expect(undo.project.screens[0].objects).toEqual(project.screens[0].objects);
});
it("resets ratio using width, preserving center, rotation, opacity and name; is a no-op at the source ratio", () => {
  let { project, screenId } = fixture();
  const id = project.screens[0].objects[0].id;
  project = applyCommand(
    project,
    {
      type: "update",
      screenId,
      objectId: id,
      patch: { rotation: 37, opacity: 0.4, name: "設備写真" },
    },
    "edit",
  );
  const changed = applyCommand(
    project,
    { type: "reset-image-ratio", screenId, objectId: id },
    "edit",
  );
  const object = changed.screens[0].objects[0] as LayoutObject;
  expect(object).toMatchObject({
    x: 100,
    y: 145,
    width: 200,
    height: 100,
    rotation: 37,
    opacity: 0.4,
    name: "設備写真",
  });
  expect(asset.name).toBe("設備.png");
  expect(
    applyCommand(
      changed,
      { type: "reset-image-ratio", screenId, objectId: id },
      "edit",
    ),
  ).toBe(changed);
});
it("rejects color, color alpha and mixed color edits atomically; rejects locked edits and preview", () => {
  let { project, screenId } = fixture();
  const id = project.screens[0].objects[0].id;
  project = applyCommand(
    project,
    { type: "add", screenId, kind: "rectangle" },
    "edit",
  );
  const before = JSON.stringify(project);
  for (const patch of [{ fill: "#ff0000" }, { colorAlpha: 0.5 }])
    expect(() =>
      applyCommand(
        project,
        { type: "update", screenId, objectId: id, patch },
        "edit",
      ),
    ).toThrow(/画像/);
  expect(() =>
    applyCommand(
      project,
      {
        type: "set-color",
        screenId,
        objectIds: project.screens[0].objects.map((o) => o.id),
        fill: "#ff0000",
      },
      "edit",
    ),
  ).toThrow(/画像/);
  expect(JSON.stringify(project)).toBe(before);
  const locked = applyCommand(
    project,
    { type: "set-lock", screenId, objectId: id, locked: true },
    "edit",
  );
  expect(() =>
    applyCommand(
      locked,
      { type: "reset-image-ratio", screenId, objectId: id },
      "edit",
    ),
  ).toThrow(/ロック/);
  expect(() =>
    applyCommand(
      project,
      { type: "add-image", screenId, asset, frame },
      "preview",
    ),
  ).toThrow(/プレビュー/);
});
it("rejects image clipboard including mixed cut payloads before deletion, and accepts ordinary objects in an image-bearing Project", () => {
  let { project, screenId } = fixture();
  const id = project.screens[0].objects[0].id;
  project = applyCommand(
    project,
    { type: "add", screenId, kind: "rectangle" },
    "edit",
  );
  expect(() => copyObjects(project, screenId, [id], "test")).toThrow(/画像/);
  expect(() =>
    copyObjects(
      project,
      screenId,
      project.screens[0].objects.map((o) => o.id),
      "test",
    ),
  ).toThrow(/画像/);
  const plain = copyObjects(
    project,
    screenId,
    [project.screens[0].objects[1].id],
    "test",
  );
  expect(parseClipboard(plain).project.assets).toEqual([]);
  expect(() =>
    parseClipboard(
      JSON.stringify({
        format: "banto-scada.objects",
        version: 1,
        origin: "test",
        project,
      }),
    ),
  ).toThrow(/画像/);
});
it("rejects Image in Symbol definitions and missing assets across the shared schema", () => {
  let { project, screenId } = fixture();
  project = applyCommand(
    project,
    { type: "create-symbol", name: "共有", width: 100, height: 80 },
    "edit",
  );
  const definitionId = project.symbols[0].id;
  expect(() =>
    applyCommand(
      project,
      { type: "add-image", screenId, definitionId, asset, frame },
      "edit",
    ),
  ).toThrow(/Symbol/);
  const invalid = structuredClone(project);
  invalid.symbols[0].objects.push({
    ...invalid.screens[0].objects[0],
    id: newId(),
    order: 1,
  });
  expect(() => parseProject(JSON.stringify(invalid))).toThrow();
  const missing = structuredClone(project);
  missing.assets = [];
  expect(() => parseProject(JSON.stringify(missing))).toThrow(/資産/);
  const alpha = structuredClone(project);
  alpha.screens[0].objects[0].colorAlpha = 0.5;
  expect(() => parseProject(JSON.stringify(alpha))).toThrow();
});
it("initial placement shrinks to the visible intersection, never upscales and falls back to screen center", () => {
  expect(
    initialImageFrame(
      { width: 400, height: 200 },
      { width: 960, height: 540 },
      { x: 200, y: 100, width: 200, height: 200 },
    ),
  ).toEqual({ x: 220, y: 160, width: 160, height: 80 });
  expect(
    initialImageFrame(
      { width: 40, height: 20 },
      { width: 960, height: 540 },
      { x: -100, y: -100, width: 300, height: 300 },
    ),
  ).toEqual({ x: 80, y: 90, width: 40, height: 20 });
  expect(
    initialImageFrame(
      { width: 40, height: 20 },
      { width: 960, height: 540 },
      { x: 2000, y: 2000, width: 100, height: 100 },
    ),
  ).toEqual({ x: 460, y: 260, width: 40, height: 20 });
});
