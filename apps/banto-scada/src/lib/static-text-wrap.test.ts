import { expect, it } from "vitest";
import { wrapStaticLine } from "./static-text-wrap";
import { fitStaticLines } from "./multiline-text-layout";
const measure = (text: string) => ({
  x: 0,
  y: -8,
  width:
    [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text)]
      .length * 6,
  height: 10,
});
it("prefers word boundaries and preserves all spaces without rewriting the paragraph", () => {
  expect(wrapStaticLine("alpha beta gamma", 36, measure)).toEqual([
    "alpha ",
    "beta ",
    "gamma",
  ]);
  for (const text of [
    "  alpha  beta ",
    "日本語のポンプ監視。 ",
    "  ",
    "abc\tdef",
    "https://example.test/long/path",
    "👨‍👩‍👧‍👦e\u0301🇯🇵X",
  ])
    for (const width of [1, 6, 12, 24, 60, 1000]) {
      const lines = wrapStaticLine(text, width, measure);
      expect(lines.join("")).toBe(text);
      const original = [
        ...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text),
      ].map((s) => s.segment);
      expect(
        lines.flatMap((line) =>
          [
            ...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(
              line,
            ),
          ].map((s) => s.segment),
        ),
      ).toEqual(original);
    }
  expect(wrapStaticLine("", 10, measure)).toEqual([""]);
});
it("splits oversized words and graphemes progress even when none fits", () => {
  expect(wrapStaticLine("abcdef", 12, measure)).toEqual(["ab", "cd", "ef"]);
  expect(wrapStaticLine("👨‍👩‍👧‍👦e\u0301X", 1, measure)).toEqual([
    "👨‍👩‍👧‍👦",
    "e\u0301",
    "X",
  ]);
  expect(fitStaticLines("abc", 5, 60, 10, measure, "word").mode).toBe(
    "overflow",
  );
});
it("keeps explicit blank rows, changes layout with width and uses one ellipsis for hidden rows", () => {
  const full = fitStaticLines("\nalpha beta\n\n", 40, 100, 10, measure, "word");
  expect(full.mode).toBe("full");
  expect(full.lines.map((l) => l.text)).toEqual(["", "alpha ", "beta", "", ""]);
  expect(
    fitStaticLines("alpha beta", 100, 100, 10, measure, "word").totalLines,
  ).toBe(1);
  const short = fitStaticLines("alpha beta gamma", 40, 24, 10, measure, "word");
  expect(short.visibleLines).toBe(2);
  expect(short.mode).toBe("ellipsis");
  expect(short.lines[1].text.endsWith("…")).toBe(true);
  expect(
    short.lines.flatMap((l) => [...l.text]).filter((c) => c === "…"),
  ).toHaveLength(1);
  expect(fitStaticLines("alpha beta", 40, 100, 10, measure).totalLines).toBe(1);
});
it("uses the supplied measured width and contains invalid measurements", () => {
  const wide = (s: string) => ({ ...measure(s), width: measure(s).width * 2 });
  expect(wrapStaticLine("abcd", 24, wide)).toEqual(["ab", "cd"]);
  for (const width of [0, -1, NaN, Infinity])
    expect(() => wrapStaticLine("a", width, measure)).toThrow();
  expect(() =>
    wrapStaticLine("a", 12, () => ({ ...measure("a"), width: NaN })),
  ).toThrow();
  expect(
    fitStaticLines(
      "a",
      30,
      30,
      10,
      () => ({ ...measure("a"), width: NaN }),
      "word",
    ).mode,
  ).toBe("overflow");
});
it("shares one bounded measurement cache per layout and never mutates the metrics", () => {
  const seen = new Map<string, number>();
  fitStaticLines(
    "alpha beta alpha beta",
    40,
    100,
    10,
    (text) => {
      seen.set(text, (seen.get(text) ?? 0) + 1);
      return Object.freeze(measure(text));
    },
    "word",
  );
  expect([...seen.values()].every((n) => n === 1)).toBe(true);
});
