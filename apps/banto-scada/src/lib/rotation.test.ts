import { expect, it } from "vitest";
import { vertexPosition } from "./snap";
import { handlePoint, resizeGeometry, type ResizeHandle } from "./resize";
import {
  moveRotatedVertex,
  normalizeRotation,
  objectToWorld,
  resizeRotated,
  rotatedBounds,
  rotatePoint,
  rotateVector,
  rotationMatrix,
  rotationPivot,
  worldToObject,
} from "./rotation";
const near = (
  actual: { x: number; y: number },
  expected: { x: number; y: number },
) => {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
};
it("normalizes UI angles and computes exact cardinal transforms", () => {
  expect([0, -0, -90, 450, -720].map(normalizeRotation)).toEqual([
    0, 0, 270, 90, 0,
  ]);
  expect(rotationMatrix(270)).toEqual({ cos: 0, sin: -1 });
  expect(rotateVector({ x: 20, y: 10 }, 90)).toEqual({ x: -10, y: 20 });
  let point = { x: 125, y: -50 };
  for (let i = 0; i < 4; i++) point = rotatePoint(point, { x: 10, y: 15 }, 90);
  expect(point).toEqual({ x: 125, y: -50 });
  for (const value of [Infinity, -Infinity, NaN])
    expect(() => normalizeRotation(value)).toThrow();
});
it("uses geometry rather than line paint for pivots, and supports general local origins", () => {
  const line = {
    x: 10,
    y: 20,
    rotation: 33,
    shape: {
      points: [
        { x: -50, y: 20 },
        { x: 150, y: 80 },
      ],
    },
  };
  expect(rotationPivot(line)).toEqual({ x: 50, y: 50 });
  const point = { x: -18, y: 37 };
  near(worldToObject(line, objectToWorld(line, point)), point);
  expect(
    rotationPivot({ x: -500, y: 20, width: 200, height: 80, rotation: 145 }),
  ).toEqual({ x: 100, y: 40 });
});
it("rotates conservative paint bounds without changing the placement origin", () => {
  const bounds = { x: -6, y: -6, width: 212, height: 92 },
    pivot = { x: 100, y: 40 };
  expect(rotatedBounds(bounds, pivot, 0)).toEqual(bounds);
  expect(rotatedBounds(bounds, pivot, 90)).toEqual({
    x: 54,
    y: -66,
    width: 92,
    height: 212,
  });
  const result = rotatedBounds(bounds, pivot, 33);
  for (const corner of [
    { x: -6, y: -6 },
    { x: 206, y: -6 },
    { x: 206, y: 86 },
    { x: -6, y: 86 },
  ]) {
    const point = rotatePoint(corner, pivot, 33);
    expect(point.x).toBeGreaterThanOrEqual(result.x - 1e-9);
    expect(point.x).toBeLessThanOrEqual(result.x + result.width + 1e-9);
    expect(point.y).toBeGreaterThanOrEqual(result.y - 1e-9);
    expect(point.y).toBeLessThanOrEqual(result.y + result.height + 1e-9);
  }
});
const opposites: Record<ResizeHandle, ResizeHandle> = {
  nw: "se",
  n: "s",
  ne: "sw",
  e: "w",
  se: "nw",
  s: "n",
  sw: "ne",
  w: "e",
};
function worldHandle(
  object: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
  },
  handle: ResizeHandle,
) {
  const point = handlePoint(object, handle);
  return objectToWorld(object, {
    x: point.x - object.x,
    y: point.y - object.y,
  });
}
for (const rotation of [0, 90, 180, 270, 33])
  it(`resize preserves the opposite edge and minimum size at ${rotation} degrees`, () => {
    const original = { x: -125.5, y: 40.75, width: 200, height: 80, rotation };
    for (const handle of Object.keys(opposites) as ResizeHandle[]) {
      for (const delta of [
        { x: 20, y: 40 },
        { x: -500, y: -500 },
      ]) {
        const geometry = resizeRotated(original, handle, delta, null);
        expect(geometry.width).toBeGreaterThanOrEqual(1);
        expect(geometry.height).toBeGreaterThanOrEqual(1);
        near(
          worldHandle({ ...geometry, rotation }, opposites[handle]),
          worldHandle(original, opposites[handle]),
        );
      }
    }
  });
