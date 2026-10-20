import { expect, it } from "vitest";
import { render } from "svelte/server";
import cases from "../../../../examples/image-fit-cases.json";
import { createProject } from "./new-project";
import {
  parseProject,
  serializeProject,
  type ImageAsset,
  type LayoutObject,
} from "./project";
import { applyCommand, newId } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { projectContent } from "./save-state";
import { copyObjectSnapshot } from "./clipboard";
import { imageAspectRatio, parseImageFit } from "./image-fit";
import { imageFitCommand } from "./designer/forms/image-fit";
import ImagePainting from "./ImagePainting.svelte";
const asset: ImageAsset = {
  id: newId(),
  sha256: "3".repeat(64),
  mime: "image/png",
  byteLength: 100,
  width: 400,
  height: 200,
  name: "fit.png",
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
  it(`shares image fit contract with Rust: ${c.name}`, () => {
    const { project } = fixture();
    const shape: any = project.screens[0].objects[0].shape;
    if ("fit" in c) shape.fit = c.fit;
    else delete shape.fit;
    if (c.valid) {
      expect(parseProject(JSON.stringify(project))).toEqual(project);
      expect(parseImageFit(c.fit)).toBe(c.fit);
    } else {
      expect(() => parseProject(JSON.stringify(project))).toThrow();
      expect(() => parseImageFit(c.fit)).toThrow();
    }
  });
for (const fit of ["contain", "cover", "stretch"] as const)
  it(`preserves frame, crop, originals and history for ${fit}`, () => {
    let { project, screenId, objectId } = fixture();
    const object = project.screens[0].objects[0] as LayoutObject;
    object.rotation = 37;
    object.opacity = 0.4;
    if (object.shape.type !== "image") throw new Error("fixture");
    object.shape.crop = { x: 0.25, y: 0.1, width: 0.5, height: 0.8 };
    const before = structuredClone(project),
      command = { type: "set-image-fit" as const, screenId, objectId, fit };
    const edited = recordEdit(project, emptyHistory(), command, "edit");
    expect(edited.project.screens[0].objects[0]).toEqual({
      ...object,
      shape: { ...object.shape, fit },
    });
    expect(project).toEqual(before);
    expect(edited.project.assets).toEqual(project.assets);
    expect(parseProject(serializeProject(edited.project))).toEqual(
      edited.project,
    );
    expect(applyCommand(edited.project, command, "edit")).toBe(edited.project);
    expect(
      copyObjectSnapshot(edited.project, screenId, [objectId], "source").project
        .screens[0].objects[0].shape,
    ).toEqual({ ...object.shape, fit });
    if (fit !== "contain") {
      expect(edited.history.past).toHaveLength(1);
      const undo = travelHistory(
        edited.project,
        edited.history,
        "undo",
        "edit",
      );
      expect(projectContent(undo.project)).toEqual(projectContent(project));
      expect(
        projectContent(
          travelHistory(undo.project, undo.history, "redo", "edit").project,
        ),
      ).toEqual(projectContent(edited.project));
    }
    const same = applyCommand(
      edited.project,
      {
        type: "replace-image",
        screenId,
        objectId,
        asset: { ...asset, id: newId() },
      },
      "edit",
    );
    expect(same).toBe(edited.project);
    const replaced = applyCommand(
      edited.project,
      {
        type: "replace-image",
        screenId,
        objectId,
        asset: { ...asset, id: newId(), sha256: "4".repeat(64) },
      },
      "edit",
    );
    expect(replaced.screens[0].objects[0].shape).toMatchObject({ fit });
    expect(replaced.screens[0].objects[0].shape).not.toHaveProperty("crop");
    const reset = applyCommand(
      edited.project,
      { type: "reset-image-ratio", screenId, objectId },
      "edit",
    ).screens[0].objects[0] as LayoutObject;
    expect(reset.shape).toMatchObject({ fit, crop: object.shape.crop });
    expect(reset.width).toBe(object.width);
    expect(reset.height).toBe(160);
    expect(reset.y + reset.height / 2).toBe(object.y + object.height / 2);
  });
it("rejects invalid fit, nonimage, locked, definition and preview without changes", () => {
  const { project, screenId, objectId } = fixture();
  const before = serializeProject(project),
    command = {
      type: "set-image-fit" as const,
      screenId,
      objectId,
      fit: "cover" as const,
    };
  expect(() =>
    applyCommand(project, { ...command, fit: "original" as any }, "edit"),
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
  const input = {
    connected: true,
    objectId,
    targetKey: `3:${screenId}:false`,
    data: { get: () => "cover" },
  };
  const context = {
    generation: 3,
    screenId,
    definition: false,
    selected: project.screens[0].objects[0],
  };
  expect(imageFitCommand(input, context)).toEqual(command);
  for (const patch of [
    { connected: false },
    { objectId: "missing" },
    { targetKey: `2:${screenId}:false` },
  ])
    expect(() => imageFitCommand({ ...input, ...patch }, context)).toThrow();
  expect(() =>
    imageFitCommand(input, { ...context, definition: true }),
  ).toThrow();
});
it("maps placement modes to native SVG fitting with clipping around cover and crop", () => {
  for (const fit of ["contain", "cover", "stretch"] as const) {
    const html = render(ImagePainting, {
      props: {
        image: { url: "blob:test", width: 400, height: 200 },
        width: 100,
        height: 100,
        fit,
      },
    }).body;
    expect(html).toContain(`preserveAspectRatio="${imageAspectRatio(fit)}"`);
    if (fit === "cover") expect(html).toContain('overflow="hidden"');
    const cropped = render(ImagePainting, {
      props: {
        image: { url: "blob:test", width: 400, height: 200 },
        width: 100,
        height: 100,
        fit,
        crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
      },
    }).body;
    expect(cropped).toContain('viewBox="100 0 200 200"');
    expect(cropped).toContain('clipPathUnits="userSpaceOnUse"');
    expect(cropped).toContain('overflow="hidden"');
  }
});
