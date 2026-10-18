import { expect, it } from "vitest";
import { handlePoint, resizeGeometry, resizeHandles } from "./resize";
const original = { x: 103, y: 57, width: 200, height: 100 };
it("keeps opposite edges fixed for all eight handles", () => {
  for (const handle of resizeHandles) {
    const resized = resizeGeometry(original, handle, { x: 20, y: 10 }, null);
    expect(resized.x).toBe(original.x + (handle.includes("w") ? 20 : 0));
    expect(resized.y).toBe(original.y + (handle.includes("n") ? 10 : 0));
    expect(resized.width).toBe(
      200 + (handle.includes("w") ? -20 : handle.includes("e") ? 20 : 0),
    );
    expect(resized.height).toBe(
      100 + (handle.includes("n") ? -10 : handle.includes("s") ? 10 : 0),
    );
  }
});
it("snaps moving edges in screen coordinates and preserves untouched axes", () => {
  expect(resizeGeometry(original, "nw", { x: 10, y: 10 }, 20)).toEqual({
    x: 120,
    y: 60,
    width: 183,
    height: 97,
  });
  expect(resizeGeometry(original, "se", { x: 10, y: 0 }, 20)).toEqual({
    ...original,
    width: 217,
  });
  expect(resizeGeometry(original, "e", { x: 10, y: 999 }, null)).toEqual({
    ...original,
    width: 210,
  });
  expect(resizeGeometry(original, "se", { x: 0, y: 0 }, 20)).toEqual(original);
  expect(
    resizeGeometry(
      { x: 0, y: 0, width: 19.9, height: 10 },
      "e",
      { x: 0.1, y: 0 },
      20,
    ).width,
  ).toBe(20);
  expect(handlePoint(original, "s")).toEqual({ x: 203, y: 157 });
});
it("prevents flipped or zero geometry beyond the opposite edge", () => {
  expect(resizeGeometry(original, "nw", { x: 1000, y: 1000 }, null)).toEqual({
    x: 302,
    y: 156,
    width: 1,
    height: 1,
  });
  expect(resizeGeometry(original, "se", { x: -1000, y: -1000 }, 20)).toEqual({
    ...original,
    width: 1,
    height: 1,
  });
  expect(original).toEqual({ x: 103, y: 57, width: 200, height: 100 });
  expect(() =>
    resizeGeometry(original, "e", { x: Infinity, y: 0 }, null),
  ).toThrow();
});
