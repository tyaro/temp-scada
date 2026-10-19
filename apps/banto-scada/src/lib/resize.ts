import type { Point } from "./project";
import { snapCoordinate } from "./snap";
export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}
export const resizeHandles = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
] as const;
export type ResizeHandle = (typeof resizeHandles)[number];
/** 対辺を固定し、操作する辺だけを画面座標で吸着する。反転はせず最小 1 unit。 */
export function resizeGeometry(
  original: Geometry,
  handle: ResizeHandle,
  delta: Point,
  step: number | null,
  roundUnsnapped = true,
): Geometry {
  if (
    ![
      original.x,
      original.y,
      original.width,
      original.height,
      delta.x,
      delta.y,
    ].every(Number.isFinite) ||
    original.width <= 0 ||
    original.height <= 0
  )
    throw new Error("サイズ変更には有限の座標と正のサイズが必要です");
  if (delta.x === 0 && delta.y === 0) return { ...original };
  const coordinate = (value: number) =>
    step === null
      ? roundUnsnapped
        ? Math.round(value * 100) / 100
        : value
      : snapCoordinate(value, step);
  let left = original.x,
    top = original.y,
    right = left + original.width,
    bottom = top + original.height;
  if (handle.includes("w") && delta.x !== 0)
    left = Math.min(right - 1, coordinate(left + delta.x));
  if (handle.includes("e") && delta.x !== 0)
    right = Math.max(left + 1, coordinate(right + delta.x));
  if (handle.includes("n") && delta.y !== 0)
    top = Math.min(bottom - 1, coordinate(top + delta.y));
  if (handle.includes("s") && delta.y !== 0)
    bottom = Math.max(top + 1, coordinate(bottom + delta.y));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
export function handlePoint(g: Geometry, handle: ResizeHandle): Point {
  return {
    x:
      g.x +
      (handle.includes("w") ? 0 : handle.includes("e") ? g.width : g.width / 2),
    y:
      g.y +
      (handle.includes("n")
        ? 0
        : handle.includes("s")
          ? g.height
          : g.height / 2),
  };
}
