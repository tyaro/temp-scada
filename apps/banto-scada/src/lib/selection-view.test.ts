import { it, expect } from "vitest";
import fixture from "../../../../examples/minimal.project.json";
import process from "../../../../examples/process.project.json";
import { parseProject, getBounds } from "./project";
import {
  selectionTarget,
  selectionView,
  SELECTION_VIEW_PADDING,
} from "./selection-view";
import { viewLayout } from "./viewport";
const owner = () => parseProject(JSON.stringify(fixture)).screens[0];
it("uses the selected painted bounds, including outlines and existing pipe arrows", () => {
  const screen = owner(),
    object = screen.objects[0];
  if (object.shape.type !== "rectangle") throw new Error();
  object.shape.paint.stroke = { color: "#123456", width: 12 };
  expect(selectionTarget(screen, [object.id]).bounds).toEqual({
    x: 94,
    y: 164,
    width: 272,
    height: 192,
  });
  const pipeline = parseProject(JSON.stringify(process)).screens[0],
    pipe = pipeline.objects.find((object) => object.shape.type === "polyline")!;
  expect(selectionTarget(pipeline, [pipe.id]).bounds).toEqual(
    (() => {
      const b = getBounds(pipe);
      return {
        x: pipe.x + b.x,
        y: pipe.y + b.y,
        width: b.width,
        height: b.height,
      };
    })(),
  );
});
it("combines multiple placements, retains locked ones and does not change the model", () => {
  const screen = owner(),
    before = structuredClone(screen);
  screen.objects[0].locked = true;
  const value = selectionTarget(
    screen,
    screen.objects.slice(0, 2).map((object) => object.id),
  );
  expect(value.bounds).toEqual({ x: 100, y: 170, width: 610, height: 180 });
  expect(screen).toEqual({
    ...before,
    objects: before.objects.map((object, i) =>
      i ? object : { ...object, locked: true },
    ),
  });
});
it("rejects hidden mixtures, missing and duplicate selections without silently filtering them", () => {
  const screen = owner(),
    ids = screen.objects.slice(0, 2).map((object) => object.id);
  for (const values of [[], ["missing"], [ids[0], ids[0]]])
    expect(selectionTarget(screen, values).bounds).toBeNull();
  screen.objects[1].visible = false;
  expect(selectionTarget(screen, ids).reason).toMatch(/非表示/);
});
it("clips each placement before combining, distinguishes partial and complete off-sheet selection", () => {
  const screen = owner(),
    a = screen.objects[0],
    b = screen.objects[1];
  a.x = -50;
  a.y = -20;
  expect(selectionTarget(screen, [a.id])).toMatchObject({
    bounds: { x: 0, y: 0, width: 210, height: 160 },
    clippedCount: 1,
    outsideCount: 0,
  });
  b.x = screen.width + 100;
  expect(selectionTarget(screen, [a.id, b.id])).toMatchObject({
    bounds: { x: 0, y: 0, width: 210, height: 160 },
    outsideCount: 1,
  });
  a.x = -1000;
  expect(selectionTarget(screen, [a.id, b.id]).bounds).toBeNull();
  expect(selectionTarget(screen, [a.id, b.id]).reason).toMatch(/すべて画面外/);
});
it("fits once with 32 CSS-pixel margins and centers independently of the sheet size", () => {
  const screen = { width: 2000, height: 1500 },
    viewport = { width: 800, height: 600 },
    bounds = { x: 800, y: 500, width: 400, height: 300 };
  const state = selectionView(screen, viewport, bounds),
    layout = viewLayout(screen, viewport, state.zoom!, true);
  expect(state.zoom).toBeCloseTo((600 - 2 * SELECTION_VIEW_PADDING) / 300);
  expect(
    (state.left + viewport.width / 2 - layout.x) / state.zoom!,
  ).toBeCloseTo(1000);
  expect(
    (state.top + viewport.height / 2 - layout.y) / state.zoom!,
  ).toBeCloseTo(650);
});
it("caps small selections at 400%, large ones at 25%, and centers targets at sheet edges", () => {
  const screen = { width: 10000, height: 10000 },
    viewport = { width: 800, height: 600 };
  expect(
    selectionView(screen, viewport, { x: 10, y: 10, width: 1, height: 1 }).zoom,
  ).toBe(4);
  expect(
    selectionView(screen, viewport, { x: 0, y: 0, width: 10000, height: 10000 })
      .zoom,
  ).toBe(0.25);
  for (const bounds of [
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 9900, y: 9900, width: 100, height: 100 },
  ]) {
    const state = selectionView(screen, viewport, bounds),
      layout = viewLayout(screen, viewport, state.zoom!, true);
    expect((state.left + 400 - layout.x) / state.zoom!).toBeCloseTo(
      bounds.x + 50,
    );
  }
});
it("rejects invalid or overflowing view geometry rather than storing NaN or Infinity", () => {
  const size = { width: 800, height: 600 };
  for (const bounds of [
    { x: 0, y: 0, width: 0, height: 1 },
    { x: NaN, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 1, height: Infinity },
  ])
    expect(() => selectionView(size, size, bounds)).toThrow();
  expect(() =>
    selectionView({ width: Number.MAX_VALUE, height: 600 }, size, {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    }),
  ).toThrow();
});
