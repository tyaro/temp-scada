import { expect, it } from "vitest";
import {
  DEFAULT_REFERENCE_HEIGHT,
  parseReferenceHeight,
  referenceHeightMaximum,
} from "./panel-height";

it("recovers from corrupt, non-integer and out-of-range stored heights", () => {
  for (const value of [
    undefined,
    null,
    "",
    "{}",
    "null",
    "240.5",
    "Infinity",
    "159",
    "401",
    "-200",
    "1e3",
  ])
    expect(parseReferenceHeight(value)).toBe(DEFAULT_REFERENCE_HEIGHT);
  expect(parseReferenceHeight("160")).toBe(160);
  expect(parseReferenceHeight("320")).toBe(320);
  expect(parseReferenceHeight("400")).toBe(400);
});
it("limits references to 40% and leaves room for the canvas and status", () => {
  for (const height of [500, 550, 600, 800, 1200]) {
    const max = referenceHeightMaximum(height);
    expect(max).toBeGreaterThanOrEqual(160);
    expect(max).toBeLessThanOrEqual(400);
    expect(max).toBeLessThanOrEqual(height * 0.4);
    expect(height - max).toBeGreaterThanOrEqual(340);
  }
});
