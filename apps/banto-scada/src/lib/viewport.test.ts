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

it("preserves a sheet center across panel widths even when the sheet is smaller than the viewport", async () => {
  const { viewFromCenter } = await import("./viewport");
  const screen = { width: 160, height: 90 };
  for (const zoom of [0.25, 1, 4]) {
    for (const center of [
      { x: 1, y: 2 },
      { x: 159, y: 88 },
    ]) {
      for (const viewport of [
        { width: 800, height: 500 },
        { width: 1100, height: 650 },
      ]) {
        const layout = viewLayout(screen, viewport, zoom, true);
        const state = viewFromCenter(screen, viewport, zoom, center, true);
        expect((state.left + viewport.width / 2 - layout.x) / zoom).toBeCloseTo(
          center.x,
        );
        expect((state.top + viewport.height / 2 - layout.y) / zoom).toBeCloseTo(
          center.y,
        );
      }
    }
  }
});

it("retains zoom anchors when moving between fit margins and room for centered panel resizing", () => {
  const screen = { width: 960, height: 540 },
    viewport = { width: 800, height: 500 };
  const anchor = { x: 400, y: 250 };
  const before = viewLayout(screen, viewport, 1);
  const state = zoomAt(screen, viewport, 1, 2, { x: 100, y: 20 }, anchor, {
    before: false,
    after: true,
  });
  const after = viewLayout(screen, viewport, 2, true);
  expect(100 + anchor.x - before.x).toBeCloseTo(
    (state.left + anchor.x - after.x) / 2,
  );
  expect(20 + anchor.y - before.y).toBeCloseTo(
    (state.top + anchor.y - after.y) / 2,
  );
});
