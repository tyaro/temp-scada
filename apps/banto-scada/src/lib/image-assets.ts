import { untrack } from "svelte";
import {
  createImageStore,
  inspectImage as inspectImageBytes,
  inspectImageHeader,
  isImageAssetError,
  sha256Hex,
  validateImageImportLimits,
  type ImageAssetErrorCode,
  type ImageImportLimits,
  type ImageMetadata as UpstreamImageMetadata,
  type ImageStore,
  type ImageUrlLease,
} from "@banto/image-assets";
/** Original image bytes live here, outside Project and its JSON Undo snapshots. */
export const IMAGE_LIMIT = 8 * 1024 * 1024;
export const STORE_LIMIT = 256 * 1024 * 1024;
export const IMAGE_SIDE_LIMIT = 8192;
export const IMAGE_PIXEL_LIMIT = 16_000_000;
export interface ImageMetadata {
  sha256: string;
  mime: "image/png" | "image/jpeg";
  byteLength: number;
  width: number;
  height: number;
  name: string;
}
/** Import limits handed to @banto/image-assets (the package has no defaults). */
const LIMITS: ImageImportLimits = validateImageImportLimits({
  maxBytes: IMAGE_LIMIT,
  maxEdge: IMAGE_SIDE_LIMIT,
  maxPixels: IMAGE_PIXEL_LIMIT,
  formats: ["png", "jpeg"],
});
/** Display text for the package's error codes (it holds no text itself). */
function imageAssetErrorText(code: ImageAssetErrorCode): string {
  switch (code) {
    case "too-large":
      return "画像は空でない8MiB以下のファイルにしてください。";
    case "dimensions-too-large":
    case "too-many-pixels":
      return "画像は1辺8192px以下・1600万画素以下にしてください。";
    case "unsupported-format":
      return "静止PNGまたはJPEGを選択してください（アニメーションPNG、ロスレス・12bitのJPEGには対応していません）。";
    case "malformed-header":
      return "画像のヘッダーが壊れています。ファイルの内容を確認してください。";
    case "read-failed":
      return "画像ファイルを読み取れません。";
    case "decode-failed":
      return "画像を読み取れません。ファイルの内容を確認してください。";
    case "dimensions-mismatch":
      return "画像の寸法がヘッダーと一致しません。";
    default:
      return `画像を取り込めません（${code}）。`;
  }
}
/** Rethrow a package error as the display text the editor reports. */
function translated(error: unknown): never {
  if (isImageAssetError(error))
    throw new Error(imageAssetErrorText(error.code), { cause: error });
  throw error;
}
export async function sha256(blob: Blob): Promise<string> {
  return sha256Hex(new Uint8Array(await blob.arrayBuffer()));
}
/** Bounded header inspection before decoding allocates the full image. */
export function imageHeader(
  bytes: Uint8Array,
): Pick<ImageMetadata, "mime" | "width" | "height"> {
  try {
    const header = inspectImageHeader(bytes, LIMITS);
    return {
      mime: header.mimeType,
      width: header.width,
      height: header.height,
    };
  } catch (error) {
    return translated(error);
  }
}
/** The last path segment, trimmed and bounded ("画像" when nothing is left). */
function fileName(name: string): string {
  return (
    name.replace(/\\/g, "/").split("/").at(-1)?.trim().slice(0, 200) || "画像"
  );
}
export async function inspectImage(
  blob: Blob,
  name: string,
): Promise<ImageMetadata> {
  if (blob.size === 0)
    throw new Error("画像は空でない8MiB以下のファイルにしてください。");
  let checked: Awaited<ReturnType<typeof inspectImageBytes>>;
  try {
    // Content decides the format, not the untrusted file extension or Blob.type.
    checked = await inspectImageBytes(blob, LIMITS);
  } catch (error) {
    return translated(error);
  }
  const filename = fileName(name);
  return Object.freeze({
    mime: checked.mimeType,
    width: checked.width,
    height: checked.height,
    sha256: checked.sha256,
    byteLength: checked.byteLength,
    name: filename,
  });
}
/** Upstream metadata in the shape the editor keeps (the file name is the editor's own). */
function editorMetadata(
  metadata: UpstreamImageMetadata,
  name: string,
): ImageMetadata {
  return {
    mime: metadata.mimeType,
    width: metadata.width,
    height: metadata.height,
    sha256: metadata.sha256,
    byteLength: metadata.byteLength,
    name,
  };
}
/** Store failures in the editor's words; the import check's codes as before. */
function storeErrorText(code: ImageAssetErrorCode): string {
  switch (code) {
    case "store-full":
      return "履歴を含む画像容量が256MiBを超えます。保存後にProjectを開き直してください。";
    case "store-disposed":
      return "画像の取込先は閉じられています。";
    case "unknown-asset":
      return "画像資産が見つかりません。画像を含むpackageを開いてください。";
    default:
      return imageAssetErrorText(code);
  }
}
function storeFailure(error: unknown): never {
  if (isImageAssetError(error))
    throw new Error(storeErrorText(error.code), { cause: error });
  throw error;
}
/**
 * The editor's original-image store over `@banto/image-assets`' `createImageStore`.
 *
 * The upstream store keeps the bytes, de-duplicates by hash, counts pins and lends object URLs.
 * This wrapper keeps what is the editor's own:
 * - the file name (`ImageMetadata.name`, the first name kept for a hash);
 * - the check of a package entry against its declaration (`put`'s `expected`);
 * - the display text of every failure (the upstream code stays in `Error.cause`);
 * - one URL lease per original, taken by `url()` and held until `collect()` drops the original
 *   or `dispose()` (`url()` is read inside `$derived`, where nothing could release a lease).
 */
