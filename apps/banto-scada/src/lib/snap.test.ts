import { expect, it } from "vitest";
import {
  snapCoordinate,
  dragOffset,
  vertexPosition,
  nextGridCoordinate,
} from "./snap";
it("snaps positive and negative coordinates and validates the grid step", () => {
  expect(snapCoordinate(17, 10)).toBe(20);
  expect(snapCoordinate(-17, 10)).toBe(-20);
  for (const step of [0, -10, Infinity, NaN])
    expect(() => snapCoordinate(10, step)).toThrow();
  expect(() => snapCoordinate(NaN, 10)).toThrow();
});
it("snaps a non-grid anchor with one common offset instead of distorting a group", () => {
  const anchor = { x: 13.25, y: -3.5 },
    delta = dragOffset(anchor, { x: 12.7, y: -8 }, 10);
  expect(delta).toEqual({ x: 16.75, y: -6.5 });
  expect(anchor.x + delta.x).toBe(30);
  expect(anchor.y + delta.y).toBe(-10);
  const other = { x: 24.5, y: 19 };
  expect(other.x + delta.x - (anchor.x + delta.x)).toBe(other.x - anchor.x);
});
it("does not move an off-grid item on a click and keeps free-drag precision", () => {
  expect(dragOffset({ x: 13, y: 17 }, { x: 0, y: 0 }, 10)).toEqual({
    x: 0,
    y: 0,
  });
  expect(dragOffset({ x: 13, y: 17 }, { x: 1.234, y: -4.567 }, null)).toEqual({
    x: 1.23,
    y: -4.57,
  });
});
it("snaps vertices in screen coordinates and converts back to local coordinates", () => {
  const origin = { x: 13, y: 17 },
    start = { x: -5, y: 2 };
  expect(vertexPosition(origin, start, { x: 7, y: 7 }, 10)).toEqual({
    x: 7,
    y: 13,
  });
  expect(vertexPosition(origin, start, { x: 0, y: 0 }, 10)).toEqual(start);
  const free = vertexPosition(
    origin,
    { x: -5.25, y: 2.75 },
    { x: 7.333, y: -4.111 },
    null,
  );
  expect(free.x).toBeCloseTo(2.08);
  expect(free.y).toBeCloseTo(-1.36);
});
it("keyboard steps advance to the next line from grid and off-grid positions", () => {
  expect(nextGridCoordinate(15, 1, 10)).toBe(20);
  expect(nextGridCoordinate(20, 1, 10)).toBe(30);
  expect(nextGridCoordinate(-15, 1, 10)).toBe(-10);
  expect(nextGridCoordinate(-10, -1, 10)).toBe(-20);
});
