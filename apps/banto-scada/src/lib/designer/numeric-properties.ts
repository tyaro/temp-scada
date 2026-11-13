import { placementColor } from "../project";
import type { ScreenObject } from "../project";
import {
  formatTableColors,
  formatTableFormats,
  formatTableSlots,
  formatTableTags,
  formatTableText,
  formatTableUnknownColors,
  formatTableWeights,
} from "../table";
export type NumericProperty =
  | "colorAlpha"
  | "opacity"
  | "x"
  | "y"
  | "width"
  | "height"
  | "strokeWidth"
  | "rotation"
  | "fontSize";
export interface NumericTarget {
  generation: number;
  screenId: string;
  objectId: string;
  definition: boolean;
}
export function parseNumericProperty(raw: string): number {
  const value = raw.trim();
  if (
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) ||
    !Number.isFinite(Number(value))
  )
    throw new Error("有限の数値を入力してください。");
  return Number(value);
}
/** Model baselines for the persistent object form. User strings live in the draft guard. */
export function objectFormValues(
  object: ScreenObject,
  definition: boolean,
): Record<string, string> {
  const values: Record<string, string> = {
    opacity: String(Number(((object.opacity ?? 1) * 100).toPrecision(15))),
    colorAlpha: String(
      Number(((object.colorAlpha ?? 1) * 100).toPrecision(15)),
    ),
    name: object.name ?? "",
    x: String(object.x),
    y: String(object.y),
    rotation: String(object.rotation),
    ...(object.shape.type === "screenView" ||
    object.shape.type === "trend" ||
    object.shape.type === "navButton"
      ? {}
      : { fill: placementColor(object) }),
  };
  if ("width" in object) {
    values.width = String(object.width);
    values.height = String(object.height);
  }
  if (object.shape.type === "text") {
    values.text = object.shape.text;
    values.fontSize = String(object.shape.style.fontSize);
    values.fontWeight = object.shape.style.fontWeight;
    values.textAlign = object.shape.style.align;
    values.textWrap = object.shape.style.wrap ?? "none";
    if (!definition)
      values.externalName = object.shape.binding?.externalName ?? "";
    else
      values.slotName = object.shape.equipmentProperty
        ? `@${object.shape.equipmentProperty.field}`
        : (object.shape.slotBinding?.slotName ?? "");
  }
  if (object.shape.type === "level") {
    values.levelDirection = object.shape.direction;
    values.levelMin = String(object.shape.min);
    values.levelMax = String(object.shape.max);
    values.levelBackgroundMode = object.shape.background ? "color" : "none";
    values.levelBackground = object.shape.background ?? "#1e293b";
    if (!definition)
      values.externalName = object.shape.binding?.externalName ?? "";
    else values.slotName = object.shape.slotBinding?.slotName ?? "";
  }
  if (object.shape.type === "table") {
    const shape = object.shape;
    values.tableText = formatTableText(shape);
    values.tableColumns = formatTableWeights(shape.columns);
    values.tableRows = formatTableWeights(shape.rows);
    values.tableFills = formatTableColors(shape, "fill");
    values.tableColors = formatTableColors(shape, "color");
    values.tableTags = formatTableTags(shape);
    values.tableFormats = formatTableFormats(shape);
    values.tableSlots = formatTableSlots(shape);
    values.tableUnknownColors = formatTableUnknownColors(shape);
    values.tableFontSize = String(shape.style.fontSize);
    values.tableFontWeight = shape.style.fontWeight;
    values.tableAlign = shape.style.align;
    values.tableBorderMode = shape.border ? "line" : "none";
    values.tableBorderColor = shape.border?.color ?? "#94a3b8";
    values.tableBorderWidth = String(shape.border?.width ?? 1);
    values.tableBackgroundMode = shape.background ? "color" : "none";
    values.tableBackground = shape.background ?? "#0f172a";
  }
  if (object.shape.type === "symbol") {
    values.symbolId = object.shape.symbolId;
    if (!definition) values.equipmentId = object.shape.equipmentId ?? "";
  }
  if (object.shape.type === "screenView")
    values.sourceScreenId = object.shape.screenId;
  if (object.shape.type === "trend") values.trendId = object.shape.trendId;
  if (object.shape.type === "navButton") {
    const { target } = object.shape;
    values.navTarget = !target
      ? ""
      : target.kind === "screen"
        ? `screen:${target.screenId}`
        : target.kind;
    values.navLabel = object.shape.label;
    values.navFontSize = String(object.shape.fontSize);
    values.navFill = object.shape.fill;
    values.navTextColor = object.shape.textColor;
    values.navCurrentMode =
      object.shape.currentFill || object.shape.currentTextColor
        ? "color"
        : "none";
    values.navCurrentFill = object.shape.currentFill ?? object.shape.fill;
    values.navCurrentTextColor =
      object.shape.currentTextColor ?? object.shape.textColor;
  }
  if (object.shape.type === "polyline") {
    values.points = object.shape.points
      .map((point) => `${point.x},${point.y}`)
      .join("\n");
    values.strokeWidth = String(object.shape.strokeWidth);
    values.arrow = object.shape.arrow;
    values.lineStyle = object.shape.lineStyle ?? "solid";
  }
  return values;
}

/**
 * Inspector の位置・サイズ欄の見出し（UX精査 P1-2: 英日混在をやめて日本語に揃える）。
 * accessible はスクリーンリーダー・試験で使う名前。
 */
export function geometryLabel(
  field: string,
  shapeType: string,
): { visible: string; accessible: string } {
  const image = shapeType === "image";
  switch (field) {
    case "x":
      return { visible: "X", accessible: "X" };
    case "y":
      return { visible: "Y", accessible: "Y" };
    case "width":
      return image
        ? { visible: "画像枠の幅", accessible: "画像枠の幅" }
        : { visible: "幅", accessible: "幅" };
    case "height":
      return image
        ? { visible: "画像枠の高さ", accessible: "画像枠の高さ" }
        : { visible: "高さ", accessible: "高さ" };
    case "rotation":
      return { visible: "回転（°）", accessible: "回転角度" };
    case "opacity":
      return { visible: "不透明度（%）", accessible: "不透明度（%）" };
    default:
      return { visible: field, accessible: field };
  }
}
