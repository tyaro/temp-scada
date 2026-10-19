import { AssetStore, sha256 } from "./image-assets";
import {
  parseProject,
  serializeProject,
  type Project,
  type ImageAsset,
} from "./project";
export const PACKAGE_LIMIT = 80 * 1024 * 1024;
export const JSON_LIMIT = 1024 * 1024;
const TOTAL_LIMIT = 67 * 1024 * 1024;
const PROFILE = "banto-scada.background-project";
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
export function assetPath(asset: ImageAsset) {
  return `assets/${asset.sha256}.${asset.mime === "image/png" ? "png" : "jpg"}`;
}
function jsonBytes(value: unknown) {
  const bytes = encoder.encode(JSON.stringify(value, null, 2) + "\n");
  if (bytes.length > JSON_LIMIT)
    throw new Error("packageのJSONは各1MiB以下にしてください。");
  return bytes;
}
function json(bytes: Uint8Array): any {
  if (bytes.length > JSON_LIMIT)
    throw new Error("packageのJSONが1MiBを超えています。");
  return JSON.parse(decoder.decode(bytes));
}
function validPath(name: string) {
  return (
    ["manifest.json", "project.json", "checksums.json"].includes(name) ||
    /^assets\/[0-9a-f]{64}\.(png|jpg)$/.test(name)
  );
}
/** Preflight the directory and matching local headers; never extract arbitrary paths. */
function directory(
  bytes: Uint8Array,
): Map<string, { size: number; method: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    entries = new Map<string, { size: number; method: number }>();
  const end = bytes.length - 22;
  if (
    end < 0 ||
    view.getUint32(end, true) !== 0x06054b50 ||
    view.getUint16(end + 20, true) !== 0
  )
    throw new Error(
      "対応するZIP終端がありません（コメント・分割・ZIP64は未対応）。",
    );
  const count = view.getUint16(end + 10, true),
    offset = view.getUint32(end + 16, true),
    size = view.getUint32(end + 12, true);
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== count ||
    count < 3 ||
    count > 131 ||
    offset + size !== end
  )
    throw new Error("ZIPのディレクトリが不正です。");
  let cursor = offset,
    total = 0;
  const localOffsets = new Set<number>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50)
      throw new Error("ZIPのentryが壊れています。");
    const flags = view.getUint16(cursor + 8, true),
      method = view.getUint16(cursor + 10, true),
      compressed = view.getUint32(cursor + 20, true),
      length = view.getUint32(cursor + 24, true),
      nameLength = view.getUint16(cursor + 28, true),
      extra = view.getUint16(cursor + 30, true),
      comment = view.getUint16(cursor + 32, true),
      local = view.getUint32(cursor + 42, true);
    if (cursor + 46 + nameLength + extra + comment > end)
      throw new Error("ZIPのentry名が壊れています。");
    const name = decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLength),
    );
    if (
      !validPath(name) ||
      entries.has(name) ||
      localOffsets.has(local) ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      view.getUint16(cursor + 34, true) !== 0
    )
      throw new Error("ZIPに重複・未対応のentryまたは圧縮方式があります。");
    const limit = name.startsWith("assets/") ? 8 * 1024 * 1024 : JSON_LIMIT;
    if (length === 0 || length > limit || (total += length) > TOTAL_LIMIT)
      throw new Error("ZIPの展開量が上限を超えています。");
    if (
      local + 30 > offset ||
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method
    )
      throw new Error("ZIPのローカルヘッダーが一致しません。");
    const localName = view.getUint16(local + 26, true),
      localExtra = view.getUint16(local + 28, true),
      dataStart = local + 30 + localName + localExtra;
    if (
      dataStart + compressed > offset ||
      decoder.decode(bytes.subarray(local + 30, local + 30 + localName)) !==
        name
    )
      throw new Error("ZIPのentry位置または名前が一致しません。");
    localOffsets.add(local);
    entries.set(name, { size: length, method });
    cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== end)
    throw new Error("ZIPディレクトリに余分な内容があります。");
  return entries;
}
async function unpack(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const expected = directory(bytes),
    { Unzip, UnzipInflate } = await import("fflate"),
    output = new Map<string, Uint8Array>();
  let total = 0;
  const seen = new Set<string>();
  const unzip = new Unzip((file) => {
    const info = expected.get(file.name);
    if (!info || seen.has(file.name) || file.compression !== info.method)
      throw new Error("ZIPのentryが宣言と一致しません。");
    seen.add(file.name);
    let length = 0;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      length += chunk.length;
      total += chunk.length;
      if (length > info.size || total > TOTAL_LIMIT) {
        file.terminate();
        throw new Error("ZIPの実展開量が上限を超えています。");
      }
      chunks.push(chunk);
      if (final) {
        if (length !== info.size)
          throw new Error("ZIPの展開サイズが一致しません。");
        const data = new Uint8Array(length);
        let position = 0;
        for (const chunk of chunks) {
          data.set(chunk, position);
          position += chunk.length;
        }
        output.set(file.name, data);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Limit each compressed input chunk so a malicious deflate stream cannot allocate an unbounded callback output.
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    unzip.push(
      bytes.subarray(offset, offset + 1024),
      offset + 1024 >= bytes.length,
    );
    if (offset % 1048576 === 0)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (output.size !== expected.size)
    throw new Error("ZIPの内容が不足しています。");
  return output;
}
export interface ProjectCandidate {
  project: Project;
  store: AssetStore;
}
export async function readProjectFile(file: Blob): Promise<ProjectCandidate> {
  if (file.size > PACKAGE_LIMIT)
    throw new Error("ファイルは80MiB以下にしてください。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!(bytes[0] === 80 && bytes[1] === 75)) {
    if (bytes.length > JSON_LIMIT)
      throw new Error("JSONは1MiB以下にしてください。");
    const project = parseProject(decoder.decode(bytes));
    if (project.assets.length)
      throw new Error(
        "画像を含むProjectはJSON単体では開けません。画像同梱の.bantoscadaを開いてください。",
      );
    return { project, store: new AssetStore() };
  }
  const files = await unpack(bytes);
  for (const name of ["manifest.json", "project.json", "checksums.json"])
    if (!files.has(name))
      throw new Error("packageの必須ファイルがありません。");
  const checksums = json(files.get("checksums.json")!);
  const contentNames = [...files.keys()]
    .filter((name) => name !== "checksums.json")
    .sort();
  if (
    !checksums ||
    Array.isArray(checksums) ||
    typeof checksums !== "object" ||
    Object.keys(checksums).sort().join("\n") !== contentNames.join("\n")
  )
    throw new Error("packageのchecksum一覧が一致しません。");
  for (const name of contentNames)
    if (
      typeof checksums[name] !== "string" ||
      (await sha256(
        new Blob([files.get(name)! as Uint8Array<ArrayBuffer>]),
      )) !== checksums[name]
    )
      throw new Error("packageのchecksumが一致しません。");
  const manifest = json(files.get("manifest.json")!),
    content = json(files.get("project.json")!);
  if (
    !manifest ||
    Object.keys(manifest).sort().join(",") !== "profile,project,version" ||
    manifest.profile !== PROFILE ||
    manifest.version !== 1
  )
    throw new Error("未対応のpackage profileです。");
  if (
    !content ||
    Array.isArray(content) ||
    typeof content !== "object" ||
    "manifest" in content
  )
    throw new Error("package内のProject内容が不正です。");
  const project = parseProject(
    JSON.stringify({ ...content, manifest: manifest.project }),
  );
  const names = [
    "manifest.json",
    "project.json",
    "checksums.json",
    ...project.assets.map(assetPath),
  ].sort();
  if ([...files.keys()].sort().join("\n") !== names.join("\n"))
    throw new Error("画像資産が不足しているか余分なファイルがあります。");
  const store = new AssetStore();
  try {
    for (const asset of project.assets)
      await store.put(
        new Blob([files.get(assetPath(asset))! as Uint8Array<ArrayBuffer>]),
        asset.name,
        asset,
      );
    return { project, store };
  } catch (error) {
    store.dispose();
    throw error;
  }
}
export async function writeProjectPackage(
  project: Project,
  store: AssetStore,
): Promise<Blob> {
  const snapshot = parseProject(serializeProject(project)),
    release = store.pin(snapshot.assets.map((asset) => asset.sha256));
  try {
    const { manifest, ...content } = snapshot;
    const files: Record<string, Uint8Array> = {
      "manifest.json": jsonBytes({
        profile: PROFILE,
        version: 1,
        project: manifest,
      }),
      "project.json": jsonBytes(content),
    };
    for (const asset of snapshot.assets) {
      const metadata = store.metadata(asset.sha256);
      if (
        ["sha256", "mime", "byteLength", "width", "height"].some(
          (key) =>
            metadata[key as keyof typeof metadata] !==
            asset[key as keyof ImageAsset],
        )
      )
        throw new Error("画像資産とProjectの宣言が一致しません。");
      files[assetPath(asset)] = new Uint8Array(
        await store.blob(asset.sha256).arrayBuffer(),
      );
    }
    const checksums: Record<string, string> = {};
    for (const [name, data] of Object.entries(files))
      checksums[name] = await sha256(
        new Blob([data as Uint8Array<ArrayBuffer>]),
      );
    files["checksums.json"] = jsonBytes(checksums);
    const { zip } = await import("fflate");
    const output = await new Promise<Uint8Array>((resolve, reject) =>
      zip(files, { level: 0 }, (error, data) =>
        error ? reject(error) : resolve(data),
      ),
    );
    if (output.length > PACKAGE_LIMIT)
      throw new Error("packageが80MiBを超えています。");
    return new Blob([output as Uint8Array<ArrayBuffer>], {
      type: "application/zip",
    });
  } finally {
    release();
  }
}
