import { getBounds, type Point, type ScreenObject } from "./project";
import { nextGridCoordinate } from "./snap";
/** Move the entire selection from a stable top/left anchor, preserving relative positions. */
export function selectionNudge(
  objects: ScreenObject[],
  direction: Point,
  grid: number | null,
  large = false,
): Point {
  if (
    !objects.length ||
    ![direction.x, direction.y].every((n) => [-1, 0, 1].includes(n)) ||
    Math.abs(direction.x) + Math.abs(direction.y) !== 1
  )
    throw new Error("方向キーには図形と単一の移動軸が必要です");
  const anchor = {
    x: Math.min(...objects.map((o) => o.x + getBounds(o).x)),
    y: Math.min(...objects.map((o) => o.y + getBounds(o).y)),
  };
  const count = large ? 10 : 1;
  function delta(value: number, axis: number) {
    if (!axis) return 0;
    if (grid === null) return axis * count;
    const ratio = value / grid,
      nearest = Math.round(ratio);
    const aligned = Math.abs(ratio - nearest) < 1e-9 ? nearest * grid : value;
    return (
      nextGridCoordinate(aligned, axis, grid) -
      value +
      axis * (count - 1) * grid
    );
  }
  return { x: delta(anchor.x, direction.x), y: delta(anchor.y, direction.y) };
}
