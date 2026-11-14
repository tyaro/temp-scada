import { validateOperatorFrame } from "./operator-frame";
import { validateConnections, type LineConnections } from "./connections";
import { imageAssetReferences } from "./asset-references";
import { normalizeProjectText } from "./text-content";
import { validateStateColors } from "./state-color";
import { validateSymbolSlots } from "./symbol-slots";
import { validateLevelShape } from "./level";
import { validateTableShape } from "./table";
import { validateClockShape } from "./clock-format";
import {
  validateEquipment,
  type EquipmentType,
  type SlotStateLabel,
  type SymbolReadSlot,
  type EquipmentInstance,
} from "./equipment";
import { validateGroups } from "./geometric-groups";
import { projectScreenReferences } from "./screen-references";
import { patternGeometry, type PatternKind } from "./pattern-paint";
import { linearGradientEndpoints } from "./linear-gradient";
import type { ImageFit } from "./image-fit";
import { imageCropViewBox, type ImageCrop } from "./image-crop";
import type { ImageMetadata } from "./image-assets";
import { rotatedBounds, rotationPivot } from "./rotation";
import { arrowHeadPoints, arrowSize } from "./line-arrow";
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../../crates/scada-model/schema/project.schema.json";
import legacySchema from "../../../../crates/scada-model/schema/legacy.project.schema.json";
import trendSchema from "../../../../crates/scada-model/schema/trend-definition.schema.json";
import historySchema from "../../../../crates/scada-historian/schema/history-contract.schema.json";
import recordingSchema from "../../../../crates/scada-model/schema/recording-plan.schema.json";
import {
  validateRecordingPlan,
  type DesiredRecordingPlan,
} from "./recording-plan";
import {
  validateTrendDefinitions,
  type TrendDefinition,
} from "./trend-definitions";
export interface Point {
  x: number;
  y: number;
}
interface BaseObject {
  opacity?: number;
  colorAlpha?: number;
  rotation: number;
  /** Mirror around the rotation pivot before rotating; saved only when true. Not for text/trend. */
  flipX?: boolean;
  flipY?: boolean;
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
export interface StateColor {
  textId: string;
}
/**
 * A slot-bound Text follows the state colors of its equipment-type slot
 * definition. Only the color for an unknown state is stored here.
 */
export interface StateTextColors {
  unknownColor: string;
}
/**
 * A screen-level Text bound to a bit tag shows the bool as these labels. The
 * form of `true` / `false` follows an equipment-type bool slot's `boolDisplay`;
 * `unknownColor` is used for every reading that is not a Good bool.
 */
export interface TextBoolDisplay {
  true: SlotStateLabel;
  false: SlotStateLabel;
  unknownColor: string;
}
export interface TagBinding {
  externalName: string;
}
/**
 * How a tag- or slot-bound Text shows a Good number. `decimals` rounds to a
 * fixed number of digits; `unit` is appended after a space. Unavailable
 * readings never show the unit.
 */
export interface NumericFormat {
  decimals?: number;
  unit?: string;
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
      type: "radialGradient";
      center: Point;
      radius: number;
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
  wrap?: "none" | "word";
  fontSize: number;
  fontWeight: "normal" | "bold";
  align: "left" | "center" | "right";
}
export type EquipmentPropertyField = "code" | "name" | "typeName";
/**
 * A bar filled in proportion to a number between `min` and `max`. The fill
 * color is the placement's `fill`; `background` paints the empty part.
 */
export interface LevelShape {
  type: "level";
  direction: "up" | "right";
  min: number;
  max: number;
  background?: string;
  binding?: TagBinding;
  slotBinding?: { slotName: string };
}
/** A table cell: fixed text with an optional fill and text color. */
export interface TableCell {
  text: string;
  fill?: string;
  color?: string;
  /**
   * The tag the cell reads (screen tables only). A bound cell shows the
   * reading with `format` instead of `text`.
   */
  binding?: TagBinding;
  /**
   * The declared read slot the cell shows (tables inside a Symbol definition
   * only; never together with `binding`). Shown like a slot-bound Text.
   */
  slotBinding?: { slotName: string };
  /** State text colors (a cell bound to a bool or state slot only). */
  stateColors?: StateTextColors;
  /** Numeric format; requires `binding` or `slotBinding`. */
  format?: NumericFormat;
}
/**
 * A grid of fixed-text cells. `columns` and `rows` are relative weights that
 * divide the placement's width and height; `cells` is rows x columns. The
 * text color is the placement's `fill` unless a cell has its own `color`.
 */
export interface TableShape {
  type: "table";
  columns: number[];
  rows: number[];
  cells: TableCell[][];
  style: Pick<TextStyle, "fontSize" | "fontWeight" | "align">;
  border?: { color: string; width: number };
  background?: string;
}
/** 画面切替ボタンの行き先。仕様: docs/design/graphics/nav-button.md */
export type NavTarget =
  { kind: "screen"; screenId: string } | { kind: "back" } | { kind: "forward" };
/**
 * 画面切替ボタン。画面の直下にだけ置ける（Symbol 定義には置かない）。
 * `target` が無いボタンは「行き先未設定」で、押しても何もしない。
 */
export interface NavButtonShape {
  type: "navButton";
  target?: NavTarget;
  label: string;
  fontSize: number;
  fill: string;
  textColor: string;
  /** 行き先が表示中の画面のときの塗り。無いときは `fill`。 */
  currentFill?: string;
  /** 行き先が表示中の画面のときの文字色。無いときは `textColor`。 */
  currentTextColor?: string;
}
/** What a clock shows: the date, the time of day, or both. */
export type ClockFormat = "date" | "time" | "dateTime";
/**
 * The terminal's current date and time as text. The text color is the
 * placement's `fill`. `seconds` is stored only when true and applies to the
 * time part.
 */
export interface ClockShape {
  type: "clock";
  format: ClockFormat;
  seconds?: true;
  style: Pick<TextStyle, "fontSize" | "fontWeight" | "align">;
}
export type SymbolColorMode = "monochrome" | "definition";
export interface LayoutObject extends BaseObject {
  width: number;
  height: number;
  shape:
    | { type: "rectangle"; paint: ShapePaint; stateColor?: StateColor }
    | { type: "ellipse"; paint: ShapePaint; stateColor?: StateColor }
    | {
        type: "text";
        text: string;
        style: TextStyle;
        binding?: TagBinding;
        slotBinding?: { slotName: string };
        equipmentProperty?: { field: EquipmentPropertyField };
        stateColors?: StateTextColors;
        format?: NumericFormat;
        boolDisplay?: TextBoolDisplay;
      }
    | {
        type: "symbol";
        symbolId: string;
        equipmentId?: string;
        colorMode: SymbolColorMode;
      }
    | { type: "image"; assetId: string; fit: ImageFit; crop?: ImageCrop }
    | { type: "screenView"; screenId: string; fit: "contain" }
    | { type: "trend"; trendId: string }
    | LevelShape
    | TableShape
    | ClockShape
    | NavButtonShape;
}
export interface PolylineObject extends BaseObject {
  shape: {
    type: "polyline";
    connections?: LineConnections;
    stateColor?: StateColor;
    points: Point[];
    strokeWidth: number;
    lineStyle?: LineStyle;
    arrow: LineArrow;
  };
}
export type LineArrow = "none" | "start" | "end" | "both";
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
  crop?: ImageCrop;
  fit: "contain" | "cover" | "stretch" | "original";
  opacity: number;
}
export interface GeometricGroup {
  id: string;
  name?: string;
  memberIds: string[];
}
/**
 * 交差のまたぎの形。`"arc"` は弧でまたぎ、下の線（またがれる線）はそのまま描く。
 * `"cut"` は弧を描かず、下の線（またがれる線）を交差点の前後で切る。仕様: docs/design/graphics/line-hop.md
 */
