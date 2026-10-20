import type { TextMetrics } from "./text-layout";

/** One LF-free paragraph. Every grapheme is emitted once, including whitespace. */
export function wrapStaticLine(
  text: string,
  width: number,
  measure: (value: string) => TextMetrics,
): string[] {
  if (!Number.isFinite(width) || width <= 0)
    throw new Error("折返し幅が不正です。");
  if (!text) return [""];
  const segments = [
    ...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(text),
  ];
  const offsets = [...segments.map((item) => item.index), text.length];
  const boundaries = new Set(
    [...new Intl.Segmenter("ja", { granularity: "word" }).segment(text)].map(
      (item) => item.index + item.segment.length,
    ),
  );
  const fits = (from: number, to: number) => {
    const box = measure(text.slice(offsets[from], offsets[to]));
    if (
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.width < 0 ||
      box.height < 0
    )
      throw new Error("文字を計測できません。");
    return box.width <= width;
  };
  const lines: string[] = [];
  for (let start = 0; start < segments.length;) {
    let low = start,
      high = segments.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(start, middle)) low = middle;
      else high = middle - 1;
    }
    let end = Math.max(start + 1, low); // An oversized grapheme still advances; fitting decides the warning.
    if (end < segments.length) {
      for (let index = end; index > start; index--) {
        if (boundaries.has(offsets[index])) {
          end = index;
          break;
        }
      }
    }
    lines.push(text.slice(offsets[start], offsets[end]));
    start = end;
  }
  return lines;
}
