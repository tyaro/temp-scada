import {
  validateEquipment,
  type EquipmentType,
  type EquipmentInstance,
} from "./equipment";
import { validateGroups } from "./geometric-groups";
import { projectScreenReferences } from "./screen-references";
import { patternGeometry, type PatternKind } from "./pattern-paint";
import { linearGradientEndpoints } from "./linear-gradient";
import { imageCropViewBox, type ImageCrop } from "./image-crop";
import type { ImageMetadata } from "./image-assets";
import { rotatedBounds, rotationPivot } from "./rotation";
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../../crates/scada-model/schema/project.schema.json";
import legacySchema from "../../../../crates/scada-model/schema/legacy.project.schema.json";
export interface Point {
  x: number;
  y: number;
}
interface BaseObject {
  opacity?: number;
  colorAlpha?: number;
  rotation: number;
  folderId?: string;
  name?: string;
  locked?: boolean;
  visible?: boolean;
  id: string;
  order: number;
  x: number;
  y: number;
  fill?: string;
}
export interface TagBinding {
  externalName: string;
}
export type LineStyle = "solid" | "dashed" | "dotted";
export interface PaintColor {
  color: string;
  alpha: number;
}
export type FillPaint =
  | ({ type: "solid" } & PaintColor)
  | {
      type: "linearGradient";
      angle: number;
      start: PaintColor;
      end: PaintColor;
    }
  | {
      type: "pattern";
      kind: PatternKind;
      spacing: number;
      size: number;
      angle: number;
      foreground: PaintColor;
      background: PaintColor | null;
    };
