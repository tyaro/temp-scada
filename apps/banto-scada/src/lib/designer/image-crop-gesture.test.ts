import { describe, expect, it } from "vitest";
import { imageCropViewBox, type ImageCrop } from "../image-crop";
import {
  cropAspect,
  cropWithAspect,
  cropGesture,
  type CropHandle,
} from "./image-crop-gesture";
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

describe("locked source crop aspect", () => {
  it("captures oriented pixel aspect and links numeric size without moving the origin", () => {
    expect(cropAspect(source, before)).toBe(2);
    expect(cropAspect(source, { ...before, height: 0.25 })).toBe(4);
    expect(
      cropWithAspect(source, { ...before, width: 0.25 }, 2, "width"),
    ).toEqual({ x: 0.25, y: 0.25, width: 0.25, height: 0.25 });
    expect(
      cropWithAspect(source, { ...before, height: 0.25 }, 2, "height"),
    ).toEqual({ x: 0.25, y: 0.25, width: 0.25, height: 0.25 });
    expect(() =>
      cropWithAspect(source, { ...before, width: 0.9 }, 2, "width"),
    ).toThrow();
    expect(() =>
      cropWithAspect(source, { ...before, height: 0.001 }, 2, "height"),
    ).toThrow();
    for (const ratio of [0, -1, Infinity, NaN, 401, 1 / 201])
      expect(() => cropWithAspect(source, before, ratio, "width")).toThrow();
    expect(before).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
  });
  it.each<CropHandle>(["n", "ne", "e", "se", "s", "sw", "w", "nw"])(
    "preserves the opposite corner or edge midpoint for %s",
    (handle) => {
      for (const end of [
        { x: 0.1, y: 0.2 },
        { x: 10, y: -10 },
        { x: -10, y: 10 },
      ]) {
        const result = cropGesture(
          source,
          before,
          handle,
          zero,
          end,
          cropAspect(source, before),
        );
        expect(() => imageCropViewBox(source, result)).not.toThrow();
        expect(cropAspect(source, result)).toBeCloseTo(2, 10);
        const xFactor = handle.includes("w")
          ? 1
          : handle.includes("e")
            ? 0
            : 0.5;
        const yFactor = handle.includes("n")
          ? 1
          : handle.includes("s")
            ? 0
            : 0.5;
        expect(result.x + result.width * xFactor).toBeCloseTo(
          before.x + before.width * xFactor,
          12,
        );
        expect(result.y + result.height * yFactor).toBeCloseTo(
          before.y + before.height * yFactor,
          12,
        );
      }
    },
  );
  it("uses the larger converted corner change and keeps movement independent of lock", () => {
    const next = cropGesture(
      source,
      before,
      "se",
      zero,
      { x: 0.05, y: 0.15 },
      2,
    );
    expect(next.width).toBeCloseTo(0.65);
    expect(next.height).toBeCloseTo(0.65);
    expect(
      cropGesture(source, before, "move", zero, { x: 4, y: -4 }, 2),
    ).toEqual(cropGesture(source, before, "move", zero, { x: 4, y: -4 }));
  });
  it("accepts only source-pixel boundary roundoff when capturing an existing valid crop", () => {
    const extent = { width: 8192, height: 8192 };
    const thin = { x: 0, y: 0, width: 1, height: (1 - 1e-12) / 8192 };
    expect(() => imageCropViewBox(extent, thin)).not.toThrow();
    const next = cropGesture(
      extent,
      thin,
      "se",
      zero,
      { x: 0.1, y: 0.1 },
      cropAspect(extent, thin),
    );
    expect(() => imageCropViewBox(extent, next)).not.toThrow();
    expect(cropAspect(extent, next)).toBeCloseTo(8192, 7);
    expect(() => cropWithAspect(extent, thin, 8192.01, "width")).toThrow();
  });
  it("draws in all directions, constrains boundaries, and preserves non-square pixel ratios", () => {
    for (const end of [
      { x: -4, y: -4 },
      { x: -4, y: 4 },
      { x: 4, y: -4 },
      { x: 4, y: 4 },
    ]) {
      const next = cropGesture(
        source,
        before,
        "draw",
        { x: 0.5, y: 0.5 },
        end,
        4,
      );
      expect(next.width).toBeCloseTo(0.5);
      expect(next.height).toBeCloseTo(0.25);
      expect(cropAspect(source, next)).toBeCloseTo(4);
      expect(() => imageCropViewBox(source, next)).not.toThrow();
    }
  });
  it("keeps one source pixel on tiny, thin, odd and large extents even at source edges", () => {
    for (const extent of [
      { width: 1, height: 1 },
      { width: 1, height: 8192 },
      { width: 8192, height: 1 },
      { width: 7, height: 13 },
      { width: 8192, height: 8192 },
    ]) {
      for (const aspect of [
        1 / extent.height,
        extent.width,
        extent.width / extent.height,
      ]) {
        for (const start of [zero, { x: 1, y: 1 }, { x: 0.5, y: 0.5 }]) {
          for (const end of [
            zero,
            { x: 1, y: 1 },
            { x: -4, y: 4 },
            { x: 0.333, y: 0.667 },
          ]) {
            const next = cropGesture(
              extent,
              undefined,
              "draw",
              start,
              end,
              aspect,
            );
            expect(() => imageCropViewBox(extent, next)).not.toThrow();
            expect(cropAspect(extent, next)).toBeCloseTo(aspect, 8);
            for (const handle of [
              "n",
              "ne",
              "e",
              "se",
              "s",
              "sw",
              "w",
              "nw",
            ] as const) {
              const resized = cropGesture(
                extent,
                next,
                handle,
                start,
                end,
                aspect,
              );
              expect(() => imageCropViewBox(extent, resized)).not.toThrow();
              expect(cropAspect(extent, resized)).toBeCloseTo(aspect, 8);
            }
          }
        }
      }
    }
  });
});
