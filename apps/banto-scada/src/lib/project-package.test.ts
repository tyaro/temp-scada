import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { zipSync, unzipSync } from "fflate";
import { AssetStore, sha256 } from "./image-assets";
import { createProject } from "./new-project";
import { applyCommand, newId } from "./editor";
import { readProjectFile, writeProjectPackage } from "./project-package";
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
async function fixture() {
  const project = createProject(),
    store = new AssetStore(),
    metadata = await store.put(new Blob([png]), "原本.png"),
    asset = { ...metadata, id: newId() };
  return {
    project: applyCommand(
      project,
      {
        type: "set-background-image",
        screenId: project.screens[0].id,
        asset,
        image: { assetId: asset.id, fit: "contain", opacity: 0.5 },
      },
      "edit",
    ),
    store,
  };
}
async function alter(
  change: (files: Record<string, Uint8Array>) => void,
  checksum = false,
) {
  const { project, store } = await fixture(),
    files = unzipSync(
      new Uint8Array(
        await (await writeProjectPackage(project, store)).arrayBuffer(),
      ),
    );
  change(files);
  if (checksum) {
    const sums: Record<string, string> = {};
    for (const [name, data] of Object.entries(files))
      if (name !== "checksums.json")
        sums[name] = await sha256(new Blob([data as Uint8Array<ArrayBuffer>]));
    files["checksums.json"] = new TextEncoder().encode(JSON.stringify(sums));
  }
  return new Blob([zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>]);
}
it("round trips original assets with a fresh Store and still opens asset-free JSON", async () => {
  const { project, store } = await fixture(),
    archive = await writeProjectPackage(project, store),
    result = await readProjectFile(archive);
  expect(result.project).toEqual(project);
  expect(result.store).not.toBe(store);
  expect(
    new Uint8Array(
      await result.store.blob(project.assets[0].sha256).arrayBuffer(),
    ),
  ).toEqual(png);
  const plain = createProject();
  expect(
    (await readProjectFile(new Blob([JSON.stringify(plain)]))).project,
  ).toEqual(plain);
  await expect(
    readProjectFile(new Blob([JSON.stringify(project)])),
  ).rejects.toThrow(/JSON単体/);
  result.store.dispose();
  store.dispose();
});
it("rejects corrupt checksums, unsupported profiles and missing/extra files before adoption", async () => {
  await expect(
    readProjectFile(
      await alter((files) => {
        files["project.json"][5] ^= 1;
      }),
    ),
  ).rejects.toThrow(/checksum/);
  await expect(
    readProjectFile(
      await alter((files) => {
        const data = JSON.parse(
          new TextDecoder().decode(files["manifest.json"]),
        );
        data.profile = "other";
        files["manifest.json"] = new TextEncoder().encode(JSON.stringify(data));
      }, true),
    ),
  ).rejects.toThrow(/profile/);
  await expect(
    readProjectFile(
      await alter((files) => {
        delete files[
          Object.keys(files).find((name) => name.startsWith("assets/"))!
        ];
      }, true),
    ),
  ).rejects.toThrow(/不足/);
  await expect(
    readProjectFile(
      await alter((files) => {
        files["unknown.txt"] = new Uint8Array([1]);
      }, true),
    ),
  ).rejects.toThrow(/未対応/);
  await expect(
    readProjectFile(
      await alter((files) => {
        files["../project.json"] = new Uint8Array([1]);
      }, true),
    ),
  ).rejects.toThrow(/未対応/);
});
it("checks declared bytes after checksums, and rejects truncation, encryption and duplicate local entries", async () => {
  await expect(
    readProjectFile(
      await alter((files) => {
        const content = JSON.parse(
          new TextDecoder().decode(files["project.json"]),
        );
        content.assets[0].width = 2;
        files["project.json"] = new TextEncoder().encode(
          JSON.stringify(content),
        );
      }, true),
    ),
  ).rejects.toThrow(/宣言/);
  const { project, store } = await fixture(),
    bytes = new Uint8Array(
      await (await writeProjectPackage(project, store)).arrayBuffer(),
    );
  await expect(readProjectFile(new Blob([bytes.slice(0, -1)]))).rejects.toThrow(
    /終端/,
  );
  const encrypted = bytes.slice(),
    view = new DataView(encrypted.buffer);
  for (let i = 0; i < encrypted.length - 46; i++)
    if (view.getUint32(i, true) === 0x02014b50) {
      view.setUint16(i + 8, 1, true);
      break;
    }
  await expect(readProjectFile(new Blob([encrypted]))).rejects.toThrow(
    /未対応/,
  );
  const duplicate = bytes.slice(),
    dv = new DataView(duplicate.buffer),
    end = duplicate.length - 22,
    first = dv.getUint32(end + 16, true),
    second =
      first +
      46 +
      dv.getUint16(first + 28, true) +
      dv.getUint16(first + 30, true) +
      dv.getUint16(first + 32, true);
  dv.setUint32(second + 42, dv.getUint32(first + 42, true), true);
  await expect(readProjectFile(new Blob([duplicate]))).rejects.toThrow(/重複/);
  const undersized = bytes.slice(),
    uv = new DataView(undersized.buffer);
  uv.setUint32(first + 24, 1, true);
  await expect(readProjectFile(new Blob([undersized]))).rejects.toThrow(
    /実展開量/,
  );
});

it("reads a standard deflated package through the bounded streaming decoder", async () => {
  const { project, store } = await fixture(),
    archive = await writeProjectPackage(project, store),
    files = unzipSync(new Uint8Array(await archive.arrayBuffer())),
    compressed = zipSync(files, { level: 6 });
  const result = await readProjectFile(
    new Blob([compressed as Uint8Array<ArrayBuffer>]),
  );
  expect(result.project).toEqual(project);
  result.store.dispose();
  store.dispose();
});
