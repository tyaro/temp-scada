import {
  parseProject,
  serializeProject,
  type Project,
  type ScreenObject,
} from "./project";
export const CLIPBOARD_LIMIT = 4 * 1024 * 1024;
export interface ObjectClipboard {
  format: "banto-scada.objects";
  version: 1;
  origin: string;
  project: Project;
}
export function parseClipboard(text: string): ObjectClipboard {
  if (
    text.length > CLIPBOARD_LIMIT ||
    new TextEncoder().encode(text).length > CLIPBOARD_LIMIT
  )
    throw new Error("クリップボードのデータが4MiBを超えています");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SCADAの図形コピーではありません");
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).sort().join(",") !== "format,origin,project,version" ||
    data.format !== "banto-scada.objects" ||
    data.version !== 1 ||
    typeof data.origin !== "string" ||
    !data.origin.length ||
    data.origin.length > 100
  )
    throw new Error("SCADAの図形コピーの形式またはバージョンが不正です");
  const project = parseProject(JSON.stringify(data.project));
  if (project.screens.length !== 1 || !project.screens[0].objects.length)
    throw new Error("コピー対象の図形がありません");
  return {
    format: "banto-scada.objects",
    version: 1,
    origin: data.origin,
    project,
  };
}
export function copyObjects(
  project: Project,
  targetId: string,
  ids: string[],
  origin: string,
): string {
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
    assets: [],
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
  const text = JSON.stringify({
    format: "banto-scada.objects",
    version: 1,
    origin,
    project: JSON.parse(serializeProject(fragment)),
  });
  parseClipboard(text);
  return text;
}
