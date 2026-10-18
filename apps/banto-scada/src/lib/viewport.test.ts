import { expect, it } from "vitest";
import { fitZoom, viewLayout, zoomAt } from "./viewport";
it("fits the whole screen with margins, allows very large drawings and caps enlargement", () => {
  expect(
    fitZoom({ width: 960, height: 540 }, { width: 1008, height: 588 }),
  ).toBe(1);
  expect(
    fitZoom({ width: 100, height: 100 }, { width: 1008, height: 588 }),
  ).toBe(4);
  expect(
    fitZoom({ width: 10000, height: 5000 }, { width: 800, height: 500 }),
  ).toBeLessThan(0.25);
});
it("centers a small sheet and extends large sheets without changing design dimensions", () => {
  expect(
    viewLayout({ width: 100, height: 100 }, { width: 800, height: 600 }, 1),
  ).toEqual({
    width: 100,
    height: 100,
    worldWidth: 800,
    worldHeight: 600,
    x: 350,
    y: 250,
  });
  expect(
    viewLayout({ width: 960, height: 540 }, { width: 800, height: 600 }, 2),
  ).toEqual({
    width: 1920,
    height: 1080,
    worldWidth: 1968,
    worldHeight: 1128,
    x: 24,
    y: 24,
  });
});
it("retains the anchor's design coordinate through zoom and clamps the scrollable edges", () => {
  const screen = { width: 960, height: 540 },
    viewport = { width: 800, height: 600 },
    scroll = { x: 200, y: 100 },
    anchor = { x: 400, y: 300 };
  const state = zoomAt(screen, viewport, 2, 3, scroll, anchor);
  const before = viewLayout(screen, viewport, 2),
    after = viewLayout(screen, viewport, 3);
  expect((scroll.x + anchor.x - before.x) / 2).toBeCloseTo(
    (state.left + anchor.x - after.x) / 3,
  );
  expect((scroll.y + anchor.y - before.y) / 2).toBeCloseTo(
    (state.top + anchor.y - after.y) / 3,
  );
  expect(zoomAt(screen, viewport, 3, 0.25, { x: 0, y: 0 }, anchor)).toEqual({
    zoom: 0.25,
    left: 0,
    top: 0,
  });
});
it("rejects nonfinite or zero viewport geometry", () => {
  expect(() =>
    fitZoom({ width: 0, height: 20 }, { width: 100, height: 100 }),
  ).toThrow();
  expect(() =>
    viewLayout(
      { width: 100, height: 100 },
      { width: Infinity, height: 100 },
      1,
    ),
  ).toThrow();
  expect(() =>
    viewLayout({ width: 100, height: 100 }, { width: 100, height: 100 }, 0),
  ).toThrow();
});
