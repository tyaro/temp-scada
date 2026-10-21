import { expect, it, vi, afterEach } from "vitest";
import sample from "../../../../examples/symbol-image.project.json";
import { parseProject, serializeProject, referencedAssets } from "./project";
import { applyCommand, newId } from "./editor";
import { copyObjectSnapshot, parseClipboard } from "./clipboard";
import { emptyHistory, recordEdit, travelHistory } from "./history";
import { writeProjectPackage, readProjectFile } from "./project-package";
import { AssetStore } from "./image-assets";
const originalBytes = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP4z8Dwn+H//wYAEncEfZqhLCEAAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);
const fresh = () => parseProject(JSON.stringify(sample));
function fragment(project = fresh()) {
  const snapshot = copyObjectSnapshot(
    project,
    project.screens[0].id,
    [project.screens[0].objects[0].id],
    "origin",
  );
  // Domain tests exercise reference remapping. Native bytes are separately verified by package/browser tests.
  return JSON.stringify({
    ...snapshot,
    version: 2,
    images: project.assets.map((asset) => ({
      sha256: asset.sha256,
      data: btoa("x".repeat(asset.byteLength)),
    })),
  });
}
function paste(
  project: ReturnType<typeof fresh>,
  text: string,
  origin = "different",
) {
  return applyCommand(
    project,
    {
      type: "paste",
      screenId: project.screens[0].id,
      text,
      origin,
      center: { x: 400, y: 250 },
    },
    "edit",
  );
}
it("retains an unplaced, hidden Symbol's original through save, definition copy, deletion and Undo", () => {
  const project = fresh();
  project.screens[0].objects = [];
  project.symbols[0].objects[1].visible = false;
  expect(parseProject(serializeProject(project))).toEqual(project);
  expect(referencedAssets(project)).toEqual(new Set([project.assets[0].id]));
  const duplicated = applyCommand(
    project,
    { type: "duplicate-symbol", symbolId: project.symbols[0].id },
    "edit",
  );
  expect(duplicated.assets).toHaveLength(1);
  const first = applyCommand(
    duplicated,
    { type: "remove-symbol", symbolId: duplicated.symbols[0].id },
    "edit",
  );
  expect(first.assets).toHaveLength(1);
  const removed = recordEdit(
    first,
    emptyHistory(),
    { type: "remove-symbol", symbolId: first.symbols[0].id },
    "edit",
  );
  expect(removed.project.assets).toHaveLength(0);
  const restored = travelHistory(
    removed.project,
    removed.history,
    "undo",
    "edit",
  );
  expect(restored.project.assets).toEqual(project.assets);
});
it("copies only the used definition and remaps child image IDs when importing, sharing an existing hash", () => {
  const source = fresh(),
    target = fresh();
  target.manifest.projectId = newId();
  const oldAssetId = target.assets[0].id;
  target.assets[0].id = newId();
  const image = target.symbols[0].objects[1];
  if (image.shape.type !== "image") throw Error();
  image.shape.assetId = target.assets[0].id;
  const text = fragment(source);
  expect(parseClipboard(text).project.assets).toHaveLength(1);
  const next = paste(target, text);
  expect(next.symbols).toHaveLength(2);
  expect(next.assets).toHaveLength(1);
  const imported = next.symbols[1].objects[1];
  if (imported.shape.type !== "image") throw Error();
  expect(imported.shape.assetId).toBe(target.assets[0].id);
  expect(imported.shape.assetId).not.toBe(oldAssetId);
  expect(serializeProject(source)).toBe(serializeProject(fresh()));
});
it("reuses a live definition without resurrecting its stale clipboard image or unrelated definitions", () => {
  const source = fresh(),
    text = fragment(source);
  const live = fresh();
  // Remove image from the live definition and its now-unused declaration.
  live.symbols[0].objects.splice(1, 1);
  live.assets = [];
  const next = paste(live, text, "origin");
  expect(next.symbols).toEqual(live.symbols);
  expect(next.assets).toEqual([]);
  expect(next.screens[0].objects).toHaveLength(2);
});
it("rejects missing originals, invalid Symbol image crop and forbidden nested Symbols atomically", () => {
  const project = fresh();
  for (const mutate of [
    (p: ReturnType<typeof fresh>) => (p.assets = []),
    (p: ReturnType<typeof fresh>) => {
      const o = p.symbols[0].objects[1];
      if (o.shape.type === "image")
        o.shape.crop = { x: 1, y: 0, width: 1, height: 1 };
    },
    (p: ReturnType<typeof fresh>) => {
      p.symbols[0].objects.push({
        ...p.screens[0].objects[0],
        id: newId(),
        order: 3,
      });
    },
  ]) {
    const invalid = fresh();
    mutate(invalid);
    expect(() => parseProject(JSON.stringify(invalid))).toThrow();
  }
  const payload = JSON.parse(fragment());
  payload.project.assets = [];
  payload.images = [];
  const before = serializeProject(project);
  expect(() => paste(project, JSON.stringify(payload))).toThrow();
  expect(serializeProject(project)).toBe(before);
});
afterEach(() => vi.unstubAllGlobals());
it("round-trips an unplaced image definition and exact original bytes in the existing package profile", async () => {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 2, height: 1, close() {} })),
  );
  const project = fresh();
  project.screens[0].objects = [];
  const bytes = originalBytes;
  const store = new AssetStore();
  try {
    await store.put(new Blob([bytes]), "symbol-image.png", project.assets[0]);
    const result = await readProjectFile(
      await writeProjectPackage(project, store),
    );
    try {
      expect(result.project).toEqual(project);
      expect(
        new Uint8Array(
          await result.store.blob(project.assets[0].sha256).arrayBuffer(),
        ),
      ).toEqual(new Uint8Array(bytes));
    } finally {
      result.store.dispose();
    }
  } finally {
    store.dispose();
  }
});

it.each(["contain", "cover", "stretch"] as const)(
  "validates and preserves %s plus crop inside a definition",
  (fit) => {
    const project = fresh(),
      object = project.symbols[0].objects[1];
    if (object.shape.type !== "image") throw Error();
    object.shape.fit = fit;
    object.shape.crop = { x: 0.5, y: 0, width: 0.5, height: 1 };
    const restored = parseProject(serializeProject(project));
    expect(restored.symbols[0].objects[1]).toEqual(object);
  },
);

it("reuses the live definition's replacement image rather than registering stale snapshot assets", () => {
  const source = fresh(),
    text = fragment(source),
    live = fresh();
  live.assets[0] = {
    ...live.assets[0],
    id: newId(),
    sha256: "f".repeat(64),
    name: "現行原本.png",
  };
  const image = live.symbols[0].objects[1];
  if (image.shape.type !== "image") throw Error();
  image.shape.assetId = live.assets[0].id;
  const next = paste(live, text, "origin");
  expect(next.assets).toEqual(live.assets);
  expect(next.symbols).toEqual(live.symbols);
});
