import { expect, it } from "vitest";
import sample from "../../../../examples/symbol-image.project.json";
import { parseProject, serializeProject } from "./project";
import { applyCommand, newId } from "./editor";
import { projectContent } from "./save-state";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { copyObjectSnapshot } from "./clipboard";
import { imageFitCommand } from "./designer/forms/image-fit";
import { imageCropCommand } from "./designer/forms/image-crop";

const fresh = () => parseProject(JSON.stringify(sample));
it("edits a shared image with fit/crop, preserves its frame, and restores the original through replacement Undo", () => {
  const initial = fresh();
  let project = initial;
  const definitionId = project.symbols[0].id,
    screenId = definitionId;
  const object = project.symbols[0].objects[1];
  const objectId = object.id,
    before = serializeProject(project);
  project = applyCommand(
    project,
    { type: "set-image-fit", screenId, definitionId, objectId, fit: "cover" },
    "edit",
  );
  project = applyCommand(
    project,
    {
      type: "set-image-crop",
      screenId,
      definitionId,
      objectId,
      crop: { x: 0.5, y: 0, width: 0.5, height: 1 },
    },
    "edit",
  );
  expect(project.symbols[0].objects[1]).toEqual({
    ...object,
    shape: {
      ...object.shape,
      fit: "cover",
      crop: { x: 0.5, y: 0, width: 0.5, height: 1 },
    },
  });
  const previous = project;
  const replacement = {
    ...project.assets[0],
    id: newId(),
    sha256: "b".repeat(64),
  };
  const result = recordEdit(
    project,
    emptyHistory(),
    {
      type: "replace-image",
      screenId,
      definitionId,
      objectId,
      asset: replacement,
    },
    "edit",
  );
  expect(result.project.assets).toEqual([replacement]);
  expect(result.project.symbols[0].objects[1].shape).toEqual({
    type: "image",
    assetId: replacement.id,
    fit: "cover",
  });
  expect(
    projectContent(
      travelHistory(result.project, result.history, "undo", "edit").project,
    ),
  ).toBe(projectContent(previous));
  expect(serializeProject(initial)).toBe(before);
});
it("rejects invalid, locked, missing-owner and preview image mutations atomically", () => {
  const project = fresh(),
    definitionId = project.symbols[0].id;
  const command = {
    type: "set-image-crop" as const,
    screenId: definitionId,
    definitionId,
    objectId: project.symbols[0].objects[1].id,
    crop: { x: 0, y: 0, width: 0, height: 1 },
  };
  const before = serializeProject(project);
  expect(() => applyCommand(project, command, "edit")).toThrow();
  expect(() =>
    applyCommand(project, { ...command, definitionId: newId() }, "edit"),
  ).toThrow();
  expect(() =>
    applyCommand(project, { ...command, crop: null }, "preview"),
  ).toThrow();
  const locked = applyCommand(
    project,
    {
      type: "set-lock",
      screenId: definitionId,
      definitionId,
      objectId: command.objectId,
      locked: true,
    },
    "edit",
  );
  expect(() =>
    applyCommand(locked, { ...command, crop: null }, "edit"),
  ).toThrow(/ロック/);
  expect(serializeProject(project)).toBe(before);
});
it("copies a child image from a definition into another definition with hash reuse and fresh placement identity", () => {
  const source = fresh(),
    target = fresh();
  const snapshot = copyObjectSnapshot(
    source,
    source.symbols[0].id,
    [source.symbols[0].objects[1].id],
    "origin",
  );
  const text = JSON.stringify({
    ...snapshot,
    version: 2,
    images: source.assets.map((a) => ({
      sha256: a.sha256,
      data: btoa("x".repeat(a.byteLength)),
    })),
  });
  const command = {
    type: "paste" as const,
    screenId: target.symbols[0].id,
    definitionId: target.symbols[0].id,
    text,
    origin: "other",
    center: { x: 80, y: 40 },
  };
  const result = recordEdit(target, emptyHistory(), command, "edit");
  const pasted = result.project.symbols[0].objects.at(-1)!;
  expect(pasted.id).not.toBe(source.symbols[0].objects[1].id);
  expect(pasted.shape).toEqual(source.symbols[0].objects[1].shape);
  expect(result.project.assets).toHaveLength(1);
  expect(result.project.symbols).toHaveLength(1);
  expect(
    projectContent(
      travelHistory(result.project, result.history, "undo", "edit").project,
    ),
  ).toBe(projectContent(target));
});
it("accepts definition image forms but rejects stale owner and asset identities", () => {
  const project = fresh(),
    definitionId = project.symbols[0].id,
    selected = project.symbols[0].objects[1];
  const context = {
    generation: 4,
    screenId: definitionId,
    definition: true,
    selected,
    assets: project.assets,
  };
  const targetKey = `4:${definitionId}:true`;
  const fit = {
    connected: true,
    objectId: selected.id,
    targetKey,
    data: { get: () => "stretch" },
  };
  expect(imageFitCommand(fit, context).type).toBe("set-image-fit");
  expect(() =>
    imageFitCommand({ ...fit, targetKey: `4:${newId()}:true` }, context),
  ).toThrow();
  const input = {
    objectId: selected.id,
    targetKey,
    assetId: project.assets[0].id,
    data: {
      get: (key: string) =>
        key === "cropX" || key === "cropY"
          ? "0"
          : key === "cropHeight"
            ? "100"
            : "50",
    },
  };
  expect(imageCropCommand(input, context)).toMatchObject({
    type: "set-image-crop",
    crop: { width: 0.5, height: 1 },
  });
  expect(() =>
    imageCropCommand({ ...input, assetId: newId() }, context),
  ).toThrow();
});
