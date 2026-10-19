import { expect, it } from "vitest";
import { wheelPixels, wheelZoom } from "./wheel-navigation";
it("normalizes mouse, line and page wheel deltas on the relevant axis", () => {
  expect(wheelPixels(120, 0, 800)).toBe(120);
  expect(wheelPixels(-3, 1, 800)).toBe(-48);
  expect(wheelPixels(1, 2, 800)).toBe(800);
  expect(wheelPixels(1, 2, 1200)).toBe(1200);
  expect(wheelPixels(NaN, 0, 800)).toBe(0);
});
it("zooms in upward and out downward, retaining fine deltas and bounded scale", () => {
  expect(wheelZoom(1, -100)).toBeCloseTo(1.1);
  expect(wheelZoom(wheelZoom(1, -100), 100)).toBeCloseTo(1);
  expect(wheelZoom(1, -1)).toBeGreaterThan(1);
  expect(wheelZoom(4, -100)).toBe(4);
  expect(wheelZoom(0.25, 100)).toBe(0.25);
  expect(wheelZoom(0.01, 100)).toBe(0.01);
  expect(wheelZoom(0.01, -100)).toBe(0.25);
});
