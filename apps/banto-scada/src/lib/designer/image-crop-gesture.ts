import {
  imageCropViewBox,
  IMAGE_CROP_EPSILON,
  type ImageCrop,
  type ImageExtent,
} from "../image-crop";

export type CropHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
export type CropGestureMode = CropHandle | "move" | "draw";
export interface CropPoint {
  x: number;
  y: number;
}
/** Pixel aspect ratio of the oriented source region, not its normalized fractions. */
export function cropAspect(source: ImageExtent, crop?: ImageCrop): number {
  const box = imageCropViewBox(source, crop);
  return box.width / box.height;
}

function normalizedAspect(source: ImageExtent, aspect: number): number {
  imageCropViewBox(source);
  const min = 1 / source.height,
    max = source.width;
  const tolerance = IMAGE_CROP_EPSILON * Math.max(source.width, source.height);
  if (
    !Number.isFinite(aspect) ||
    aspect < min * (1 - tolerance) ||
    aspect > max * (1 + tolerance)
  )
    throw new Error("縦横比は原本内で両辺1画素以上になる値にしてください。");
  return (Math.max(min, Math.min(max, aspect)) * source.height) / source.width;
}

/** Numeric edits keep the top-left and reject overshoots rather than erasing raw input. */
export function cropWithAspect(
  source: ImageExtent,
  crop: ImageCrop,
  aspect: number,
  axis: "width" | "height",
): ImageCrop {
  const ratio = normalizedAspect(source, aspect);
  const next = {
    ...crop,
    width: axis === "height" ? crop.height * ratio : crop.width,
    height: axis === "width" ? crop.width / ratio : crop.height,
  };
  imageCropViewBox(source, next);
  return next;
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
  aspect?: number,
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
  if (aspect !== undefined) {
    const ratio = normalizedAspect(source, aspect);
    const minWidth = Math.max(minW, minH * ratio);
    if (mode === "draw") {
      const sx = dx < 0 ? -1 : 1,
        sy = dy < 0 ? -1 : 1;
      const ax = clamp(
          start.x,
          sx > 0 ? 0 : minWidth,
          sx > 0 ? 1 - minWidth : 1,
        ),
        ay = clamp(
          start.y,
          sy > 0 ? 0 : minWidth / ratio,
          sy > 0 ? 1 - minWidth / ratio : 1,
        );
      const maxWidth = Math.min(
        sx > 0 ? 1 - ax : ax,
        (sy > 0 ? 1 - ay : ay) * ratio,
      );
      const width = clamp(
        Math.max(Math.abs(end.x - ax), Math.abs(end.y - ay) * ratio),
        minWidth,
        maxWidth,
      );
      const height = width / ratio;
      return {
        x: sx > 0 ? ax : ax - width,
        y: sy > 0 ? ay : ay - height,
        width,
        height,
      };
    }
    const horizontal = mode.includes("w") || mode.includes("e"),
      vertical = mode.includes("n") || mode.includes("s");
    const anchorX =
        before.x +
        before.width * (mode.includes("w") ? 1 : mode.includes("e") ? 0 : 0.5),
      anchorY =
        before.y +
        before.height * (mode.includes("n") ? 1 : mode.includes("s") ? 0 : 0.5);
    const deltaWidth = dx * (mode.includes("w") ? -1 : 1),
      deltaHeightWidth = dy * ratio * (mode.includes("n") ? -1 : 1);
    const delta =
      horizontal &&
      (!vertical || Math.abs(deltaWidth) >= Math.abs(deltaHeightWidth))
        ? deltaWidth
        : deltaHeightWidth;
    const maxWidth = Math.min(
      horizontal
        ? mode.includes("w")
          ? anchorX
          : 1 - anchorX
        : 2 * Math.min(anchorX, 1 - anchorX),
      (vertical
        ? mode.includes("n")
          ? anchorY
          : 1 - anchorY
        : 2 * Math.min(anchorY, 1 - anchorY)) * ratio,
    );
    const width = clamp(before.width + delta, minWidth, maxWidth),
      height = width / ratio;
    return {
      x:
        anchorX -
        width * (mode.includes("w") ? 1 : mode.includes("e") ? 0 : 0.5),
      y:
        anchorY -
        height * (mode.includes("n") ? 1 : mode.includes("s") ? 0 : 0.5),
      width,
      height,
    };
  }
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