export class AssetStore {
  readonly #store: ImageStore = createImageStore({
    maxTotalBytes: STORE_LIMIT,
  });
  readonly #names = new Map<string, string>();
  readonly #leases = new Map<string, ImageUrlLease>();
  /** Pins by hash, so that a pinned original keeps its URL lease too. */
  readonly #pins = new Map<string, number>();
  #disposed = false;
  get byteLength() {
    return this.#store.totalBytes;
  }
  get count() {
    return this.#store.count;
  }
  has(hash: string) {
    return this.#store.has(hash);
  }
  metadata(hash: string): ImageMetadata {
    try {
      return editorMetadata(
        this.#store.metadata(hash),
        this.#names.get(hash) ?? "画像",
      );
    } catch (error) {
      return storeFailure(error);
    }
  }
  blob(hash: string): Blob {
    try {
      return this.#store.blob(hash);
    } catch (error) {
      return storeFailure(error);
    }
  }
  url(hash: string): string {
    const lease = this.#leases.get(hash);
    if (lease) return lease.url;
    try {
      const next = this.#store.acquireUrl(hash);
      this.#leases.set(hash, next);
      return next.url;
    } catch (error) {
      return storeFailure(error);
    }
  }
  async put(
    blob: Blob,
    name: string,
    expected?: Omit<ImageMetadata, "name">,
  ): Promise<ImageMetadata> {
    if (this.#disposed) throw new Error(storeErrorText("store-disposed"));
    if (blob.size === 0)
      throw new Error("画像は空でない8MiB以下のファイルにしてください。");
    let added: UpstreamImageMetadata | null;
    try {
      // Content decides the format, not the untrusted file extension or Blob.type.
      added = await this.#store.add(blob, LIMITS);
    } catch (error) {
      return storeFailure(error);
    }
    // Without a key, only dispose() makes an add stale.
    if (added === null) throw new Error(storeErrorText("store-disposed"));
    const hash = added.sha256;
    const metadata = editorMetadata(
      added,
      this.#names.get(hash) ?? fileName(name),
    );
    if (
      expected &&
      (["sha256", "mime", "byteLength", "width", "height"] as const).some(
        (key) => metadata[key] !== expected[key],
      )
    ) {
      // Kept just now by this put (no name yet): drop content that failed its declaration.
      if (!this.#names.has(hash)) this.#store.delete(hash);
      throw new Error("資産の内容が宣言と一致しません。");
    }
    if (!this.#names.has(hash)) this.#names.set(hash, metadata.name);
    return metadata;
  }
  /** Retain asynchronous export/replacement candidates independently of current/Undo roots. */
  pin(hashes: Iterable<string>): () => void {
    const unique = new Set(hashes);
    let releaseUpstream: () => void;
    try {
      releaseUpstream = this.#store.pin(unique);
    } catch (error) {
      return storeFailure(error);
    }
    for (const hash of unique)
      this.#pins.set(hash, (this.#pins.get(hash) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const hash of unique) {
        const count = this.#pins.get(hash)! - 1;
        if (count) this.#pins.set(hash, count);
        else this.#pins.delete(hash);
      }
      releaseUpstream();
      // After dispose(), an original goes away with its last pin and its URL.
      if (this.#disposed) {
        this.#releaseLeases(new Set());
        this.#forgetNames();
      }
    };
  }
  /** Caller supplies the union of current Project and every Undo/Redo snapshot. */
  collect(retained: ReadonlySet<string>) {
    this.#releaseLeases(retained);
    this.#store.collect(retained);
    this.#forgetNames();
  }
  importFrom(source: AssetStore, hash: string): ImageMetadata {
    let added: UpstreamImageMetadata;
    try {
      added = this.#store.importFrom(source.#store, hash);
    } catch (error) {
      return storeFailure(error);
    }
    if (!this.#names.has(hash))
      this.#names.set(hash, source.#names.get(hash) ?? "画像");
    return editorMetadata(added, this.#names.get(hash)!);
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    // An in-flight export holds its snapshot until its final lease is released.
    this.#releaseLeases(new Set());
    this.#store.dispose();
    this.#forgetNames();
  }
  /** Ends the URL leases of originals neither retained nor pinned (revokes their URLs). */
  #releaseLeases(retained: ReadonlySet<string>) {
    for (const [hash, lease] of [...this.#leases])
      if (!retained.has(hash) && !this.#pins.has(hash)) {
        this.#leases.delete(hash);
        lease.release();
      }
  }
  /** A name belongs to a kept original: a later put of the same content takes its own name. */
  #forgetNames() {
    untrack(() => {
      for (const hash of [...this.#names.keys()])
        if (!this.#store.has(hash)) this.#names.delete(hash);
    });
  }
}
