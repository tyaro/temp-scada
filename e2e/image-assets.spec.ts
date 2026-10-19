import { test, expect } from "@playwright/test";
test("native PNG/JPEG decode retains original bytes, PNG transparency and shared URL lifecycle", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const source = "/src/lib/image-assets.ts";
    const { AssetStore } = await import(source);
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 6;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "rgba(0,128,255,0.5)";
    context.fillRect(0, 0, 8, 6);
    const encode = (type: string) =>
      new Promise<Blob>((resolve) =>
        canvas.toBlob((blob) => resolve(blob!), type),
      );
    const png = await encode("image/png"),
      jpeg = await encode("image/jpeg"),
      store = new AssetStore();
    const first = await store.put(png, "transparent.png"),
      duplicate = await store.put(png, "same.png"),
      second = await store.put(jpeg, "photo.jpg");
    const original = Array.from(new Uint8Array(await png.arrayBuffer())),
      stored = Array.from(
        new Uint8Array(await store.blob(first.sha256).arrayBuffer()),
      );
    const image = await createImageBitmap(store.blob(first.sha256));
    context.clearRect(0, 0, 8, 6);
    context.drawImage(image, 0, 0);
    image.close();
    const alpha = context.getImageData(4, 3, 1, 1).data[3],
      url = store.url(first.sha256),
      release = store.pin([first.sha256]);
    store.collect(new Set());
    const pinnedCount = store.count,
      reachable = (await fetch(url)).ok;
    release();
    store.collect(new Set());
    return {
      first,
      duplicate,
      second,
      original,
      stored,
      alpha,
      pinnedCount,
      reachable,
      count: store.count,
    };
  });
  expect(result.first).toMatchObject({
    mime: "image/png",
    width: 8,
    height: 6,
  });
  expect(result.second).toMatchObject({
    mime: "image/jpeg",
    width: 8,
    height: 6,
  });
  expect(result.duplicate).toEqual(result.first);
  expect(result.stored).toEqual(result.original);
  expect(result.alpha).toBe(128);
  expect(result.pinnedCount).toBe(1);
  expect(result.reachable).toBe(true);
  expect(result.count).toBe(0);
});
