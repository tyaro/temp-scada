import type { ScreenObject } from "../project";
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
    fill: object.fill,
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
    if (!definition)
      values.externalName = object.shape.binding?.externalName ?? "";
  }
  if (object.shape.type === "symbol") values.symbolId = object.shape.symbolId;
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
