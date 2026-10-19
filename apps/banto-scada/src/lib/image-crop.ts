import { IMAGE_SIDE_LIMIT } from "./image-assets";

/** Fractions of the EXIF-oriented display image, before placement rotation. */
export interface ImageCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ImageExtent {
  width: number;
  height: number;
}
/** Only compensates floating-point arithmetic, never a user-visible overshoot. */
export const IMAGE_CROP_EPSILON = 16 * Number.EPSILON;

/** Source-pixel viewBox; callers must also clip to this rectangle. */
export function imageCropViewBox(
  source: ImageExtent,
  crop?: ImageCrop,
): ImageCrop {
  if (
    !Number.isInteger(source.width) ||
    !Number.isInteger(source.height) ||
    source.width < 1 ||
    source.height < 1 ||
    source.width > IMAGE_SIDE_LIMIT ||
    source.height > IMAGE_SIDE_LIMIT
  )
    throw new Error("トリミング元の画像寸法が不正です。");
  if (!crop) return { x: 0, y: 0, ...source };
  const { x, y, width, height } = crop;
  if (
    ![x, y, width, height].every(Number.isFinite) ||
    x < 0 ||
    y < 0 ||
    x > 1 ||
    y > 1 ||
    width <= 0 ||
    height <= 0 ||
    width > 1 ||
    height > 1 ||
    x + width > 1 + IMAGE_CROP_EPSILON ||
    y + height > 1 + IMAGE_CROP_EPSILON
  )
    throw new Error("切出し範囲は画像の内側へ正の幅・高さで指定してください。");
  // Clamp only the accepted roundoff at the right/bottom boundary.
  const result = {
    x: x * source.width,
    y: y * source.height,
    width: Math.min(width, 1 - x) * source.width,
    height: Math.min(height, 1 - y) * source.height,
  };
  if (
    result.width < 1 - IMAGE_CROP_EPSILON * source.width ||
    result.height < 1 - IMAGE_CROP_EPSILON * source.height
  )
    throw new Error("切出し幅・高さは元画像の1画素以上にしてください。");
  return result;
}

/** Full source is represented by absence. Does not mutate the caller's draft. */
export function normalizeImageCrop(
  source: ImageExtent,
  crop?: ImageCrop,
): ImageCrop | undefined {
  const box = imageCropViewBox(source, crop);
  if (
    box.x === 0 &&
    box.y === 0 &&
    box.width === source.width &&
    box.height === source.height
  )
    return undefined;
  if (!crop) return undefined;
  return {
    x: crop.x,
    y: crop.y,
    width: Math.min(crop.width, 1 - crop.x),
    height: Math.min(crop.height, 1 - crop.y),
  };
}
