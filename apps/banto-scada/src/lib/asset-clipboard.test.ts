import { expect, it, vi, beforeEach, afterEach } from "vitest";
import { AssetStore } from "./image-assets";
import { createProject } from "./new-project";
import { applyCommand, newId } from "./editor";
import {
  copyObjectSnapshot,
  parseClipboard,
  CLIPBOARD_LIMIT,
  IMAGE_CLIPBOARD_LIMIT,
} from "./clipboard";
import {
  encodeAssetClipboard,
  decodeAssetClipboard,
  validateAssetClipboardSnapshot,
} from "./asset-clipboard";
import type { FillPaint } from "./project";
import { emptyHistory, recordEdit, travelHistory } from "./history";
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVhEAAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);
beforeEach(() =>
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 1, height: 1, close() {} })),
  ),
);
afterEach(() => vi.unstubAllGlobals());
async function fixture(paint?: FillPaint) {
  const store = new AssetStore(),
    metadata = await store.put(new Blob([png]), "原本.png"),
    asset = { ...metadata, id: newId() };
  let project = createProject();
  const screenId = project.screens[0].id;
  project = applyCommand(
    project,
    {
      type: "add-image",
      screenId,
      asset,
      frame: { x: 100, y: 100, width: 80, height: 40 },
    },
    "edit",
  );
  project = applyCommand(
    project,
    { type: "duplicate", screenId, objectId: project.screens[0].objects[0].id },
    "edit",
  );
  project = applyCommand(
    project,
    { type: "add", screenId, kind: "rectangle" },
    "edit",
  );
  const shape = project.screens[0].objects.at(-1)!.shape;
  if (shape.type !== "rectangle") throw new Error("fixture");
  shape.paint.fill.paint = paint ?? {
    type: "linearGradient",
    angle: 45,
    start: { color: "#ff8800", alpha: 0.25 },
    end: { color: "#2266cc", alpha: 0.8 },
  };
  return {
    project,
    store,
    asset,
    screenId,
    snapshot: copyObjectSnapshot(
      project,
      screenId,
      project.screens[0].objects.map((o) => o.id),
      "origin",
    ),
  };
}
it("encodes each original once and verifies exact bytes into a fresh Store, then pastes mixed images and gradient paint with one Undo", async () => {
  const { snapshot, store, project } = await fixture();
  const text = await (await encodeAssetClipboard(snapshot, store)).text(),
    fragment = parseClipboard(text),
    candidate = await decodeAssetClipboard(fragment);
  expect(fragment.version).toBe(2);
  expect(fragment.images).toHaveLength(1);
  expect(fragment.project.screens[0].objects).toHaveLength(3);
  expect(
    new Uint8Array(
      await candidate.blob(fragment.project.assets[0].sha256).arrayBuffer(),
    ),
  ).toEqual(png);
  const target = createProject(),
    screenId = target.screens[0].id,
    result = recordEdit(
      target,
      emptyHistory(),
      {
        type: "paste",
        screenId,
        text,
        origin: "different",
        center: { x: 500, y: 300 },
      },
      "edit",
    );
  expect(result.project.assets).toHaveLength(1);
  expect(result.project.assets[0].id).not.toBe(project.assets[0].id);
  const refs = result.project.screens[0].objects
    .slice(0, 2)
    .map((o) => (o.shape as any).assetId);
  expect(new Set(refs)).toEqual(new Set([result.project.assets[0].id]));
  expect(result.project.screens[0].objects.at(-1)!.shape).toEqual(
    project.screens[0].objects.at(-1)!.shape,
  );
  expect(result.history.past).toHaveLength(1);
  expect(
    travelHistory(result.project, result.history, "undo", "edit").project
      .screens[0].objects,
  ).toHaveLength(0);
  const repeated = applyCommand(
    result.project,
    {
      type: "paste",
      screenId,
      text,
      origin: "different",
      center: { x: 500, y: 300 },
      offset: 20,
    },
    "edit",
  );
  expect(repeated.assets).toHaveLength(1);
  expect(repeated.screens[0].objects).toHaveLength(6);
  candidate.dispose();
  store.dispose();
});
it("copies only selected image dependencies, excludes background and unused Symbols, and does not mutate the source", async () => {
  const { project, screenId, store, asset } = await fixture();
  let p = applyCommand(
    project,
    {
      type: "set-background-image",
      screenId,
      image: { assetId: asset.id, fit: "contain", opacity: 1 },
    },
    "edit",
  );
  p = applyCommand(
    p,
    { type: "create-symbol", name: "未使用", width: 40, height: 40 },
    "edit",
  );
  const before = JSON.stringify(p),
    snapshot = copyObjectSnapshot(
      p,
      screenId,
      [p.screens[0].objects[2].id],
      "origin",
    );
  expect(snapshot.project.assets).toEqual([]);
  expect(snapshot.project.symbols).toEqual([]);
  expect(snapshot.project.screens[0].backgroundImage).toBeUndefined();
  expect(JSON.stringify(p)).toBe(before);
  store.dispose();
});
it("rejects missing, duplicate, excess, malformed and noncanonical originals and verifies SHA-256 and dimensions", async () => {
  const { snapshot, store } = await fixture(),
    text = await (await encodeAssetClipboard(snapshot, store)).text();
  for (const modify of [
    (p: any) => p.images.pop(),
    (p: any) => p.images.push(p.images[0]),
    (p: any) => (p.images[0].data = "?".repeat(p.images[0].data.length)),
    (p: any) => (p.images[0].extra = true),
    (p: any) => (p.images[0].sha256 = "0".repeat(64)),
  ]) {
    const value = JSON.parse(text);
    modify(value);
    expect(() => parseClipboard(JSON.stringify(value))).toThrow();
  }
  const forged = JSON.parse(text);
  forged.project.assets[0].sha256 = forged.images[0].sha256 = "0".repeat(64);
  await expect(
    decodeAssetClipboard(parseClipboard(JSON.stringify(forged))),
  ).rejects.toThrow(/宣言/);
  const dimensions = JSON.parse(text);
  dimensions.project.assets[0].width = 2;
  await expect(
    decodeAssetClipboard(parseClipboard(JSON.stringify(dimensions))),
  ).rejects.toThrow(/宣言/);
  store.dispose();
});
it("rejects an image-containing paste into a Symbol atomically, preserving the Project and history", async () => {
  const { snapshot, store } = await fixture(),
    text = await (await encodeAssetClipboard(snapshot, store)).text();
  let target = createProject();
  target = applyCommand(
    target,
    { type: "create-symbol", name: "共有", width: 40, height: 40 },
    "edit",
  );
  const before = JSON.stringify(target);
  expect(() =>
    applyCommand(
      target,
      {
        type: "paste",
        screenId: target.screens[0].id,
        definitionId: target.symbols[0].id,
        text,
        origin: "other",
        center: { x: 20, y: 20 },
      },
      "edit",
    ),
  ).toThrow(/画像/);
  expect(JSON.stringify(target)).toBe(before);
  store.dispose();
});
it("retains originals during asynchronous copy even if the source Store is disposed", async () => {
  const { snapshot, store } = await fixture();
  const pending = encodeAssetClipboard(snapshot, store);
  store.dispose();
  const fragment = parseClipboard(await (await pending).text());
  expect(fragment.images).toHaveLength(1);
  expect(store.count).toBe(0);
});
it("keeps separate caps for v1 text, v2 encoded data, and raw original totals", async () => {
  const { snapshot, store } = await fixture();
  expect(() => parseClipboard("x".repeat(IMAGE_CLIPBOARD_LIMIT + 1))).toThrow(
    /32MiB/,
  );
  const oversized = structuredClone(snapshot);
  oversized.project.assets[0].byteLength = 16 * 1024 * 1024 + 1;
  expect(() => validateAssetClipboardSnapshot(oversized)).toThrow(/16MiB/);
  const v1 = JSON.stringify({
    format: "banto-scada.objects",
    version: 1,
    origin: "test",
    project: createProject(),
    padding: "x".repeat(CLIPBOARD_LIMIT),
  });
  expect(() => parseClipboard(v1)).toThrow();
  store.dispose();
});

