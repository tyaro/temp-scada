import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AssetStore,
  imageHeader,
  inspectImage,
  sha256,
  IMAGE_LIMIT,
} from "./image-assets";
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVhEAAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);
const blob = () => new Blob([png], { type: "application/octet-stream" });
let close: ReturnType<typeof vi.fn>;
beforeEach(() => {
  close = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 1, height: 1, close })),
  );
});
afterEach(() => vi.unstubAllGlobals());
it("checks content, dimensions, static PNG chunks, decode and original-byte hash rather than file extension", async () => {
  expect(imageHeader(png)).toEqual({ mime: "image/png", width: 1, height: 1 });
  const metadata = await inspectImage(blob(), "C:\\images\\設備.jpg");
  expect(metadata).toEqual({
    mime: "image/png",
    width: 1,
    height: 1,
    byteLength: png.length,
    sha256: await sha256(blob()),
    name: "設備.jpg",
  });
  expect(close).toHaveBeenCalledOnce();
  expect(Object.isFrozen(metadata)).toBe(true);
  const header = png.slice();
  new DataView(header.buffer).setUint32(16, 9000);
  expect(() => imageHeader(header)).toThrow(/8192/);
  const malformed = png.slice();
  new DataView(malformed.buffer).setUint32(8, 0xffffffff);
  expect(() => imageHeader(malformed)).toThrow(/壊れ/);
  expect(() => imageHeader(png.slice(0, -12))).toThrow(/終端/);
  const animation = new Uint8Array(png.length + 12);
  animation.set(png.subarray(0, 33));
  animation.set([0, 0, 0, 0, 97, 99, 84, 76, 0, 0, 0, 0], 33);
  animation.set(png.subarray(33), 45);
  expect(() => imageHeader(animation)).toThrow(/アニメーション/);
  await expect(
    inspectImage(new Blob([new Uint8Array(IMAGE_LIMIT + 1)]), "large"),
  ).rejects.toThrow(/8MiB/);
  await expect(inspectImage(new Blob(), "empty")).rejects.toThrow(/空/);
  await expect(inspectImage(new Blob(["<svg/>"]), "fake.png")).rejects.toThrow(
    /PNG/,
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => {
      throw new Error("decode");
    }),
  );
  await expect(inspectImage(blob(), "bad")).rejects.toThrow(/読み取れません/);
});
it("checks JPEG frame dimensions, oriented decode and mismatched metadata", async () => {
  const jpeg = new Uint8Array([
    255, 216, 255, 192, 0, 17, 8, 0, 10, 0, 20, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0,
    255, 217,
  ]);
  expect(imageHeader(jpeg)).toEqual({
    mime: "image/jpeg",
    width: 20,
    height: 10,
  });
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 10, height: 20, close })),
  );
  expect(await inspectImage(new Blob([jpeg]), "rotated.jpg")).toMatchObject({
    width: 10,
    height: 20,
  });
  expect(close).toHaveBeenCalledOnce();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 3, height: 4, close })),
  );
  await expect(inspectImage(blob(), "mismatch")).rejects.toThrow(/一致/);
  expect(close).toHaveBeenCalledTimes(2);
});
it("shares immutable original bytes, returns defensive metadata, and checks package declarations", async () => {
  const store = new AssetStore(),
    first = await store.put(blob(), "first");
  expect(await store.put(blob(), "another")).toEqual(first);
  expect(store.count).toBe(1);
  expect(store.byteLength).toBe(png.length);
  first.width = 100;
  expect(store.metadata(first.sha256).width).toBe(1);
  expect(new Uint8Array(await store.blob(first.sha256).arrayBuffer())).toEqual(
    png,
  );
  const metadata = store.metadata(first.sha256);
  await expect(
    store.put(blob(), "invalid", { ...metadata, width: 2 }),
  ).rejects.toThrow(/宣言/);
  expect(store.count).toBe(1);
  expect(() => store.blob("missing")).toThrow(/見つかりません/);
  store.dispose();
  expect(store.count).toBe(0);
  await expect(store.put(blob(), "late")).rejects.toThrow(/閉じられ/);
});
it("retains history/export roots, revokes cached URLs on collection, and releases leases idempotently", async () => {
  const store = new AssetStore(),
    metadata = await store.put(blob(), "one"),
    hash = metadata.sha256;
  const revoke = vi.spyOn(URL, "revokeObjectURL"),
    url = store.url(hash);
  expect(store.url(hash)).toBe(url);
  const release = store.pin([hash, hash]);
  store.collect(new Set());
  expect(store.count).toBe(1);
  release();
  release();
  store.collect(new Set([hash]));
  expect(store.count).toBe(1);
  store.collect(new Set());
  expect(store.count).toBe(0);
  expect(store.byteLength).toBe(0);
  expect(revoke).toHaveBeenCalledWith(url);
  revoke.mockRestore();
});
it("rejects a decoded result arriving after its store was disposed", async () => {
  let complete!: (value: any) => void;
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(() => new Promise((resolve) => (complete = resolve))),
  );
  const store = new AssetStore(),
    pending = store.put(blob(), "old");
  await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
  store.dispose();
  complete({ width: 1, height: 1, close });
  await expect(pending).rejects.toThrow(/閉じられ/);
  expect(store.count).toBe(0);
  expect(close).toHaveBeenCalledOnce();
});
