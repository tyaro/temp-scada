import { getBounds, type Point, type ScreenObject } from "./project";

export function selectionBox(from: Point, to: Point) {
  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}
/** Select complete object bounds, including the existing pipe stroke/arrow margin. */
export function objectsInRange(
  objects: ScreenObject[],
  from: Point,
  to: Point,
): string[] {
  const range = selectionBox(from, to);
  return [...objects]
    .sort((a, b) => a.order - b.order)
    .filter((object) => {
      if (object.locked || object.visible === false) return false;
      const bounds = getBounds(object);
      const x = object.x + bounds.x,
        y = object.y + bounds.y;
      return (
        x >= range.x &&
        y >= range.y &&
        x + bounds.width <= range.x + range.width &&
        y + bounds.height <= range.y + range.height
      );
    })
    .map((object) => object.id);
}
