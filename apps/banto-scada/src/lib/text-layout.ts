export const TEXT_FONT = 'Arial, "Noto Sans", "Noto Sans CJK JP", sans-serif';
export interface TextMetrics {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type TextLayout = {
  mode: "full" | "ellipsis" | "overflow";
  text: string;
  baseline: number;
  left: number;
  inkWidth: number;
};
/** Measurements are SVG design units, never viewport pixels or character-count estimates. */
export function fitText(
  text: string,
  width: number,
  height: number,
  fontSize: number,
  numeric: boolean,
  measure: (value: string) => TextMetrics,
): TextLayout {
  if (!text)
    return { mode: "full", text: "", baseline: 0, left: 0, inkWidth: 0 };
  const available = width - 4;
  const fits = (box: TextMetrics) =>
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width <= available &&
    box.height <= height &&
    fontSize * 1.2 <= height;
  const result = (
    value: string,
    mode: TextLayout["mode"],
  ): TextLayout | null => {
    const box = measure(value);
    return fits(box)
      ? {
          text: value,
          mode,
          baseline: (height - box.height) / 2 - box.y,
          left: box.x,
          inkWidth: box.width,
        }
      : null;
  };
  const full = result(text, "full");
  if (full) return full;
  if (numeric)
    return (
      result("###", "overflow") ?? {
        text: "",
        mode: "overflow",
        baseline: 0,
        left: 0,
        inkWidth: 0,
      }
    );
  if (!result("…", "ellipsis"))
    return { text: "", mode: "overflow", baseline: 0, left: 0, inkWidth: 0 };
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
  ].map((entry) => entry.segment);
  let low = 0,
    high = graphemes.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (result(graphemes.slice(0, middle).join("") + "…", "ellipsis"))
      low = middle;
    else high = middle - 1;
  }
  return result(graphemes.slice(0, low).join("") + "…", "ellipsis")!;
}
