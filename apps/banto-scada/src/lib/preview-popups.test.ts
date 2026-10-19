import { expect, it } from "vitest";
import {
  popupFrame,
  openPopup,
  frontPopup,
  positionPopup,
  constrainPopups,
  closePopup,
  type PreviewPopups,
} from "./preview-popups";
const area = { width: 1000, height: 700 };
it("opens at most four; duplicate open fronts the same frame without additional cost", () => {
  let windows: PreviewPopups = [];
  for (let i = 0; i < 4; i++)
    windows = openPopup(windows, String(i), 100, area);
  const before = structuredClone(windows);
  expect(() => openPopup(windows, "5", 100, area)).toThrow("4件");
  expect(windows).toEqual(before);
  const moved = openPopup(windows, "0", 99999, area);
  expect(moved.map((w) => w.screenId)).toEqual(["1", "2", "3", "0"]);
  expect(moved.at(-1)).toBe(windows[0]);
  expect(moved).toHaveLength(4);
  expect(windows).toEqual(before);
  expect(frontPopup(moved, "0")).toBe(moved);
  expect(() => frontPopup(moved, "missing")).toThrow();
});
it("caps total expanded cost, preserving existing windows on rejection", () => {
  const windows = openPopup([], "one", 10000, area),
    next = openPopup(windows, "two", 10000, area);
  expect(() => openPopup(next, "three", 1, area)).toThrow("20,000");
  expect(next).toHaveLength(2);
  expect(() => openPopup([], "bad", NaN, area)).toThrow();
  expect(() => openPopup([], "bad", -1, area)).toThrow();
  expect(() => openPopup([], "bad", 1.5, area)).toThrow();
  expect(() => openPopup([], "bad", 20001, area)).toThrow("20,000");
  expect(openPopup([], "empty", 0, area)).toHaveLength(1);
});
it("clamps moving and sizing to the area, allowing tiny viewports without negative geometry", () => {
  expect(popupFrame({ x: -5, y: 999, width: 100, height: 100 }, area)).toEqual({
    x: 0,
    y: 480,
    width: 320,
    height: 220,
  });
  expect(popupFrame({ x: 5, y: 10, width: 9999, height: 9999 }, area)).toEqual({
    x: 0,
    y: 0,
    ...area,
  });
  expect(
    popupFrame(
      { x: 5, y: 10, width: 999, height: 999 },
      { width: 180, height: 90 },
    ),
  ).toEqual({ x: 0, y: 0, width: 180, height: 90 });
  expect(
    popupFrame(
      { x: 5, y: 10, width: 999, height: 999 },
      { width: 0, height: 0 },
    ),
  ).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  expect(() => openPopup([], "zero", 1, { width: 0, height: 0 })).toThrow(
    "領域",
  );
  expect(() =>
    popupFrame({ x: NaN, y: 0, width: 400, height: 300 }, area),
  ).toThrow();
});
it("position, constrain and close preserve order, identity and input", () => {
  const windows = openPopup(openPopup([], "a", 100, area), "b", 200, area),
    before = structuredClone(windows);
  const moved = positionPopup(
    windows,
    "a",
    { x: 800, y: 600, width: 400, height: 300 },
    area,
  );
  expect(moved[0].frame).toEqual({ x: 600, y: 400, width: 400, height: 300 });
  expect(moved[1]).toBe(windows[1]);
  const smaller = constrainPopups(moved, { width: 200, height: 120 });
  expect(smaller.map((w) => w.screenId)).toEqual(["a", "b"]);
  for (const w of smaller)
    expect(w.frame).toEqual({ x: 0, y: 0, width: 200, height: 120 });
  expect(closePopup(smaller, "a").map((w) => w.screenId)).toEqual(["b"]);
  expect(windows).toEqual(before);
  expect(() =>
    positionPopup(windows, "missing", moved[0].frame, area),
  ).toThrow();
});
