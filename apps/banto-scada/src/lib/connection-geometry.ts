import {
  validatePolygonPoints,
  type LayoutObject,
  type Point,
  type PolylineObject,
  type ScreenObject,
} from "./project";
import {
  objectToWorld,
  worldToObject,
  rotationPivot,
  placementVector,
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
/** 接続先にできる配置の種類（Symbol と面の図形）。Rust の `connections.rs` と同じ集合。 */
export const CONNECTION_TARGET_TYPES = [
  "symbol",
  "rectangle",
  "ellipse",
  "polygon",
] as const;
export type ConnectionTargetType = (typeof CONNECTION_TARGET_TYPES)[number];
/** 接続先にできる配置かどうかの唯一の判定。 */
export function isConnectionTarget(
  object: ScreenObject,
): object is LayoutObject & { shape: { type: ConnectionTargetType } } {
  return (
    "width" in object &&
    (CONNECTION_TARGET_TYPES as readonly string[]).includes(object.shape.type)
  );
}

/**
 * 多角形の辺の anchor（割合の空間）。枠の中央を通る中心線（`top`・`bottom` は `u = 0.5`、
 * `left`・`right` は `v = 0.5`）と外周の交点のうち、その辺に最も近い点。閉区間を厳密に比べ、
 * 許容誤差は使わない。辺が中心線に重なるときは両端を交点に数える。Rust の
 * `polygon_anchor_ratio` と同じ順序・同じ式。前提を満たさない頂点は例外を投げる。
 */
export function polygonAnchorRatio(
  points: readonly Point[],
  anchor: Exclude<ConnectionAnchor, "center">,
): Point {
  validatePolygonPoints(points);
  const vertical = anchor === "top" || anchor === "bottom";
  // 縦の中心線では a = u・b = v、横の中心線では入れ替える。
  const along = (p: Point) => (vertical ? p.x : p.y);
  const across = (p: Point) => (vertical ? p.y : p.x);
  const hits: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    const aa = along(a),
      ba = along(b);
    if (!(Math.min(aa, ba) <= 0.5 && 0.5 <= Math.max(aa, ba))) continue;
    if (aa === ba) hits.push(across(a), across(b));
    else {
      const t = (0.5 - aa) / (ba - aa);
      hits.push(across(a) + t * (across(b) - across(a)));
    }
  }
  if (!hits.length) throw new Error("多角形の中心線が外周と交わりません");
  const pick = anchor === "top" || anchor === "left" ? Math.min : Math.max;
  const value = pick(...hits);
  return vertical ? { x: 0.5, y: value } : { x: value, y: 0.5 };
}

/**
 * 接続先の anchor の world 座標。Symbol・矩形・楕円は枠の辺の中央・中心、多角形の辺は
 * `polygonAnchorRatio`。Symbol の絵柄・contain の余白・枠線の幅・文字からは求めない。
 */
export function connectionAnchorPoint(
  object: LayoutObject,
  anchor: ConnectionAnchor,
): Point {
  if (!isConnectionTarget(object))
    throw new Error(
      "接続先はSymbol配置・矩形・楕円・多角形のいずれかを指定してください",
    );
  finitePoint(object);
  if (
    ![object.width, object.height, object.rotation].every(Number.isFinite) ||
    object.width <= 0 ||
    object.height <= 0
  )
    throw new Error("接続先の幅・高さ・角度が不正です");
  const { width, height } = object;
  let local: Point;
  if (
    object.shape.type === "polygon" &&
    (anchor === "top" ||
      anchor === "right" ||
      anchor === "bottom" ||
      anchor === "left")
  ) {
    const ratio = polygonAnchorRatio(object.shape.points, anchor);
    local = { x: ratio.x * width, y: ratio.y * height };
  } else
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
  const rotated = placementVector(original, delta);
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
