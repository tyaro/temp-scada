import { expect, it } from "vitest";
import { rulerTicks } from "./ruler";
it("tracks design coordinates under zoom and scroll without generating offscreen ticks", () => {
  for (const scale of [0.003, 0.25, 1, 1.1, 4]) {
    const origin = -125.5;
    const ticks = rulerTicks(1100, origin, scale);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThan(200);
    for (const tick of ticks) {
      expect(tick.position).toBeGreaterThanOrEqual(-0.001);
      expect(tick.position).toBeLessThanOrEqual(1100.001);
      expect(tick.position).toBeCloseTo(origin + tick.value * scale, 5);
    }
    const labels = ticks.filter((t) => t.label !== null);
    for (let i = 1; i < labels.length; i++)
      expect(
        labels[i].position - labels[i - 1].position,
      ).toBeGreaterThanOrEqual(63.99);
  }
});
it("includes negative margin coordinates and zero, with stable labels and safe invalid bounds", () => {
  const ticks = rulerTicks(800, 200, 1);
  expect(ticks.some((t) => t.value < 0 && t.label !== null)).toBe(true);
  expect(ticks.find((t) => t.value === 0)).toEqual({
    value: 0,
    position: 200,
    label: "0",
  });
  expect(ticks.some((t) => t.label === "-0")).toBe(false);
  for (const args of [
    [0, 0, 1],
    [800, NaN, 1],
    [800, 0, 0],
    [Infinity, 0, 1],
  ])
    expect(rulerTicks(...(args as [number, number, number]))).toEqual([]);
});
