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
export async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
function checkDimensions(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > IMAGE_SIDE_LIMIT ||
    height > IMAGE_SIDE_LIMIT ||
    width * height > IMAGE_PIXEL_LIMIT
  )
    throw new Error("画像は1辺8192px以下・1600万画素以下にしてください。");
}
/** Bounded header inspection before decoding allocates the full image. */
export function imageHeader(
  bytes: Uint8Array,
): Pick<ImageMetadata, "mime" | "width" | "height"> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 33 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)
  ) {
    let offset = 8,
      width = 0,
      height = 0,
      end = false;
    while (offset + 12 <= bytes.length) {
      const size = view.getUint32(offset),
        type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (size > bytes.length - offset - 12)
        throw new Error("PNGのチャンクが壊れています。");
      if (offset === 8) {
        if (type !== "IHDR" || size !== 13)
          throw new Error("PNGのヘッダーが不正です。");
        width = view.getUint32(offset + 8);
        height = view.getUint32(offset + 12);
        checkDimensions(width, height);
      }
      if (type === "acTL")
        throw new Error("アニメーションPNGにはまだ対応していません。");
      offset += size + 12;
      if (type === "IEND") {
        if (size !== 0 || offset !== bytes.length)
          throw new Error("PNGの終端が不正です。");
        end = true;
        break;
      }
    }
    if (!end) throw new Error("PNGの終端がありません。");
    return { mime: "image/png", width, height };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255)
        throw new Error("JPEGのマーカーが不正です。");
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const size = view.getUint16(offset);
      if (size < 2 || size > bytes.length - offset)
        throw new Error("JPEGのセグメントが壊れています。");
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (size < 8) throw new Error("JPEGのフレームが不正です。");
        const height = view.getUint16(offset + 3),
          width = view.getUint16(offset + 5);
        checkDimensions(width, height);
        return { mime: "image/jpeg", width, height };
      }
      offset += size;
    }
    throw new Error("対応するJPEGの画像寸法を取得できません。");
  }
  throw new Error("静止PNGまたはJPEGを選択してください。");
}
export async function inspectImage(
  blob: Blob,
  name: string,
): Promise<ImageMetadata> {
  if (blob.size === 0 || blob.size > IMAGE_LIMIT)
    throw new Error("画像は空でない8MiB以下のファイルにしてください。");
  const header = imageHeader(new Uint8Array(await blob.arrayBuffer()));
  // Use content MIME rather than the untrusted file extension or Blob.type.
  const original = new Blob([blob], { type: header.mime });
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(original, {
      imageOrientation: "from-image",
    });
  } catch {
    throw new Error("画像を読み取れません。ファイルの内容を確認してください。");
  }
  let width: number, height: number;
  try {
    width = bitmap.width;
    height = bitmap.height;
    checkDimensions(width, height);
    // EXIF orientation may transpose JPEG's stored dimensions.
    if (
      !(width === header.width && height === header.height) &&
      !(
        header.mime === "image/jpeg" &&
        width === header.height &&
        height === header.width
      )
    )
      throw new Error("画像の寸法がヘッダーと一致しません。");
  } finally {
    bitmap.close();
  }
  const filename =
    name.replace(/\\/g, "/").split("/").at(-1)?.trim().slice(0, 200) || "画像";
  return Object.freeze({
    ...header,
    width,
    height,
    sha256: await sha256(original),
    byteLength: blob.size,
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
      if (released || this.#disposed) return;
      released = true;
      for (const hash of unique) {
        const count = this.#pins.get(hash)! - 1;
        if (count) this.#pins.set(hash, count);
        else this.#pins.delete(hash);
      }
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
  dispose() {
    this.#disposed = true;
    for (const entry of this.#entries.values())
      if (entry.url) URL.revokeObjectURL(entry.url);
    this.#entries.clear();
    this.#pins.clear();
    this.#size = 0;
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