it("remaps incoming asset IDs that collide with destination object IDs", async () => {
  const { snapshot, store } = await fixture();
  const text = await (await encodeAssetClipboard(snapshot, store)).text();
  let target = createProject();
  target = applyCommand(
    target,
    { type: "add", screenId: target.screens[0].id, kind: "rectangle" },
    "edit",
  );
  target.screens[0].objects[0].id = snapshot.project.assets[0].id;
  const result = applyCommand(
    target,
    {
      type: "paste",
      screenId: target.screens[0].id,
      text,
      origin: "different",
      center: { x: 500, y: 300 },
    },
    "edit",
  );
  expect(result.assets[0].id).not.toBe(target.screens[0].objects[0].id);
  expect(result.screens[0].objects).toHaveLength(4);
  store.dispose();
});

it("retains pattern paint alongside portable image originals through clipboard v2", async () => {
  const pattern: FillPaint = {
    type: "pattern",
    kind: "dots",
    spacing: 12,
    size: 3,
    angle: 0,
    foreground: { color: "#22aa66", alpha: 0.5 },
    background: null,
  };
  const { snapshot, store, project } = await fixture(pattern);
  const text = await (await encodeAssetClipboard(snapshot, store)).text();
  const fragment = parseClipboard(text),
    candidate = await decodeAssetClipboard(fragment),
    target = createProject();
  try {
    const next = applyCommand(
      target,
      {
        type: "paste",
        screenId: target.screens[0].id,
        text,
        origin: "foreign",
        center: { x: 300, y: 300 },
      },
      "edit",
    );
    expect(next.screens[0].objects.at(-1)?.shape).toEqual(
      project.screens[0].objects.at(-1)?.shape,
    );
    expect(fragment.images).toHaveLength(1);
  } finally {
    candidate.dispose();
    store.dispose();
  }
});
