import { expect, it } from "vitest";
import {
  fitStaticLines,
  fitTextWidth,
  normalizeTextNewlines,
} from "./multiline-text-layout";
import type { TextMetrics } from "./text-layout";
const measure = (text: string): TextMetrics => ({
  x: -1,
  y: -8,
  width:
    [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
        text,
      ),
    ].length * 6,
  height: 10,
});
it("normalizes separators while preserving leading, middle, trailing blank lines and spaces", () => {
  expect(normalizeTextNewlines("\r\n A \r\rB\u2028\u2029")).toBe(
    "\n A \n\nB\n\n",
  );
  expect(normalizeTextNewlines(" a \n")).toBe(" a \n");
});
it("fits full width and forces a measured ellipsis for a hidden following line including an empty one", () => {
  expect(fitTextWidth("abc", 18, measure)).toMatchObject({
    text: "abc",
    truncated: false,
    overflow: false,
  });
  expect(fitTextWidth("abc", 18, measure, true)).toMatchObject({
    text: "ab…",
    truncated: true,
    overflow: false,
  });
  expect(fitTextWidth("", 6, measure, true)).toMatchObject({
    text: "…",
    overflow: false,
  });
  expect(fitTextWidth("abc", 5, measure)).toMatchObject({
    text: "",
    overflow: true,
  });
});
it("never splits graphemes or appends a second generated ellipsis when clipping both axes", () => {
  const family = "👨‍👩‍👧‍👦",
    value = `A${family}e\u0301B`;
  expect(fitTextWidth(value, 18, measure).text).toBe(`A${family}…`);
  const layout = fitStaticLines(`${value}\nsecond\nlast`, 22, 24, 10, measure);
  expect(layout.lines.map((line) => line.text)).toEqual([`A${family}…`, "se…"]);
  expect(layout.visibleLines).toBe(2);
  expect(layout.mode).toBe("ellipsis");
});
it("centers the visible cells with a shared baseline and preserves negative ink bearings", () => {
  const result = fitStaticLines("A\nB\nC", 100, 60, 10, measure);
  expect(result).toEqual({
    mode: "full",
    totalLines: 3,
    visibleLines: 3,
    lines: [
      { text: "A", baseline: 21, left: -1, inkWidth: 6 },
      { text: "B", baseline: 33, left: -1, inkWidth: 6 },
      { text: "C", baseline: 45, left: -1, inkWidth: 6 },
    ],
  });
});
it("reserves cells for leading, middle and trailing empty lines without trimming", () => {
  const result = fitStaticLines("\nA\n\n", 100, 60, 10, measure);
  expect(result.mode).toBe("full");
  expect(result.totalLines).toBe(4);
  expect(result.lines.map((line) => [line.text, line.baseline])).toEqual([
    ["", 15],
    ["A", 27],
    ["", 39],
    ["", 51],
  ]);
  expect(
    fitStaticLines("A\n\nC", 100, 24, 10, measure).lines.map(
      (line) => line.text,
    ),
  ).toEqual(["A", "…"]);
});
it("shows the prefix and marks hidden lines, rather than centering and clipping the complete original block", () => {
  const result = fitStaticLines("one\ntwo\nthree\nfour", 100, 24, 10, measure);
  expect(result.lines.map((line) => line.text)).toEqual(["one", "two…"]);
  expect(result.lines.map((line) => line.baseline)).toEqual([9, 21]);
  expect(result).toMatchObject({
    mode: "ellipsis",
    totalLines: 4,
    visibleLines: 2,
  });
});
it("tests actual ink outside nominal cells and rechecks the ellipsis candidate height after reducing line count", () => {
  const tall = (text: string): TextMetrics => ({
    ...measure(text),
    ...(text.endsWith("…") ? { y: -20, height: 30 } : {}),
  });
  const result = fitStaticLines("A\nB\nC", 100, 24, 10, tall);
  expect(result).toMatchObject({ mode: "overflow", visibleLines: 0 });
  const ink = (text: string): TextMetrics => ({
    ...measure(text),
    ...(text === "A" ? { y: -14, height: 20 } : {}),
  });
  const fit = fitStaticLines("A\nB", 100, 34, 10, ink);
  expect(fit.mode).toBe("full");
  for (const line of fit.lines) {
    const box = ink(line.text);
    expect(line.baseline + box.y).toBeGreaterThanOrEqual(0);
    expect(line.baseline + box.y + box.height).toBeLessThanOrEqual(34);
  }
});
it("recomputes the final visible line from original content when forced ellipsis affects ink height", () => {
  const special = (text: string): TextMetrics => ({
    ...measure(text),
    ...(text === "A…"
      ? { y: -8, height: 10 }
      : text === "B…"
        ? { y: -20, height: 30 }
        : {}),
  });
  const result = fitStaticLines("A\nB\nC", 100, 24, 10, special);
  expect(result).toMatchObject({ mode: "ellipsis", visibleLines: 1 });
  expect(result.lines.map((line) => line.text)).toEqual(["A…"]);
});
it("handles tiny, nonfinite and invalid metrics without inventing partially painted text", () => {
  for (const [width, height, fontSize] of [
    [100, 11, 10],
    [5, 100, 10],
    [NaN, 24, 10],
    [100, Infinity, 10],
    [100, 24, 0],
  ])
    expect(fitStaticLines("A\nB", width, height, fontSize, measure).mode).toBe(
      "overflow",
    );
  expect(
    fitStaticLines("A\nB", 100, 24, 10, () => ({
      x: NaN,
      y: 0,
      width: 1,
      height: 1,
    })).mode,
  ).toBe("overflow");
  expect(
    fitTextWidth("A", 10, () => ({ x: 0, y: 0, width: -1, height: 1 }))
      .overflow,
  ).toBe(true);
});
it("caches each measured string only within one layout call and never mutates caller metrics", () => {
  const seen = new Map<string, number>(),
    metrics = Object.freeze(measure("A"));
  const read = (value: string) => {
    seen.set(value, (seen.get(value) ?? 0) + 1);
    return value === "A" ? metrics : measure(value);
  };
  fitStaticLines("A\nA\nA\nA", 100, 24, 10, read);
  expect(seen.get("A")).toBe(1);
  expect([...seen.values()].every((value) => value === 1)).toBe(true);
  expect(metrics).toEqual(measure("A"));
  fitStaticLines("A\nA", 100, 24, 10, read);
  expect(seen.get("A")).toBe(2);
});
