import { AssetStore } from "./image-assets";
import {
  parseClipboard,
  IMAGE_CLIPBOARD_LIMIT,
  CLIPBOARD_IMAGE_BYTES,
  CLIPBOARD_LIMIT,
  type ObjectClipboard,
} from "./clipboard";
export function validateAssetClipboardSnapshot(
  snapshot: Omit<ObjectClipboard, "version" | "images">,
) {
  if (
    snapshot.project.assets.reduce((n, a) => n + a.byteLength, 0) >
    CLIPBOARD_IMAGE_BYTES
  )
    throw new Error("clipboardの画像原本は合計16MiB以下にしてください。");
  if (
    new TextEncoder().encode(JSON.stringify(snapshot.project)).length >
    CLIPBOARD_LIMIT
  )
    throw new Error("clipboardの図形・宣言は4MiB以下にしてください。");
}
/** Snapshot and lease are established before the first await. */
export async function encodeAssetClipboard(
  snapshot: Omit<ObjectClipboard, "version" | "images">,
  store: AssetStore,
): Promise<Blob> {
  validateAssetClipboardSnapshot(snapshot);
  const fragment = structuredClone(snapshot);
  const release = store.pin(fragment.project.assets.map((a) => a.sha256));
  try {
    const images = [];
    for (const asset of fragment.project.assets) {
      const bytes = new Uint8Array(
        await store.blob(asset.sha256).arrayBuffer(),
      );
      let binary = "";
      for (let i = 0; i < bytes.length; i += 32768)
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      images.push({ sha256: asset.sha256, data: btoa(binary) });
    }
    const text = JSON.stringify({ ...fragment, version: 2, images });
    if (new TextEncoder().encode(text).length > IMAGE_CLIPBOARD_LIMIT)
      throw new Error("画像clipboardのデータが32MiBを超えています");
    parseClipboard(text);
    return new Blob([text], { type: "text/plain" });
  } finally {
    release();
  }
}
/** Native image decode and SHA-256 verification happen before touching the destination. */
export async function decodeAssetClipboard(
  fragment: ObjectClipboard,
): Promise<AssetStore> {
  const candidate = new AssetStore();
  try {
    if (fragment.version !== 2) return candidate;
    for (const asset of fragment.project.assets) {
      const encoded = fragment.images!.find(
        (image) => image.sha256 === asset.sha256,
      )!.data;
      const binary = atob(encoded);
      if (binary.length !== asset.byteLength || btoa(binary) !== encoded)
        throw new Error("画像clipboardのbase64と宣言サイズが一致しません。");
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      await candidate.put(new Blob([bytes]), asset.name, asset);
    }
    return candidate;
  } catch (error) {
    candidate.dispose();
    throw error;
  }
}