it("keeps the existing zero-angle snap and rounding semantics", () => {
  const object = { x: 125.51, y: 40.75, width: 200, height: 80, rotation: 0 };
  for (const step of [null, 10])
    for (const handle of Object.keys(opposites) as ResizeHandle[]) {
      expect(resizeRotated(object, handle, { x: 12.111, y: 0 }, step)).toEqual(
        resizeGeometry(object, handle, { x: 12.111, y: 0 }, step),
      );
    }
});
it("snaps rotated corners in owner coordinates without a second rounding", () => {
  const object = { x: 125.5, y: 40.75, width: 200, height: 80, rotation: 33 };
  const start = worldHandle(object, "se");
  const geometry = resizeRotated(object, "se", { x: 15, y: 20 }, 10);
  near(worldHandle({ ...geometry, rotation: 33 }, "se"), {
    x: Math.round((start.x + 15) / 10) * 10,
    y: Math.round((start.y + 20) / 10) * 10,
  });
});
it("projects edge motion to its normal and snaps the dominant owner axis", () => {
  for (const rotation of [33, 90, 135, 270]) {
    const object = { x: 125.5, y: 40.75, width: 200, height: 80, rotation };
    const geometry = resizeRotated(object, "e", { x: 15, y: 20 }, 10);
    const normal = rotateVector({ x: 1, y: 0 }, rotation),
      axis = Math.abs(normal.x) >= Math.abs(normal.y) ? "x" : "y";
    const point = worldHandle({ ...geometry, rotation }, "e");
    expect(point[axis] / 10).toBeCloseTo(Math.round(point[axis] / 10), 9);
    near(worldHandle({ ...geometry, rotation }, "w"), worldHandle(object, "w"));
  }
  const object = { x: 125.5, y: 40.75, width: 200, height: 80, rotation: 90 };
  expect(resizeRotated(object, "e", { x: 10, y: 0 }, 10)).toEqual({
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
  });
});
for (const rotation of [0, 90, 33, 270])
  it(`vertex edit preserves unedited owner-space points at ${rotation} degrees`, () => {
    const original = {
      x: -30,
      y: 125,
      rotation,
      shape: {
        points: [
          { x: -100, y: 0 },
          { x: 0, y: 50 },
          { x: 200, y: 30 },
        ],
      },
    };
    const start = objectToWorld(original, original.shape.points[0]);
    const geometry = moveRotatedVertex(original, 0, { x: -55, y: 25 }, 10);
    const updated = {
      ...geometry,
      rotation,
      shape: { points: geometry.points },
    };
    near(objectToWorld(updated, geometry.points[0]), {
      x: Math.round((start.x - 55) / 10) * 10,
      y: Math.round((start.y + 25) / 10) * 10,
    });
    for (let i = 1; i < 3; i++)
      near(
        objectToWorld(updated, geometry.points[i]),
        objectToWorld(original, original.shape.points[i]),
      );
    expect(original.shape.points[0]).toEqual({ x: -100, y: 0 });
  });
it("no-op vertex edits preserve all values without quantization", () => {
  const original = {
    x: 125.512345,
    y: -23.987654,
    rotation: 33,
    shape: {
      points: [
        { x: 0.123456, y: 0.654321 },
        { x: 20, y: 30 },
      ],
    },
  };
  expect(moveRotatedVertex(original, 0, { x: 0, y: 0 }, 10)).toEqual({
    x: original.x,
    y: original.y,
    points: original.shape.points,
  });
  expect(() =>
    moveRotatedVertex(original, 100, { x: 1, y: 0 }, null),
  ).toThrow();
  expect(() =>
    resizeRotated(
      { ...original, width: 50, height: 20 },
      "se",
      { x: Infinity, y: 0 },
      null,
    ),
  ).toThrow();
});

it("zero angle avoids cancellation of small coordinates against a very large pivot", () => {
  expect(
    rotatePoint({ x: 0.123456, y: -0.123456 }, { x: 1e15, y: 1e15 }, 0),
  ).toEqual({ x: 0.123456, y: -0.123456 });
  const original = {
    x: 0.123456,
    y: 0.654321,
    rotation: 0,
    shape: {
      points: [
        { x: 0, y: 0 },
        { x: 1e15, y: 1e15 },
      ],
    },
  };
  const changed = moveRotatedVertex(original, 0, { x: 10, y: 0 }, null);
  expect(changed.x).toBe(original.x);
  expect(changed.y).toBe(original.y);
});

it("tiny negative angles never normalize to the excluded 360 endpoint", () => {
  expect(normalizeRotation(-Number.MIN_VALUE)).toBe(0);
  expect(normalizeRotation(-1e-15)).toBe(0);
});
it("zero-angle vertex pointers match existing dead zone, delta rounding and both-axis snap", () => {
  const original = {
    x: 125.512345,
    y: 10.987654,
    rotation: 0,
    shape: {
      points: [
        { x: 0.123456, y: 0.654321 },
        { x: 200, y: 80 },
      ],
    },
  };
  for (const delta of [
    { x: 0.1, y: 0.1 },
    { x: 12.1234, y: 0 },
    { x: 0, y: 12.1234 },
  ])
    for (const step of [null, 10]) {
      const result = moveRotatedVertex(original, 0, delta, step);
      expect(result.x).toBe(original.x);
      expect(result.y).toBe(original.y);
      expect(result.points[0]).toEqual(
        vertexPosition(original, original.shape.points[0], delta, step),
      );
    }
});
