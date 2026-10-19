import type { Point } from "./project";
import {
  handlePoint,
  resizeGeometry,
  type Geometry,
  type ResizeHandle,
} from "./resize";
import { snapCoordinate, vertexPosition } from "./snap";

type Bounds = Geometry;
type Placement = { x: number; y: number; rotation?: number };
type Layout = Placement & { width: number; height: number };
type Line = Placement & { shape: { points: Point[] } };

export function normalizeRotation(angle: number): number {
  if (!Number.isFinite(angle)) throw new Error("角度には有限の数値が必要です");
  const normalized = angle % 360;
  const positive = normalized < 0 ? normalized + 360 : normalized;
  return positive === 360 ? 0 : positive || 0;
}
export function rotationMatrix(angle: number) {
  const normalized = normalizeRotation(angle);
  if (normalized === 0) return { cos: 1, sin: 0 };
  if (normalized === 90) return { cos: 0, sin: 1 };
  if (normalized === 180) return { cos: -1, sin: 0 };
  if (normalized === 270) return { cos: 0, sin: -1 };
  const radians = (normalized * Math.PI) / 180;
  return { cos: Math.cos(radians), sin: Math.sin(radians) };
}
export function rotateVector(point: Point, angle: number): Point {
  const { cos, sin } = rotationMatrix(angle);
  return { x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos };
}
export function rotatePoint(point: Point, pivot: Point, angle: number): Point {
  if (normalizeRotation(angle) === 0) return { ...point };
  const delta = rotateVector(
    { x: point.x - pivot.x, y: point.y - pivot.y },
    angle,
  );
  return { x: pivot.x + delta.x, y: pivot.y + delta.y };
}
export function rotationPivot(object: Layout | Line): Point {
  if ("width" in object) return { x: object.width / 2, y: object.height / 2 };
  const xs = object.shape.points.map((p) => p.x),
    ys = object.shape.points.map((p) => p.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}
export function objectToWorld(object: Layout | Line, point: Point): Point {
  const local = rotatePoint(point, rotationPivot(object), object.rotation ?? 0);
  return { x: object.x + local.x, y: object.y + local.y };
}
export function worldToObject(object: Layout | Line, point: Point): Point {
  return rotatePoint(
    { x: point.x - object.x, y: point.y - object.y },
    rotationPivot(object),
    -(object.rotation ?? 0),
  );
}
/** Rotate the conservative painted rectangle; keep the result local to x/y. */
export function rotatedBounds(
  bounds: Bounds,
  pivot: Point,
  angle: number,
): Bounds {
  if (normalizeRotation(angle) === 0) return { ...bounds };
  const points = [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ].map((point) => rotatePoint(point, pivot, angle));
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/** Own-axis resize, with the opposite edge fixed in the owner's coordinates. */
export function resizeRotated(
  original: Layout,
  handle: ResizeHandle,
  delta: Point,
  step: number | null,
): Geometry {
  const angle = normalizeRotation(original.rotation ?? 0);
  if (!angle) return resizeGeometry(original, handle, delta, step);
  if (![delta.x, delta.y].every(Number.isFinite))
    throw new Error("有限の移動量が必要です");
  if (!delta.x && !delta.y)
    return {
      x: original.x,
      y: original.y,
      width: original.width,
      height: original.height,
    };
  const start = objectToWorld(original, {
    x: handlePoint(original, handle).x - original.x,
    y: handlePoint(original, handle).y - original.y,
  });
  let change = delta;
  if (handle.length === 1) {
    const normal = rotateVector(
      handle === "e" || handle === "w" ? { x: 1, y: 0 } : { x: 0, y: 1 },
      angle,
    );
    let distance = delta.x * normal.x + delta.y * normal.y;
    if (Math.abs(distance) < 1e-12)
      return {
        x: original.x,
        y: original.y,
        width: original.width,
        height: original.height,
      };
    if (step !== null) {
      const axis = Math.abs(normal.x) >= Math.abs(normal.y) ? "x" : "y";
      distance =
        (snapCoordinate(start[axis] + normal[axis] * distance, step) -
          start[axis]) /
        normal[axis];
    }
    change = { x: normal.x * distance, y: normal.y * distance };
  } else if (step !== null)
    change = {
      x: snapCoordinate(start.x + delta.x, step) - start.x,
      y: snapCoordinate(start.y + delta.y, step) - start.y,
    };
  const localDelta = rotateVector(change, -angle);
  const raw = resizeGeometry(original, handle, localDelta, null, false);
  const beforeCenter = {
    x: original.x + original.width / 2,
    y: original.y + original.height / 2,
  };
  const localCenterDelta = {
    x: raw.x + raw.width / 2 - beforeCenter.x,
    y: raw.y + raw.height / 2 - beforeCenter.y,
  };
  const centerDelta = rotateVector(localCenterDelta, angle);
  return {
    x: beforeCenter.x + centerDelta.x - raw.width / 2,
    y: beforeCenter.y + centerDelta.y - raw.height / 2,
    width: raw.width,
    height: raw.height,
  };
}

/** Replace a local vertex and compensate the implicit pivot. Keyboard callers supply their own exact target. */
export function replaceRotatedVertex(
  original: Line,
  index: number,
  point: Point,
): { x: number; y: number; points: Point[] } {
  if (
    !original.shape.points[index] ||
    ![point.x, point.y].every(Number.isFinite)
  )
    throw new Error("頂点と有限の座標が必要です");
  const points = original.shape.points.map((p, i) =>
    i === index ? { ...point } : { ...p },
  );
  const before = rotationPivot(original),
    after = rotationPivot({ ...original, shape: { points } });
  const pivotDelta = { x: before.x - after.x, y: before.y - after.y };
  const rotatedDelta = rotateVector(pivotDelta, original.rotation ?? 0);
  return {
    x: original.x + (pivotDelta.x - rotatedDelta.x),
    y: original.y + (pivotDelta.y - rotatedDelta.y),
    points,
  };
}

/** Pointer drag: preserve the existing dead zone, delta rounding, and two-axis snap. */
export function moveRotatedVertex(
  original: Line,
  index: number,
  delta: Point,
  step: number | null,
): { x: number; y: number; points: Point[] } {
  const vertex = original.shape.points[index];
  if (!vertex || ![delta.x, delta.y].every(Number.isFinite))
    throw new Error("頂点と有限の移動量が必要です");
  if (Math.hypot(delta.x, delta.y) <= 0.5)
    return {
      x: original.x,
      y: original.y,
      points: original.shape.points.map((p) => ({ ...p })),
    };
  if (!normalizeRotation(original.rotation ?? 0))
    return replaceRotatedVertex(
      original,
      index,
      vertexPosition(original, vertex, delta, step),
    );
  const start = objectToWorld(original, vertex);
  const target = vertexPosition({ x: 0, y: 0 }, start, delta, step);
  return replaceRotatedVertex(original, index, worldToObject(original, target));
}
