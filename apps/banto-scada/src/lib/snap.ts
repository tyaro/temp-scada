import type { Point } from "./project";
export function snapCoordinate(value: number, step: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0)
    throw new Error("スナップには有限の座標と正の間隔が必要です");
  return Math.round(value / step) * step || 0;
}
/** 同じ delta を全選択に適用し、グループ内の相対位置を維持する。 */
export function dragOffset(
  anchor: Point,
  delta: Point,
  step: number | null,
): Point {
  if (Math.hypot(delta.x, delta.y) <= 0.5) return { x: 0, y: 0 };
  if (step === null)
    return {
      x: Math.round(delta.x * 100) / 100,
      y: Math.round(delta.y * 100) / 100,
    };
  return {
    x: snapCoordinate(anchor.x + delta.x, step) - anchor.x,
    y: snapCoordinate(anchor.y + delta.y, step) - anchor.y,
  };
}
export function vertexPosition(
  origin: Point,
  start: Point,
  delta: Point,
  step: number | null,
): Point {
  if (Math.hypot(delta.x, delta.y) <= 0.5) return { ...start };
  if (step === null) {
    const d = dragOffset({ x: 0, y: 0 }, delta, null);
    return { x: start.x + d.x, y: start.y + d.y };
  }
  return {
    x: snapCoordinate(origin.x + start.x + delta.x, step) - origin.x,
    y: snapCoordinate(origin.y + start.y + delta.y, step) - origin.y,
  };
}
/** キー操作では現在位置から次のグリッド線へ。操作しない軸は変えない。 */
export function nextGridCoordinate(
  value: number,
  direction: number,
  step: number,
): number {
  snapCoordinate(value, step);
  return (
    (direction > 0
      ? Math.floor(value / step) + 1
      : Math.ceil(value / step) - 1) * step
  );
}