export type LineHopStyle = "arc" | "cut";
export interface Screen {
  groups: GeometricGroup[];
  backgroundImage?: BackgroundImage;
  folders: LayerFolder[];
  background: string;
  /** 画面直下の配管の交差のまたぎの形。無いときはまたがない。 */
  lineHops?: LineHopStyle;
  id: string;
  name: string;
  width: number;
  height: number;
  objects: ScreenObject[];
}
export interface SymbolDefinition {
  readSlots?: SymbolReadSlot[];
  folders: LayerFolder[];
  id: string;
  name: string;
  width: number;
  height: number;
  objects: ScreenObject[];
}
/** 運転表示の枠。中身がすべて空なら保存しない。仕様: docs/design/graphics/operator-frame.md */
export interface OperatorFrame {
  startScreenId?: string;
  headerScreenId?: string;
  footerScreenId?: string;
}
export interface Project {
  operatorFrame?: OperatorFrame;
  recordingPlan?: DesiredRecordingPlan;
  trends?: TrendDefinition[];
  equipmentTypes?: EquipmentType[];
  equipment?: EquipmentInstance[];
  assets: ImageAsset[];
  manifest: {
    product: "banto-scada";
    schemaVersion: "0.37.0";
    projectId: string;
    projectRevision: number;
    minRuntimeVersion: "0.37.0";
    name: string;
  };
  screens: Screen[];
  symbols: SymbolDefinition[];
}
const ajv = new Ajv2020({
  allErrors: true,
  strictNumbers: true,
  allowUnionTypes: true,
})
  .addSchema(historySchema)
  .addSchema(recordingSchema)
  .addSchema(trendSchema);
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
        schemaVersion: "0.37.0",
        minRuntimeVersion: "0.37.0",
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
  normalizeProjectText(value);
  if (!validate(value))
    throw new Error(
      validate.errors
        ?.map((e) => `${e.instancePath || "/"} ${e.message}`)
        .join(" / "),
    );
  const project = value;
  if (
    "recordingPlan" in project &&
    !validateRecordingPlan(project.recordingPlan)
  )
    throw new Error("記録希望設定の形式・重複・予算を確認してください");
  if (
    !validateTrendDefinitions({
      version: 1,
      kind: "trendDefinitions",
      definitions: project.trends ?? [],
    })
  )
    throw new Error("トレンド定義の形式・重複・予算を確認してください");
  const trendIds = new Set((project.trends ?? []).map((row) => row.id));
  for (const owner of [...project.screens, ...project.symbols]) {
    for (const object of owner.objects) {
      if (object.shape.type !== "trend") continue;
      if (!("background" in owner))
        throw new Error("Symbol定義にはトレンドを配置できません");
      if (!trendIds.has(object.shape.trendId))
        throw new Error("トレンドの参照先が見つかりません");
    }
  }
  const screenIds = new Set(project.screens.map((screen) => screen.id));
  for (const screen of project.screens)
    for (const object of screen.objects)
      if (
        object.shape.type === "navButton" &&
        object.shape.target?.kind === "screen" &&
        !screenIds.has(object.shape.target.screenId)
      )
        throw new Error("画面切替ボタンの行き先の画面が見つかりません");
  validateOperatorFrame(project.operatorFrame, project);
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
    if ("backgroundImage" in owner && owner.backgroundImage)
      imageCropViewBox(
        project.assets.find(
          (asset) => asset.id === owner.backgroundImage!.assetId,
        )!,
        owner.backgroundImage.crop,
      );
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
        shape.paint.fill.paint.type === "radialGradient"
      ) {
        const { center, radius } = shape.paint.fill.paint;
        if (
          ![
            object.width * (center.x - radius),
            object.width * (center.x + radius),
            object.height * (center.y - radius),
            object.height * (center.y + radius),
          ].every(Number.isFinite)
        )
          throw new Error(
            "放射グラデーションの描画座標が有限の範囲を超えています。",
          );
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

      if (shape.type === "level") validateLevelShape(shape);
      if (shape.type === "table") validateTableShape(shape);
      if (shape.type === "clock") validateClockShape(shape);
      if (
        project.symbols.includes(owner) &&
        (shape.type === "text" || shape.type === "level") &&
        shape.binding
      )
        throw new Error("Symbol 定義内の直接タグ割り当てには対応していません");
      if (
        project.symbols.includes(owner) &&
        shape.type === "table" &&
        shape.cells.some((row) => row.some((cell) => cell.binding))
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
  validateSymbolSlots(project);
  validateStateColors(project);
  projectScreenReferences(project);
  validateConnections(project);
  return project;
}
export function serializeProject(project: Project): string {
  const json = JSON.stringify(project, null, 2) + "\n";
  const canonical = parseProject(json);
  // Ordinary canonical content keeps the existing one-stringify path. Only input
  // separators (or harmless literal escaped matches) need the normalized output.
  return /\\r|\u2028|\u2029/u.test(json)
    ? JSON.stringify(canonical, null, 2) + "\n"
    : json;
}
export function getLayoutBounds(object: ScreenObject) {
  if ("width" in object)
    return { x: 0, y: 0, width: object.width, height: object.height };
  const xs = object.shape.points.map((p) => p.x),
    ys = object.shape.points.map((p) => p.y);
  const pad =
    object.shape.arrow !== "none"
      ? arrowSize(object.shape.strokeWidth)
      : object.shape.strokeWidth / 2;
  // 斜めの矢印は三角形の頂点が余白（arrowSize）より外へ出るので、頂点も含める。
  const heads = arrowHeadPoints(object.shape).flat(),
    minX = Math.min(Math.min(...xs) - pad, ...heads.map((p) => p.x)),
    minY = Math.min(Math.min(...ys) - pad, ...heads.map((p) => p.y)),
    maxX = Math.max(Math.max(...xs) + pad, ...heads.map((p) => p.x)),
    maxY = Math.max(Math.max(...ys) + pad, ...heads.map((p) => p.y));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
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
    object,
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
    imageAssetReferences(project).map((reference) => reference.assetId),
  );
}

/** The fill paint is the sole color source for rectangle/ellipse. Other objects keep their own monochrome color. */
export function paintBaseColor(paint: FillPaint): PaintColor {
  return paint.type === "solid"
    ? paint
    : paint.type === "linearGradient" || paint.type === "radialGradient"
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
