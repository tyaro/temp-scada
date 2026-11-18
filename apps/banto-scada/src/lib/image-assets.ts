import {
  inspectImage as inspectImageBytes,
  inspectImageHeader,
  isImageAssetError,
  sha256Hex,
  validateImageImportLimits,
  type ImageAssetErrorCode,
  type ImageImportLimits,
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
  const filename =
    name.replace(/\\/g, "/").split("/").at(-1)?.trim().slice(0, 200) || "画像";
  return Object.freeze({
    mime: checked.mimeType,
    width: checked.width,
    height: checked.height,
    sha256: checked.sha256,
    byteLength: checked.byteLength,
    name: filename,
  });
}
export class AssetStore {
  #entries = new Map<
    string,
    { blob: Blob; metadata: ImageMetadata; url?: string }
  >();
  #pins = new Map<string, number>();
  #size = 0;
  #disposed = false;
  get byteLength() {
    return this.#size;
  }
  get count() {
    return this.#entries.size;
  }
  has(hash: string) {
    return this.#entries.has(hash);
  }
  metadata(hash: string): ImageMetadata {
    return { ...this.#entry(hash).metadata };
  }
  blob(hash: string): Blob {
    return this.#entry(hash).blob;
  }
  url(hash: string): string {
    const entry = this.#entry(hash);
    return (entry.url ??= URL.createObjectURL(entry.blob));
  }
  async put(
    blob: Blob,
    name: string,
    expected?: Omit<ImageMetadata, "name">,
  ): Promise<ImageMetadata> {
    if (this.#disposed) throw new Error("画像の取込先は閉じられています。");
    const metadata = await inspectImage(blob, name);
    if (this.#disposed) throw new Error("画像の取込先は閉じられています。");
    if (
      expected &&
      ["sha256", "mime", "byteLength", "width", "height"].some(
        (key) =>
          metadata[key as keyof typeof metadata] !==
          expected[key as keyof typeof expected],
      )
    )
      throw new Error("資産の内容が宣言と一致しません。");
    const existing = this.#entries.get(metadata.sha256);
    if (existing) return { ...existing.metadata };
    if (this.#size + blob.size > STORE_LIMIT)
      throw new Error(
        "履歴を含む画像容量が256MiBを超えます。保存後にProjectを開き直してください。",
      );
    this.#entries.set(metadata.sha256, {
      metadata,
      blob: new Blob([blob], { type: metadata.mime }),
    });
    this.#size += blob.size;
    return { ...metadata };
  }
  /** Retain asynchronous export/replacement candidates independently of current/Undo roots. */
  pin(hashes: Iterable<string>): () => void {
    const unique = new Set(hashes);
    for (const hash of unique) this.#entry(hash);
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
      if (this.#disposed) this.collect(new Set());
    };
  }
  /** Caller supplies the union of current Project and every Undo/Redo snapshot. */
  collect(retained: ReadonlySet<string>) {
    for (const [hash, entry] of this.#entries)
      if (!retained.has(hash) && !this.#pins.has(hash)) {
        if (entry.url) URL.revokeObjectURL(entry.url);
        this.#size -= entry.blob.size;
        this.#entries.delete(hash);
      }
  }
  importFrom(source: AssetStore, hash: string): ImageMetadata {
    if (this.#disposed) throw new Error("画像の取込先は閉じられています。");
    const entry = source.#entry(hash),
      existing = this.#entries.get(hash);
    if (existing) return { ...existing.metadata };
    if (this.#size + entry.blob.size > STORE_LIMIT)
      throw new Error(
        "履歴を含む画像容量が256MiBを超えます。保存後にProjectを開き直してください。",
      );
    this.#entries.set(hash, { blob: entry.blob, metadata: entry.metadata });
    this.#size += entry.blob.size;
    return { ...entry.metadata };
  }
  dispose() {
    this.#disposed = true;
    // An in-flight export holds its snapshot until its final lease is released.
    this.collect(new Set());
  }
  #entry(hash: string) {
    const entry = this.#entries.get(hash);
    if (!entry)
      throw new Error(
        "画像資産が見つかりません。画像を含むpackageを開いてください。",
      );
    return entry;
  }
}
