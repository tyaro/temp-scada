import { describe, expect, it } from "vitest";
import { imageCropViewBox, type ImageCrop } from "../image-crop";
import { cropGesture, type CropHandle } from "./image-crop-gesture";
const source = { width: 400, height: 200 };
const before = Object.freeze({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
const zero = { x: 0, y: 0 };
describe("source crop pointer geometry", () => {
  it("moves within the source while keeping size and original draft", () => {
    expect(
      cropGesture(source, before, "move", zero, { x: 10, y: -10 }),
    ).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
    expect(before).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    expect(
      cropGesture(source, undefined, "move", zero, { x: 10, y: 10 }),
    ).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
  it("draws in either direction and clamps source boundaries with a one-pixel minimum", () => {
    expect(
      cropGesture(
        source,
        before,
        "draw",
        { x: 0.75, y: 0.75 },
        { x: -0.25, y: 0.25 },
      ),
    ).toEqual({ x: 0, y: 0.25, width: 0.75, height: 0.5 });
    expect(
      cropGesture(
        source,
        before,
        "draw",
        { x: 0.75, y: 0.75 },
        { x: 0.25, y: -0.25 },
      ),
    ).toEqual({ x: 0.25, y: 0, width: 0.5, height: 0.75 });
    expect(
      cropGesture(
        source,
        before,
        "draw",
        { x: 0.75, y: 0.75 },
        { x: 0.25, y: 0.25 },
      ),
    ).toEqual(before);
    expect(cropGesture(source, before, "draw", zero, { x: 10, y: 10 })).toEqual(
      { x: 0, y: 0, width: 1, height: 1 },
    );
    expect(
      cropGesture(source, before, "draw", { x: 1, y: 1 }, { x: 1, y: 1 }),
    ).toEqual({
      x: 1 - 1 / 400,
      y: 1 - 1 / 200,
      width: 1 / 400,
      height: 1 / 200,
    });
  });
  it.each<CropHandle>(["n", "ne", "e", "se", "s", "sw", "w", "nw"])(
    "keeps opposite edges and never inverts the %s handle",
    (handle) => {
      const end = {
        x: handle.includes("w") ? 10 : -10,
        y: handle.includes("n") ? 10 : -10,
      };
      const result = cropGesture(source, before, handle, zero, end);
      expect(() => imageCropViewBox(source, result)).not.toThrow();
      if (handle.includes("w")) {
        expect(result.x + result.width).toBeCloseTo(0.75);
        expect(result.width).toBeCloseTo(1 / 400);
      } else expect(result.x).toBe(0.25);
      if (handle.includes("e")) expect(result.width).toBeCloseTo(1 / 400);
      else if (!handle.includes("w")) expect(result.width).toBe(0.5);
      if (handle.includes("n")) {
        expect(result.y + result.height).toBeCloseTo(0.75);
        expect(result.height).toBeCloseTo(1 / 200);
      } else expect(result.y).toBe(0.25);
      if (handle.includes("s")) expect(result.height).toBeCloseTo(1 / 200);
      else if (!handle.includes("n")) expect(result.height).toBe(0.5);
    },
  );
  it("always produces valid crops on tiny, odd, and maximum sources", () => {
    for (const extent of [
      { width: 1, height: 1 },
      { width: 7, height: 13 },
      { width: 8192, height: 8192 },
    ]) {
      let crop: ImageCrop | undefined;
      for (const mode of [
        "draw",
        "move",
        "nw",
        "se",
        "n",
        "e",
        "s",
        "w",
      ] as const)
        for (const p of [
          zero,
          { x: 1, y: 1 },
          { x: -4, y: 4 },
          { x: 0.333, y: 0.667 },
        ]) {
          crop = cropGesture(extent, crop, mode, { x: 0.5, y: 0.5 }, p);
          expect(() => imageCropViewBox(extent, crop)).not.toThrow();
        }
    }
  });
});
