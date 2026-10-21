import type { LayoutObject, Point, PolylineObject } from "./project";
import {
  objectToWorld,
  worldToObject,
  rotationPivot,
  rotateVector,
} from "./rotation";

export const CONNECTION_ANCHORS = [
  "top",
  "right",
  "bottom",
  "left",
  "center",
] as const;
export type ConnectionAnchor = (typeof CONNECTION_ANCHORS)[number];
/** Absolute world-coordinate tolerance, also used for repeated no-op resolution. */
export const CONNECTION_EPSILON = 1e-7;
function finitePoint(point: Point) {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
    throw new Error("接続点には有限の座標が必要です");
}
export function sameConnectionPoint(left: Point, right: Point): boolean {
  finitePoint(left);
  finitePoint(right);
  return (
    Math.abs(left.x - right.x) <= CONNECTION_EPSILON &&
    Math.abs(left.y - right.y) <= CONNECTION_EPSILON
  );
}
/** Placement-frame anchors, independent of Symbol artwork, contain padding or Equipment. */
export function symbolAnchorPoint(
  object: LayoutObject,
  anchor: ConnectionAnchor,
): Point {
  if (object.shape.type !== "symbol")
    throw new Error("接続先はSymbol配置を指定してください");
  finitePoint(object);
  if (
    ![object.width, object.height, object.rotation].every(Number.isFinite) ||
    object.width <= 0 ||
    object.height <= 0
  )
    throw new Error("接続先の幅・高さ・角度が不正です");
  const { width, height } = object;
  let local: Point;
  switch (anchor) {
    case "top":
      local = { x: width / 2, y: 0 };
      break;
    case "right":
      local = { x: width, y: height / 2 };
      break;
    case "bottom":
      local = { x: width / 2, y: height };
      break;
    case "left":
      local = { x: 0, y: height / 2 };
      break;
    case "center":
      local = { x: width / 2, y: height / 2 };
      break;
    default:
      throw new Error("接続位置が不正です");
  }
  const result = objectToWorld(object, local);
  finitePoint(result);
  return result;
}

/**
 * Resolve both ends against the ORIGINAL line transform in one step. Compensate
 * the changed implicit pivot so every untouched vertex keeps its world position.
 * No snapping, routing, ID lookup, lock decisions or Project mutation happens here.
 */
export function followPolylineEndpoints(
  original: PolylineObject,
  endpoints: { start?: Point; end?: Point },
): PolylineObject {
  finitePoint(original);
  if (
    original.shape.type !== "polyline" ||
    !Number.isFinite(original.rotation) ||
    original.shape.points.length < 2
  )
    throw new Error("接続線には2点以上の折れ線が必要です");
  const points = original.shape.points;
  points.forEach(finitePoint);
  if (points.every((p) => p.x === points[0].x && p.y === points[0].y))
    throw new Error("接続線には異なる2点が必要です");
  const originalWorld = points.map((point) => objectToWorld(original, point));
  originalWorld.forEach(finitePoint);
  const targets = new Map<number, Point>();
  if (endpoints.start) targets.set(0, endpoints.start);
  if (endpoints.end) targets.set(points.length - 1, endpoints.end);
  for (const target of targets.values()) finitePoint(target);
  if (
    [...targets].every(([index, target]) =>
      sameConnectionPoint(originalWorld[index], target),
    )
  )
    return original;
  const nextPoints = points.map((point, index) => {
    const target = targets.get(index);
    return target ? worldToObject(original, target) : { ...point };
  });
  nextPoints.forEach(finitePoint);
  if (
    nextPoints.every((p) => p.x === nextPoints[0].x && p.y === nextPoints[0].y)
  )
    throw new Error("接続線には異なる2点を残してください");
  const before = rotationPivot(original);
  const after = rotationPivot({ ...original, shape: { points: nextPoints } });
  const delta = { x: before.x - after.x, y: before.y - after.y };
  const rotated = rotateVector(delta, original.rotation);
  const result = {
    ...original,
    x: original.x + delta.x - rotated.x,
    y: original.y + delta.y - rotated.y,
    shape: { ...original.shape, points: nextPoints },
  };
  finitePoint(result);
  nextPoints.forEach((point, index) => {
    const expected = targets.get(index) ?? originalWorld[index];
    if (!sameConnectionPoint(objectToWorld(result, point), expected))
      throw new Error("座標の精度不足により接続点・中間点を保持できません");
  });
  return result;
}
