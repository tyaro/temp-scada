import type { ScreenObject } from "../project";
export type NumericProperty = "x" | "y" | "width" | "height" | "strokeWidth";
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
    x: String(object.x),
    y: String(object.y),
    fill: object.fill,
  };
  if ("width" in object) {
    values.width = String(object.width);
    values.height = String(object.height);
  }
  if (object.shape.type === "text") {
    values.text = object.shape.text;
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
  }
  return values;
}
