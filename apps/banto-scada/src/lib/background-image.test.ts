import { expect, it } from "vitest";
import sample from "../../../../examples/minimal.project.json";
import cases from "../../../../examples/image-asset-cases.json";
import { parseProject, type ImageAsset } from "./project";
import { applyCommand } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
const asset: ImageAsset = {
  id: "0199fc00-0000-7000-8000-000000001100",
  sha256: "0".repeat(64),
  mime: "image/png",
  byteLength: 100,
  width: 100,
  height: 60,
  name: "設備背景.png",
};
const image = { assetId: asset.id, fit: "contain" as const, opacity: 1 };
for (const entry of cases)
  it(entry.name, () => {
    const project: any = structuredClone(sample);
    project.assets = [structuredClone(asset)];
    project.screens[0].backgroundImage = { ...image };
    if ("assetPatch" in entry)
      Object.assign(project.assets[0], entry.assetPatch);
    if ("imagePatch" in entry)
      Object.assign(project.screens[0].backgroundImage, entry.imagePatch);
    if ("removeAssets" in entry) project.assets = [];
    if ("omitImage" in entry) delete project.screens[0].backgroundImage;
    if ("duplicateHash" in entry)
      project.assets.push({
        ...asset,
        id: "0199fc00-0000-7000-8000-000000001101",
      });
    if ("projectId" in entry) {
      project.assets[0].id = project.manifest.projectId;
      project.screens[0].backgroundImage.assetId = project.manifest.projectId;
    }
    if ("oldVersion" in entry)
      project.manifest.schemaVersion = project.manifest.minRuntimeVersion =
        "0.15.0";
    if (entry.valid)
      expect(parseProject(JSON.stringify(project))).toEqual(project);
    else expect(() => parseProject(JSON.stringify(project))).toThrow();
  });
it("registers and references atomically, reuses the hash, prunes the last declaration and restores Undo", () => {
  const project = parseProject(JSON.stringify(sample)),
    screenId = project.screens[0].id,
    command = { type: "set-background-image" as const, screenId, asset, image };
  const changed = recordEdit(project, emptyHistory(), command, "edit");
  expect(changed.project.assets).toEqual([asset]);
  expect(changed.project.screens[0].objects).toEqual(
    project.screens[0].objects,
  );
  expect(applyCommand(changed.project, command, "edit")).toBe(changed.project);
  const duplicate = applyCommand(
      changed.project,
      { type: "duplicate-screen", screenId },
      "edit",
    ),
    copy = duplicate.screens[1];
  expect(copy.backgroundImage).toEqual(image);
  expect(duplicate.assets).toEqual([asset]);
  const reused = applyCommand(
    duplicate,
    {
      ...command,
      screenId: copy.id,
      asset: { ...asset, id: "0199fc00-0000-7000-8000-000000001102" },
      image: { ...image, assetId: "0199fc00-0000-7000-8000-000000001102" },
    },
    "edit",
  );
  expect(reused).toBe(duplicate);
  const removed = recordEdit(
    changed.project,
    changed.history,
    { type: "set-background-image", screenId, image: null },
    "edit",
  );
  expect(removed.project.assets).toEqual([]);
  expect(removed.project.screens[0].background).toBe(
    project.screens[0].background,
  );
  const undo = travelHistory(removed.project, removed.history, "undo", "edit");
  expect(undo.project.assets).toEqual([asset]);
  expect(undo.project.screens[0].backgroundImage).toEqual(image);
  expect(
    travelHistory(undo.project, undo.history, "redo", "edit").project.assets,
  ).toEqual([]);
  expect(() => applyCommand(project, command, "preview")).toThrow();
  expect(() =>
    applyCommand(
      project,
      { ...command, image: { ...image, opacity: 2 } },
      "edit",
    ),
  ).toThrow();
  expect(project.assets).toEqual([]);
});
