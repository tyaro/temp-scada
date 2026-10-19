import { expect, it } from "vitest";
import { patternGeometry } from "./pattern-paint";
it("makes horizontal stripes, a single nonzero cross path and a complete inset circle", () => {
  expect(patternGeometry("hatch", 12, 2)).toBe("M0 5H12V7H0Z");
  expect(patternGeometry("crosshatch", 12, 2)).toBe("M0 5H12V7H0ZM5 0H7V12H5Z");
  expect(patternGeometry("dots", 12, 4)).toBe(
    "M4 6A2 2 0 1 0 8 6A2 2 0 1 0 4 6Z",
  );
});
it("supports finite fractional spacing and bounded size without adding raster assets", () => {
  expect(patternGeometry("crosshatch", 2, 1)).toBe(
    "M0 0.5H2V1.5H0ZM0.5 0H1.5V2H0.5Z",
  );
  expect(patternGeometry("dots", 1024, 64)).not.toMatch(/NaN|Infinity/);
  expect(patternGeometry("hatch", 12.5, 0.5)).toBe("M0 6H12.5V6.5H0Z");
});
it("rejects unknown kinds and invalid numbers before creating SVG geometry", () => {
  expect(() => patternGeometry("unknown" as never, 12, 1)).toThrow(/種類/);
  for (const spacing of [NaN, Infinity, -1, 0, 1.9, 1024.1])
    expect(() => patternGeometry("hatch", spacing, 1)).toThrow(/間隔/);
  for (const size of [NaN, Infinity, -1, 0, 6.1, 65])
    expect(() => patternGeometry("hatch", 12, size)).toThrow(/太さ/);
});
