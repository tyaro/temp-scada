import {
  imageCropViewBox,
  type ImageCrop,
  type ImageExtent,
} from "../image-crop";

export type CropHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
export type CropGestureMode = CropHandle | "move" | "draw";
export interface CropPoint {
  x: number;
  y: number;
}
const clamp = (n: number, min: number, max: number) =>
  Math.max(min, Math.min(max, n));

/** Coordinates are fractions of the oriented source, never the SVG letterbox. */
export function cropGesture(
  source: ImageExtent,
  initial: ImageCrop | undefined,
  mode: CropGestureMode,
  start: CropPoint,
  end: CropPoint,
): ImageCrop {
  imageCropViewBox(source, initial);
  const before = initial ?? { x: 0, y: 0, width: 1, height: 1 };
  const minW = 1 / source.width,
    minH = 1 / source.height;
  const dx = end.x - start.x,
    dy = end.y - start.y;
  if (mode === "move")
    return {
      ...before,
      x: clamp(before.x + dx, 0, 1 - before.width),
      y: clamp(before.y + dy, 0, 1 - before.height),
    };
  if (mode === "draw") {
    const ax = clamp(start.x, 0, 1),
      ay = clamp(start.y, 0, 1);
    const bx = clamp(end.x, 0, 1),
      by = clamp(end.y, 0, 1);
    const x = Math.min(Math.min(ax, bx), 1 - minW);
    const y = Math.min(Math.min(ay, by), 1 - minH);
    return {
      x,
      y,
      width: clamp(Math.abs(bx - ax), minW, 1 - x),
      height: clamp(Math.abs(by - ay), minH, 1 - y),
    };
  }
  let left = before.x,
    top = before.y;
  let right = left + before.width,
    bottom = top + before.height;
  if (mode.includes("w")) left = clamp(left + dx, 0, right - minW);
  if (mode.includes("e")) right = clamp(right + dx, left + minW, 1);
  if (mode.includes("n")) top = clamp(top + dy, 0, bottom - minH);
  if (mode.includes("s")) bottom = clamp(bottom + dy, top + minH, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
