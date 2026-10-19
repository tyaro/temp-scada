import { projectContent } from "./save-state";
import { expect, it } from "vitest";
import cases from "../../../../examples/image-crop-cases.json";
import { createProject } from "./new-project";
import { applyCommand, newId } from "./editor";
import {
  parseProject,
  serializeProject,
  type ImageAsset,
  type LayoutObject,
} from "./project";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { copyObjectSnapshot } from "./clipboard";
const asset: ImageAsset = {
  id: newId(),
  sha256: "1".repeat(64),
  mime: "image/png",
  byteLength: 100,
  width: 400,
  height: 200,
  name: "原本.png",
};
function fixture() {
  let project = createProject();
  const screenId = project.screens[0].id;
  project = applyCommand(
    project,
    {
      type: "add-image",
      screenId,
      asset,
      frame: { x: 100, y: 120, width: 200, height: 150 },
    },
    "edit",
  );
  return { project, screenId, objectId: project.screens[0].objects[0].id };
}
for (const c of cases)
  it(`shares crop contract with Rust: ${c.name}`, () => {
    const { project } = fixture();
    if ("crop" in c) (project.screens[0].objects[0].shape as any).crop = c.crop;
    const parse = () => parseProject(JSON.stringify(project));
    if (c.valid) expect(parse()).toEqual(project);
    else expect(parse).toThrow();
  });
const crop = { x: 0.25, y: 0.1, width: 0.5, height: 0.4 };
it("crops only the target, preserves its frame and shared background, roundtrips and restores once", () => {
  let { project, screenId, objectId } = fixture();
  project = applyCommand(
    project,
    { type: "duplicate", screenId, objectId },
    "edit",
  );
  project = applyCommand(
    project,
    {
      type: "set-background-image",
      screenId,
      image: { assetId: asset.id, fit: "contain", opacity: 1 },
    },
    "edit",
  );
  const edited = recordEdit(
    project,
    emptyHistory(),
    { type: "set-image-crop", screenId, objectId, crop },
    "edit",
  );
  const target = structuredClone(edited.project.screens[0].objects[0]);
  expect(target.shape).toMatchObject({ crop });
  delete (target.shape as any).crop;
  expect(target).toEqual(project.screens[0].objects[0]);
  expect(edited.project.screens[0].objects[1]).toEqual(
    project.screens[0].objects[1],
  );
  expect(edited.project.screens[0].backgroundImage).toEqual(
    project.screens[0].backgroundImage,
  );
  expect(edited.project.assets).toEqual([asset]);
  expect(edited.history.past).toHaveLength(1);
  expect(
    projectContent(
      travelHistory(edited.project, edited.history, "undo", "edit").project,
    ),
  ).toEqual(projectContent(project));
  expect(parseProject(serializeProject(edited.project))).toEqual(
    edited.project,
  );
  expect(
    applyCommand(
      edited.project,
      { type: "set-image-crop", screenId, objectId, crop: { ...crop } },
      "edit",
    ),
  ).toBe(edited.project);
  const duplicated = applyCommand(
    edited.project,
    { type: "duplicate", screenId, objectId },
    "edit",
  );
  expect(duplicated.screens[0].objects.at(-1)!.shape).toEqual(
    edited.project.screens[0].objects[0].shape,
  );
  const snapshot = copyObjectSnapshot(
    edited.project,
    screenId,
    [objectId],
    "source",
  );
  expect(snapshot.project.screens[0].objects[0].shape).toEqual(
    edited.project.screens[0].objects[0].shape,
  );
});
it("normalizes full range, uses the crop ratio with fixed center, and replacement resets only for different bytes", () => {
  let { project, screenId, objectId } = fixture();
  const command = { type: "set-image-crop" as const, screenId, objectId, crop };
  const original = project;
  expect(
    applyCommand(
      project,
      { ...command, crop: { x: 0, y: 0, width: 1, height: 1 } },
      "edit",
    ),
  ).toBe(project);
  project = applyCommand(project, command, "edit");
  const ratio = applyCommand(
    project,
    { type: "reset-image-ratio", screenId, objectId },
    "edit",
  ).screens[0].objects[0] as LayoutObject;
  expect(ratio.width).toBe(200);
  expect(ratio.height).toBe(80);
  expect(ratio.y + ratio.height / 2).toBe(195);
  expect(
    applyCommand(
      project,
      {
        type: "replace-image",
        screenId,
        objectId,
        asset: { ...asset, id: newId(), name: "別名.png" },
      },
      "edit",
    ),
  ).toBe(project);
  const changed = recordEdit(
    project,
    emptyHistory(),
    {
      type: "replace-image",
      screenId,
      objectId,
      asset: { ...asset, id: newId(), sha256: "2".repeat(64) },
    },
    "edit",
  );
  expect(changed.project.screens[0].objects[0].shape).not.toHaveProperty(
    "crop",
  );
  expect(
    projectContent(
      travelHistory(changed.project, changed.history, "undo", "edit").project,
    ),
  ).toEqual(projectContent(project));
  expect(
    applyCommand(project, { ...command, crop: null }, "edit").screens[0]
      .objects,
  ).toEqual(original.screens[0].objects);
});
it("rejects invalid crop, preview, locked and nonimage atomically", () => {
  const { project, screenId, objectId } = fixture();
  const before = serializeProject(project),
    command = { type: "set-image-crop" as const, screenId, objectId, crop };
  for (const width of [NaN, Infinity, 0, -1, 1.1, 0.001])
    expect(() =>
      applyCommand(project, { ...command, crop: { ...crop, width } }, "edit"),
    ).toThrow();
  expect(() => applyCommand(project, command, "preview")).toThrow();
  const locked = applyCommand(
    project,
    { type: "set-lock", screenId, objectId, locked: true },
    "edit",
  );
  expect(() => applyCommand(locked, command, "edit")).toThrow();
  const rectangle = applyCommand(
    project,
    { type: "add", screenId, kind: "rectangle" },
    "edit",
  );
  expect(() =>
    applyCommand(
      rectangle,
      { ...command, objectId: rectangle.screens[0].objects.at(-1)!.id },
      "edit",
    ),
  ).toThrow();
  expect(serializeProject(project)).toBe(before);
});
