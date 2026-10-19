import { expect, it } from "vitest";
import {
  linearGradientEndpoints as endpoints,
  normalizeGradientAngle as angle,
} from "./linear-gradient";
it("defines horizontal, vertical and reverse directions in local coordinates", () => {
  expect(endpoints(200, 100, 0)).toEqual({ x1: 0, y1: 50, x2: 200, y2: 50 });
  expect(endpoints(200, 100, 90)).toEqual({ x1: 100, y1: 0, x2: 100, y2: 100 });
  expect(endpoints(200, 100, 180)).toEqual({ x1: 200, y1: 50, x2: 0, y2: 50 });
  expect(endpoints(200, 100, 270)).toEqual({
    x1: 100,
    y1: 100,
    x2: 100,
    y2: 0,
  });
});
it("keeps 45 degrees on a non-square rectangle and centers the gradient instead of stretching normalized diagonals", () => {
  const p = endpoints(200, 100, 45);
  expect(p.x1).toBeCloseTo(25);
  expect(p.y1).toBeCloseTo(-25);
  expect(p.x2).toBeCloseTo(175);
  expect(p.y2).toBeCloseTo(125);
  expect((Math.atan2(p.y2 - p.y1, p.x2 - p.x1) * 180) / Math.PI).toBeCloseTo(
    45,
  );
});
it("covers every corner's projection from zero to one across resize and angle changes", () => {
  for (const [w, h] of [
    [200, 100],
    [100, 200],
    [1, 500],
    [500, 1],
  ])
    for (const degrees of [0, 22, 45, 90, 137, 200, 315]) {
      const p = endpoints(w, h, degrees),
        dx = p.x2 - p.x1,
        dy = p.y2 - p.y1;
      const projections = [
        [0, 0],
        [w, 0],
        [0, h],
        [w, h],
      ].map(
        ([x, y]) => ((x - p.x1) * dx + (y - p.y1) * dy) / (dx * dx + dy * dy),
      );
      expect(Math.min(...projections)).toBeCloseTo(0);
      expect(Math.max(...projections)).toBeCloseTo(1);
      expect((p.x1 + p.x2) / 2).toBeCloseTo(w / 2);
      expect((p.y1 + p.y2) / 2).toBeCloseTo(h / 2);
    }
});
it("normalizes finite user angles without storing equivalent negative or full-turn values", () => {
  expect(angle(-90)).toBe(270);
  expect(angle(450)).toBe(90);
  expect(angle(360)).toBe(0);
  expect(Object.is(angle(-0), -0)).toBe(false);
  expect(endpoints(200, 100, -90)).toEqual(endpoints(200, 100, 270));
});
it("rejects invalid dimensions, angles and unrepresentable endpoints", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    expect(() => angle(bad)).toThrow(/有限/);
    expect(() => endpoints(100, 100, bad)).toThrow();
  }
  for (const bad of [0, -1, NaN, Infinity]) {
    expect(() => endpoints(bad, 100, 0)).toThrow();
    expect(() => endpoints(100, bad, 0)).toThrow();
  }
  expect(() => endpoints(1.7e308, 1.7e308, 22.5)).toThrow(/描画座標/);
});
it("avoids unnecessary overflow for large but representable local geometry", () => {
  const p = endpoints(1e300, 1e300, 45);
  expect(Object.values(p).every(Number.isFinite)).toBe(true);
  expect(p.x2 / 1e300).toBeCloseTo(1);
  expect(p.y2 / 1e300).toBeCloseTo(1);
});