export interface ShapePaint {
  fill: { enabled: boolean; paint: FillPaint };
  stroke: {
    color: string;
    width: number;
    lineStyle?: LineStyle;
    alpha?: number;
  } | null;
}
export interface TextStyle {
  fontSize: number;
  fontWeight: "normal" | "bold";
  align: "left" | "center" | "right";
}
export type SymbolColorMode = "monochrome" | "definition";
export interface LayoutObject extends BaseObject {
  width: number;
  height: number;
  shape:
    | { type: "rectangle"; paint: ShapePaint }
    | { type: "ellipse"; paint: ShapePaint }
    | { type: "text"; text: string; style: TextStyle; binding?: TagBinding }
    | { type: "symbol"; symbolId: string; colorMode: SymbolColorMode }
    | { type: "image"; assetId: string; fit: "contain"; crop?: ImageCrop }
    | { type: "screenView"; screenId: string; fit: "contain" };
}
export interface PolylineObject extends BaseObject {
  shape: {
    type: "polyline";
    points: Point[];
    strokeWidth: number;
    lineStyle?: LineStyle;
    arrow: "none" | "end";
  };
}
export type ScreenObject = LayoutObject | PolylineObject;
export interface LayerFolder {
  id: string;
  name: string;
  order: number;
  parentId?: string;
}
export const MAX_LAYER_FOLDERS = schema.$defs.layerFolders.maxItems;
export const MAX_FOLDER_DEPTH = 16;
export interface ImageAsset extends ImageMetadata {
  id: string;
}
export interface BackgroundImage {
  assetId: string;
  fit: "contain" | "cover" | "stretch" | "original";
  opacity: number;
}
export interface GeometricGroup {
  id: string;
  name?: string;
  memberIds: string[];
}
export interface Screen {
  groups: GeometricGroup[];
  backgroundImage?: BackgroundImage;
  folders: LayerFolder[];
  background: string;
  id: string;
  name: string;
  width: number;
  height: number;
  objects: ScreenObject[];
}
export interface SymbolDefinition {
  folders: LayerFolder[];
  id: string;
  name: string;
  width: number;
  height: number;
  objects: ScreenObject[];
}
export interface Project {
  equipmentTypes?: EquipmentType[];
  equipment?: EquipmentInstance[];
  assets: ImageAsset[];
  manifest: {
    product: "banto-scada";
    schemaVersion: "0.23.0";
    projectId: string;
    projectRevision: number;
    minRuntimeVersion: "0.23.0";
    name: string;
  };
  screens: Screen[];
  symbols: SymbolDefinition[];
}
const ajv = new Ajv2020({ allErrors: true, strictNumbers: true });
const validate = ajv.compile<Project>(schema);
const legacy = ajv.compile(legacySchema);
export function parseProject(json: string): Project {
  let value: unknown = JSON.parse(json);
  let migratedLegacy = false;
  if (
    (value as { manifest?: { schemaVersion?: unknown } } | null)?.manifest
      ?.schemaVersion === "0.1.0"
  ) {
    migratedLegacy = true;
    if (!legacy(value)) throw new Error("旧 Project の形式が不正です");
    const old = value as unknown as Project;
    value = {
      ...old,
      assets: [],
      manifest: {
        ...old.manifest,
        schemaVersion: "0.23.0",
        minRuntimeVersion: "0.23.0",
      },
      screens: old.screens.map((screen) => ({
        ...screen,
        groups: [],
        folders: [],
        objects: screen.objects.map((object) => ({
          ...object,
          rotation: 0,
          shape:
            object.shape.type === "rectangle" || object.shape.type === "ellipse"
              ? {
                  ...object.shape,
                  paint: {
                    fill: {
                      enabled: true,
                      paint: { type: "solid", color: object.fill!, alpha: 1 },
                    },
                    stroke: null,
                  },
                }
              : object.shape.type === "text"
                ? {
                    ...object.shape,
                    style: {
                      fontSize: Math.min(
                        512,
                        (object as LayoutObject).height * 0.7,
                      ),
                      fontWeight: "normal",
                      align: "left",
                    },
                  }
                : object.shape,
        })),
        background: "#0b1220",
      })),
      symbols: [],
    };
  }
  if (migratedLegacy) {
    for (const screen of (value as Project).screens)
      for (const object of screen.objects)
        if (
          object.shape.type === "rectangle" ||
          object.shape.type === "ellipse"
        )
          delete object.fill;
  }
  if (!validate(value))
    throw new Error(
      validate.errors
        ?.map((e) => `${e.instancePath || "/"} ${e.message}`)
        .join(" / "),
    );
  const project = value;
  const ids = new Set([project.manifest.projectId]);
  const symbolIds = new Set(project.symbols.map((s) => s.id));
  const hashes = new Set<string>(),
    usedAssets = referencedAssets(project);
  let totalBytes = 0;
  for (const asset of project.assets) {
    if (ids.has(asset.id)) throw new Error("ID が重複しています");
    ids.add(asset.id);
    if (hashes.has(asset.sha256))
      throw new Error("同じ画像hashの資産宣言が重複しています");
    hashes.add(asset.sha256);
    if (asset.width * asset.height > 16_000_000)
      throw new Error("画像は1600万画素以下にしてください");
    totalBytes += asset.byteLength;
    if (!usedAssets.has(asset.id))
      throw new Error("未使用の画像資産宣言があります");
  }
  if (totalBytes > 64 * 1024 * 1024)
    throw new Error("Projectの画像容量が64MiBを超えています");
  if ([...usedAssets].some((id) => !project.assets.some((a) => a.id === id)))
    throw new Error("画像の資産が見つかりません");

  for (const owner of [...project.screens, ...project.symbols]) {
    if (ids.has(owner.id)) throw new Error("ID が重複しています");
    ids.add(owner.id);
    const folders = new Map(owner.folders.map((folder) => [folder.id, folder]));
    const folderOrders = new Set<number>();
    for (const folder of owner.folders) {
      if (ids.has(folder.id)) throw new Error("ID が重複しています");
      ids.add(folder.id);
      if (folderOrders.has(folder.order))
        throw new Error("フォルダーの order が重複しています");
      folderOrders.add(folder.order);
      const visited = new Set<string>();
      let current: LayerFolder | undefined = folder;
      while (current) {
        if (visited.has(current.id))
          throw new Error("フォルダーの親に循環があります");
        visited.add(current.id);
        if (visited.size > MAX_FOLDER_DEPTH)
          throw new Error("フォルダーの階層は16段までです");
        const parentId: string | undefined = current.parentId;
        if (parentId && !folders.has(parentId))
          throw new Error("同じ所有先の親フォルダーが見つかりません");
        current = parentId ? folders.get(parentId) : undefined;
      }
    }
    const orders = new Set<number>();
    for (const object of owner.objects) {
      if (object.folderId && !folders.has(object.folderId))
        throw new Error("同じ所有先の所属フォルダーが見つかりません");
      const shape = object.shape;
      if (shape.type === "image")
        imageCropViewBox(
          project.assets.find((a) => a.id === shape.assetId)!,
          shape.crop,
        );
      if (
        (shape.type === "rectangle" || shape.type === "ellipse") &&
        shape.paint.fill.paint.type === "pattern"
      ) {
        const pattern = shape.paint.fill.paint;
        patternGeometry(pattern.kind, pattern.spacing, pattern.size);
      }

      if (
        (shape.type === "rectangle" || shape.type === "ellipse") &&
        "width" in object &&
        shape.paint.fill.paint.type === "linearGradient"
      ) {
        linearGradientEndpoints(
          object.width,
          object.height,
          shape.paint.fill.paint.angle,
        );
      }

      if (
        project.symbols.includes(owner) &&
        shape.type === "text" &&
        shape.binding
      )
        throw new Error("Symbol 定義内の直接タグ割り当てには対応していません");
      if (ids.has(object.id)) throw new Error("ID が重複しています");
      ids.add(object.id);
      if (!Number.isSafeInteger(object.order))
        throw new Error("order is out of range");
      if (orders.has(object.order))
        throw new Error("同一定義内の order が重複しています");
      orders.add(object.order);
      if (shape.type === "symbol" && !symbolIds.has(shape.symbolId))
        throw new Error("Symbol 定義が見つかりません");
      if (
        shape.type === "polyline" &&
        shape.points.every(
          (p) => p.x === shape.points[0].x && p.y === shape.points[0].y,
        )
      )
        throw new Error("線には異なる2点が必要です");
    }
  }
  for (const screen of project.screens) validateGroups(screen, ids);
  validateEquipment(project, ids);
  projectScreenReferences(project);
  return project;
}
export function serializeProject(project: Project): string {
  const json = JSON.stringify(project, null, 2) + "\n";
  parseProject(json);
  return json;
}
export function getLayoutBounds(object: ScreenObject) {
  if ("width" in object)
    return { x: 0, y: 0, width: object.width, height: object.height };
  const xs = object.shape.points.map((p) => p.x),
    ys = object.shape.points.map((p) => p.y);
  const pad =
    object.shape.arrow === "end"
      ? Math.max(8, object.shape.strokeWidth * 3)
      : object.shape.strokeWidth / 2;
  return {
    x: Math.min(...xs) - pad,
    y: Math.min(...ys) - pad,
    width: Math.max(...xs) - Math.min(...xs) + 2 * pad,
    height: Math.max(...ys) - Math.min(...ys) + 2 * pad,
  };
}
/** Painted outline, used by selection, alignment, range and placement anchors. */
export function getLocalBounds(object: ScreenObject) {
  const bounds = getLayoutBounds(object);
  const pad =
    object.shape.type === "rectangle" || object.shape.type === "ellipse"
      ? (object.shape.paint.stroke?.width ?? 0) / 2
      : 0;
  return {
    x: bounds.x - pad,
    y: bounds.y - pad,
    width: bounds.width + 2 * pad,
    height: bounds.height + 2 * pad,
  };
}
export function getBounds(object: ScreenObject) {
  return rotatedBounds(
    getLocalBounds(object),
    rotationPivot(object),
    object.rotation,
  );
}
export function strokeOverflowIds(
  owner: Pick<Screen, "width" | "height" | "objects">,
): string[] {
  return owner.objects
    .filter((object) => {
      if (
        object.visible === false ||
        (object.shape.type !== "rectangle" &&
          object.shape.type !== "ellipse") ||
        !object.shape.paint.stroke
      )
        return false;
      const bounds = getBounds(object);
      return (
        object.x + bounds.x < 0 ||
        object.y + bounds.y < 0 ||
        object.x + bounds.x + bounds.width > owner.width ||
        object.y + bounds.y + bounds.height > owner.height
      );
    })
    .map((object) => object.id);
}
export function parsePoints(text: string): Point[] {
  return text
    .trim()
    .split(/\n/)
    .map((line) => {
      const parts = line
        .trim()
        .split(",")
        .map((p) => p.trim());
      if (
        parts.length !== 2 ||
        parts.some((p) => p === "") ||
        parts.some((p) => !Number.isFinite(Number(p)))
      )
        throw new Error("頂点は1行に x,y の形式で入力してください");
      return { x: Number(parts[0]), y: Number(parts[1]) };
    });
}

/** All current image references. History retains its own project declarations. */
export function referencedAssets(project: Project): Set<string> {
  return new Set(
    project.screens.flatMap((screen) => [
      ...(screen.backgroundImage ? [screen.backgroundImage.assetId] : []),
      ...screen.objects.flatMap((object) =>
        object.shape.type === "image" ? [object.shape.assetId] : [],
      ),
    ]),
  );
}

/** The fill paint is the sole color source for rectangle/ellipse. Other objects keep their own monochrome color. */
export function paintBaseColor(paint: FillPaint): PaintColor {
  return paint.type === "solid"
    ? paint
    : paint.type === "linearGradient"
      ? paint.start
      : paint.foreground;
}
export function placementColor(object: ScreenObject): string {
  if (object.shape.type === "rectangle" || object.shape.type === "ellipse") {
    const paint = object.shape.paint.fill.paint;
    return paintBaseColor(paint).color;
  }
  return object.fill!;
}
