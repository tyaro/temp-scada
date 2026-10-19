/** Local screen coordinates: 0 degrees = left to right, 90 = top to bottom. */
export function normalizeGradientAngle(angle: number): number {
  if (typeof angle !== "number" || !Number.isFinite(angle))
    throw new Error("グラデーションの角度は有限の数値で入力してください。");
  return ((angle % 360) + 360) % 360;
}
/** Project the rectangle's corners onto a unit direction, preserving angle on non-square shapes. */
export function linearGradientEndpoints(
  width: number,
  height: number,
  angle: number,
) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error(
      "グラデーションの幅・高さは0より大きい有限の数値にしてください。",
    );
  const radians = (normalizeGradientAngle(angle) * Math.PI) / 180;
  const clean = (value: number) => (Math.abs(value) < 1e-12 ? 0 : value);
  const ux = clean(Math.cos(radians)),
    uy = clean(Math.sin(radians));
  // Divide before summing to avoid avoidable overflow for large, finite dimensions.
  const half = (width / 2) * Math.abs(ux) + (height / 2) * Math.abs(uy);
  const dx = half * ux,
    dy = half * uy;
  const result = {
    x1: width / 2 - dx,
    y1: height / 2 - dy,
    x2: width / 2 + dx,
    y2: height / 2 + dy,
  };
  if (Object.values(result).some((value) => !Number.isFinite(value)))
    throw new Error("グラデーションの描画座標が有限の範囲を超えています。");
  return result;
}
