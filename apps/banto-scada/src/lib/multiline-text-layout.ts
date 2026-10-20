import type { TextMetrics } from "./text-layout";
import { normalizeTextNewlines } from "./text-content";
export { normalizeTextNewlines } from "./text-content";
export interface WidthFittedText {
  text: string;
  box: TextMetrics;
  truncated: boolean;
  overflow: boolean;
}
const emptyBox = (): TextMetrics => ({ x: 0, y: 0, width: 0, height: 0 });
const validBox = (box: TextMetrics) =>
  [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
  box.width >= 0 &&
  box.height >= 0;
/** Width only, independent of baseline and line height. Force an ellipsis for hidden later lines. */
export function fitTextWidth(
  text: string,
  availableWidth: number,
  measure: (value: string) => TextMetrics,
  forceEllipsis = false,
): WidthFittedText {
  const overflow = (): WidthFittedText => ({
    text: "",
    box: emptyBox(),
    truncated: true,
    overflow: true,
  });
  const result = (
    value: string,
    truncated: boolean,
  ): WidthFittedText | null => {
    const box = value ? measure(value) : emptyBox();
    return validBox(box) && box.width <= availableWidth
      ? { text: value, box, truncated, overflow: false }
      : null;
  };
  if (!Number.isFinite(availableWidth)) return overflow();
  if (!text && !forceEllipsis)
    return { text: "", box: emptyBox(), truncated: false, overflow: false };
  if (!forceEllipsis) {
    const full = result(text, false);
    if (full) return full;
  }
  if (!result("…", true)) return overflow();
  const segments = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
  ].map((entry) => entry.segment);
  let low = 0,
    high = segments.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (result(segments.slice(0, middle).join("") + "…", true)) low = middle;
    else high = middle - 1;
  }
  return result(segments.slice(0, low).join("") + "…", true)!;
}
export interface StaticLine {
  text: string;
  baseline: number;
  left: number;
  inkWidth: number;
}
export interface StaticLinesLayout {
  mode: "full" | "ellipsis" | "overflow";
  lines: StaticLine[];
  totalLines: number;
  visibleLines: number;
}
/** Static explicit-newline text only. Existing one-line and dynamic layout stays in fitText. */
export function fitStaticLines(
  text: string,
  width: number,
  height: number,
  fontSize: number,
  measure: (value: string) => TextMetrics,
): StaticLinesLayout {
  const original = normalizeTextNewlines(text).split("\n"),
    totalLines = original.length;
  const overflow = (): StaticLinesLayout => ({
    mode: "overflow",
    lines: [],
    totalLines,
    visibleLines: 0,
  });
  const step = fontSize * 1.2;
  if (
    ![width, height, fontSize, step].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    fontSize <= 0 ||
    step <= 0
  )
    return overflow();
  const cache = new Map<string, TextMetrics>();
  const cached = (value: string) => {
    let box = cache.get(value);
    if (!box) {
      box = measure(value);
      cache.set(value, box);
    }
    return box;
  };
  const reference = cached("Mgあ");
  if (!validBox(reference)) return overflow();
  const baseline = (step - reference.height) / 2 - reference.y;
  const normal = original.map((line) => fitTextWidth(line, width - 4, cached));
  for (
    let count = Math.min(totalLines, Math.floor(height / step));
    count > 0;
    count--
  ) {
    const fitted = normal.slice(0, count);
    if (count < totalLines)
      fitted[count - 1] = fitTextWidth(
        original[count - 1],
        width - 4,
        cached,
        true,
      );
    if (fitted.some((line) => line.overflow)) continue;
    let top = 0,
      bottom = count * step;
    fitted.forEach((line, index) => {
      if (!line.text) return;
      const y = baseline + index * step + line.box.y;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + line.box.height);
    });
    if (
      !Number.isFinite(top) ||
      !Number.isFinite(bottom) ||
      bottom - top > height
    )
      continue;
    const shift = (height - (bottom - top)) / 2 - top;
    return {
      mode:
        count < totalLines || fitted.some((line) => line.truncated)
          ? "ellipsis"
          : "full",
      totalLines,
      visibleLines: count,
      lines: fitted.map((line, index) => ({
        text: line.text,
        baseline: baseline + index * step + shift,
        left: line.box.x,
        inkWidth: line.box.width,
      })),
    };
  }
  return overflow();
}
