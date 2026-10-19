import {
  parseProject,
  serializeProject,
  type Project,
  type ScreenObject,
} from "./project";
export const CLIPBOARD_LIMIT = 4 * 1024 * 1024;
export const IMAGE_CLIPBOARD_LIMIT = 32 * 1024 * 1024;
export const CLIPBOARD_IMAGE_BYTES = 16 * 1024 * 1024;
export interface ClipboardImage {
  sha256: string;
  data: string;
}
export interface ObjectClipboard {
  format: "banto-scada.objects";
  version: 1 | 2;
  images?: ClipboardImage[];
  origin: string;
  project: Project;
}
export function parseClipboard(text: string): ObjectClipboard {
  if (
    text.length > IMAGE_CLIPBOARD_LIMIT ||
    new TextEncoder().encode(text).length > IMAGE_CLIPBOARD_LIMIT
  )
    throw new Error("画像clipboardのデータが32MiBを超えています");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SCADAの図形コピーではありません");
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).sort().join(",") !==
      (data.version === 2
        ? "format,images,origin,project,version"
        : "format,origin,project,version") ||
    data.format !== "banto-scada.objects" ||
    (data.version !== 1 && data.version !== 2) ||
    typeof data.origin !== "string" ||
    !data.origin.length ||
    data.origin.length > 100
  )
    throw new Error("SCADAの図形コピーの形式またはバージョンが不正です");
  if (
    data.version === 1 &&
    (text.length > CLIPBOARD_LIMIT ||
      new TextEncoder().encode(text).length > CLIPBOARD_LIMIT)
  )
    throw new Error("クリップボードのデータが4MiBを超えています");
  if (
    data.version === 2 &&
    new TextEncoder().encode(JSON.stringify(data.project)).length >
      CLIPBOARD_LIMIT
  )
    throw new Error("clipboardの図形・宣言は4MiB以下にしてください。");
  const project = parseProject(JSON.stringify(data.project));
  if (data.version === 1 && project.assets.length)
    throw new Error(
      "画像を含むコピーの貼り付けは未対応です。画像同梱Projectを使ってください。",
    );
  if (project.screens.length !== 1 || !project.screens[0].objects.length)
    throw new Error("コピー対象の図形がありません");
  if (data.version === 2) {
    if (
      !project.assets.length ||
      project.screens[0].backgroundImage ||
      project.screens[0].folders.length
    )
      throw new Error(
        "画像clipboardには選択した配置と必要な資産だけを含めてください。",
      );
    const usedSymbols = new Set(
      project.screens[0].objects.flatMap((o) =>
        o.shape.type === "symbol" ? [o.shape.symbolId] : [],
      ),
    );
    if (
      project.symbols.length !== usedSymbols.size ||
      project.symbols.some((symbol) => !usedSymbols.has(symbol.id))
    )
      throw new Error("画像clipboardに未使用のSymbol定義があります。");
    const images = data.images;
    if (!Array.isArray(images) || images.length !== project.assets.length)
      throw new Error("画像clipboardの原本が不足しているか余分です。");
    let size = 0;
    const seen = new Set<string>();
    for (const image of images) {
      if (
        !image ||
        typeof image !== "object" ||
        Array.isArray(image) ||
        Object.keys(image).sort().join(",") !== "data,sha256" ||
        typeof image.data !== "string"
      )
        throw new Error("画像clipboardの原本形式が不正です。");
      const asset = project.assets.find((a) => a.sha256 === image.sha256);
      if (!asset || seen.has(image.sha256))
        throw new Error("画像clipboardの原本hashが重複または不一致です。");
      seen.add(image.sha256);
      size += asset.byteLength;
      if (size > CLIPBOARD_IMAGE_BYTES)
        throw new Error("clipboardの画像原本は合計16MiB以下にしてください。");
      if (
        image.data.length !== 4 * Math.ceil(asset.byteLength / 3) ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
      )
        throw new Error(
          "画像clipboardのbase64形式または宣言サイズが不正です。",
        );
    }
  }
  return {
    format: "banto-scada.objects",
    version: data.version,
    origin: data.origin,
    project,
    ...(data.version === 2 ? { images: data.images as ClipboardImage[] } : {}),
  };
}
export function copyObjectSnapshot(
  project: Project,
  targetId: string,
  ids: string[],
  origin: string,
): Omit<ObjectClipboard, "version" | "images"> {
  const target = [...project.screens, ...project.symbols].find(
    (s) => s.id === targetId,
  );
  const wanted = new Set(ids);
  if (!target || !wanted.size || wanted.size !== ids.length)
    throw new Error("コピーする配置を選択してください");
  const objects: ScreenObject[] = target.objects
    .filter((o) => wanted.has(o.id))
    .map((object) => ({ ...object }));
  if (objects.length !== wanted.size)
    throw new Error("コピー対象が見つかりません");
  // Clipboard placements deliberately start at the destination root.
  for (const object of objects) delete object.folderId;
  const dependencies = new Set(
    objects.flatMap((o) =>
      o.shape.type === "symbol" ? [o.shape.symbolId] : [],
    ),
  );
  const fragment: Project = {
    manifest: { ...project.manifest },
    assets: project.assets.filter((asset) =>
      objects.some(
        (object) =>
          object.shape.type === "image" && object.shape.assetId === asset.id,
      ),
    ),
    screens: [
      {
        id: target.id,
        name: target.name,
        width: target.width,
        height: target.height,
        background:
          "background" in target && typeof target.background === "string"
            ? target.background
            : "#0b1220",
        objects,
        folders: [],
      },
    ],
    symbols: project.symbols.filter((s) => dependencies.has(s.id)),
  };
  return {
    format: "banto-scada.objects",
    origin,
    project: parseProject(serializeProject(fragment)),
  };
}
export function copyObjects(
  project: Project,
  targetId: string,
  ids: string[],
  origin: string,
): string {
  const snapshot = copyObjectSnapshot(project, targetId, ids, origin);
  if (snapshot.project.assets.length)
    throw new Error("画像を含むコピーは原本付きclipboardを使ってください。");
  const text = JSON.stringify({ ...snapshot, version: 1 });
  parseClipboard(text);
  return text;
}
