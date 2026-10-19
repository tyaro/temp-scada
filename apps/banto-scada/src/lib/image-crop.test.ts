import { describe, expect, it } from "vitest";
import {
  imageCropViewBox,
  normalizeImageCrop,
  type ImageCrop,
} from "./image-crop";

const source = { width: 400, height: 200 };
const full = { x: 0, y: 0, width: 1, height: 1 };
describe("non-destructive image crop geometry", () => {
  it("uses oriented source pixels and leaves the original and draft unchanged", () => {
    const crop = Object.freeze({ x: 0.25, y: 0.1, width: 0.5, height: 0.4 });
    expect(imageCropViewBox(source, crop)).toEqual({
      x: 100,
      y: 20,
      width: 200,
      height: 80,
    });
    expect(imageCropViewBox({ width: 200, height: 400 }, crop)).toEqual({
      x: 50,
      y: 40,
      width: 100,
      height: 160,
    });
    expect(normalizeImageCrop(source, crop)).toEqual(crop);
    expect(normalizeImageCrop(source, crop)).not.toBe(crop);
    expect(source).toEqual({ width: 400, height: 200 });
  });
  it("canonicalizes full source to absence and accepts a one-pixel source", () => {
    expect(imageCropViewBox(source)).toEqual({ x: 0, y: 0, ...source });
    expect(normalizeImageCrop(source)).toBeUndefined();
    expect(normalizeImageCrop(source, full)).toBeUndefined();
    expect(imageCropViewBox({ width: 1, height: 1 }, full)).toEqual(full);
  });
  it("accepts exact single pixels at all four corners", () => {
    for (const x of [0, 399 / 400])
      for (const y of [0, 199 / 200]) {
        const box = imageCropViewBox(source, {
          x,
          y,
          width: 1 / 400,
          height: 1 / 200,
        });
        expect(box.x).toBeCloseTo(x * 400);
        expect(box.y).toBeCloseTo(y * 200);
        expect(box.width).toBeCloseTo(1);
        expect(box.height).toBeCloseTo(1);
      }
  });
  it("tolerates only arithmetic roundoff and rejects real outside/subpixel crops", () => {
    expect(
      imageCropViewBox(source, {
        x: 0.2,
        y: 0,
        width: 0.8 + Number.EPSILON,
        height: 1,
      }).width,
    ).toBe(320);
    expect(
      imageCropViewBox(
        { width: 100, height: 100 },
        { x: 0.28, y: 0, width: 0.29 - 0.28, height: 1 },
      ).width,
    ).toBeCloseTo(1);
    for (const patch of [
      { x: -Number.EPSILON },
      { width: 1 + Number.EPSILON },
      { x: 0.2, width: 0.8 + 1e-12 },
      { width: 0.999 / 400 },
      { height: 0.999 / 200 },
    ])
      expect(() => imageCropViewBox(source, { ...full, ...patch })).toThrow();
  });
  it("rejects nonfinite, empty, inverted and outside rectangles on every axis", () => {
    for (const key of ["x", "y", "width", "height"] as const) {
      for (const value of [NaN, Infinity, -Infinity, -0.1, 1.1])
        expect(() =>
          imageCropViewBox(source, { ...full, [key]: value }),
        ).toThrow();
    }
    for (const patch of [
      { width: 0 },
      { height: 0 },
      { x: 1 },
      { y: 1 },
      { x: 0.5 },
      { y: 0.5 },
    ])
      expect(() => imageCropViewBox(source, { ...full, ...patch })).toThrow();
  });
  it("rejects invalid source dimensions even without a crop", () => {
    for (const width of [NaN, Infinity, 0, -1, 1.5, 8193])
      expect(() => imageCropViewBox({ width, height: 100 })).toThrow();
    expect(() => imageCropViewBox({ width: 100, height: 0 })).toThrow();
  });
  it("bounds viewBoxes through a grid of legal source regions", () => {
    for (const width of [1, 7, 400, 8192])
      for (const height of [1, 13, 200, 1024]) {
        for (const left of [0, Math.floor(width / 2), width - 1])
          for (const top of [0, height - 1]) {
            const crop: ImageCrop = {
              x: left / width,
              y: top / height,
              width: (width - left) / width,
              height: (height - top) / height,
            };
            const box = imageCropViewBox({ width, height }, crop);
            expect(box.width).toBeGreaterThan(0);
            expect(box.height).toBeGreaterThan(0);
            expect(box.x + box.width).toBeCloseTo(width);
            expect(box.y + box.height).toBeCloseTo(height);
            expect(
              imageCropViewBox(
                { width, height },
                normalizeImageCrop({ width, height }, crop),
              ),
            ).toEqual(box);
          }
      }
  });
});
