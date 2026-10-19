import type { ScreenObject } from "./project";
/** Color alpha for compound line/arrow, text and monochrome Symbol is applied after compositing. */
export function compositedOpacity(object: ScreenObject): number | undefined {
  const shape = object.shape;
  const colorAlpha =
    shape.type === "rectangle" ||
    shape.type === "ellipse" ||
    (shape.type === "symbol" && shape.colorMode === "definition")
      ? undefined
      : object.colorAlpha;
  return object.opacity === undefined && colorAlpha === undefined
    ? undefined
    : (object.opacity ?? 1) * (colorAlpha ?? 1);
}
