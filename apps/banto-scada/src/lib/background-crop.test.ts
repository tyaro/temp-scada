import { expect, it } from "vitest";
import cases from "../../../../examples/image-crop-cases.json";
import { createProject } from "./new-project";
import { parseProject, serializeProject, type ImageAsset } from "./project";
import { applyCommand, newId } from "./editor";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { projectContent } from "./save-state";
import { backgroundCropCommand } from "./designer/forms/background-crop";
const asset: ImageAsset = {
  id: newId(),
  sha256: "8".repeat(64),
  mime: "image/png",
  byteLength: 100,
  width: 400,
  height: 200,
  name: "background.png",
};
function fixture() {
  let project = createProject();
  const screenId = project.screens[0].id;
  project = applyCommand(
    project,
    {
      type: "set-background-image",
      screenId,
      asset,
      image: { assetId: asset.id, fit: "original", opacity: 0.4 },
    },
    "edit",
  );
  return { project, screenId };
}
for (const c of cases)
  it(`shares background crop contract with Rust: ${c.name}`, () => {
    const { project } = fixture();
    if ("crop" in c) (project.screens[0].backgroundImage as any).crop = c.crop;
    if (c.valid) expect(parseProject(JSON.stringify(project))).toEqual(project);
    else expect(() => parseProject(JSON.stringify(project))).toThrow();
  });
it("updates background crop without changing screen, objects, originals or fitting and restores through history", () => {
  const { project, screenId } = fixture(),
    before = structuredClone(project),
    image = project.screens[0].backgroundImage!;
  const data = new Map([
    ["cropX", "25"],
    ["cropY", "10"],
    ["cropWidth", "50"],
    ["cropHeight", "80"],
  ]);
  const input = {
    data: { get: (name: string) => data.get(name) ?? null },
    connected: true,
    targetKey: `2:${screenId}`,
    assetId: asset.id,
  };
  const context = { generation: 2, screenId, definition: false, image, asset };
  const command = backgroundCropCommand(input, context),
    edited = recordEdit(project, emptyHistory(), command, "edit");
  expect(edited.project.screens[0]).toEqual({
    ...project.screens[0],
    backgroundImage: {
      ...image,
      crop: { x: 0.25, y: 0.1, width: 0.5, height: 0.8 },
    },
  });
  expect(project).toEqual(before);
  expect(edited.project.assets).toEqual([asset]);
  expect(edited.history.past).toHaveLength(1);
  expect(applyCommand(edited.project, command, "edit")).toBe(edited.project);
  expect(parseProject(serializeProject(edited.project))).toEqual(
    edited.project,
  );
  expect(
    projectContent(
      travelHistory(edited.project, edited.history, "undo", "edit").project,
    ),
  ).toEqual(projectContent(project));
  const duplicated = applyCommand(
    edited.project,
    { type: "duplicate-screen", screenId },
    "edit",
  );
  expect(duplicated.screens[1].backgroundImage).toEqual(
    edited.project.screens[0].backgroundImage,
  );
  data.set("cropX", "0");
  data.set("cropY", "0");
  data.set("cropWidth", "100");
  data.set("cropHeight", "100");
  const cleared = backgroundCropCommand(input, {
    ...context,
    image: edited.project.screens[0].backgroundImage,
  });
  expect(
    applyCommand(edited.project, cleared, "edit").screens[0].backgroundImage,
  ).toEqual(image);
  for (const patch of [
    { connected: false },
    { targetKey: `1:${screenId}` },
    { assetId: "missing" },
  ])
    expect(() =>
      backgroundCropCommand({ ...input, ...patch }, context),
    ).toThrow();
  expect(() =>
    backgroundCropCommand(input, { ...context, image: undefined }),
  ).toThrow();
  expect(() =>
    backgroundCropCommand(input, { ...context, definition: true }),
  ).toThrow();
});

it("copies proxy-backed background configuration at the command boundary", () => {
  const { project, screenId } = fixture();
  const crop = new Proxy({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, {});
  const image = new Proxy(
    { ...project.screens[0].backgroundImage!, fit: "cover" as const, crop },
    {},
  );
  const changed = applyCommand(
    project,
    { type: "set-background-image", screenId, image },
    "edit",
  );
  expect(changed.screens[0].backgroundImage).toEqual({
    ...image,
    crop: { ...crop },
  });
  expect(changed.screens[0].backgroundImage?.crop).not.toBe(crop);
  expect(image.crop).toBe(crop);
});
