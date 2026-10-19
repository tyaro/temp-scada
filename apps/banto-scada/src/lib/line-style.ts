import type { LineStyle } from "./project";
export const lineStyles = ["solid", "dashed", "dotted"] as const;
export const lineStyleLabels = {
  solid: "実線",
  dashed: "破線",
  dotted: "点線",
};
export function parseLineStyle(value: unknown): LineStyle {
  if (!lineStyles.includes(value as LineStyle))
    throw new Error("線種は実線・破線・点線から選択してください。");
  return value as LineStyle;
}
export function setLineStyle(
  target: { lineStyle?: LineStyle },
  value: LineStyle,
) {
  parseLineStyle(value);
  if ((target.lineStyle ?? "solid") === value) return;
  if (value === "solid") delete target.lineStyle;
  else target.lineStyle = value;
}
export function lineDash(
  style: LineStyle | undefined,
  width: number,
): string | undefined {
  return style === "dashed"
    ? `${width * 4} ${width * 2}`
    : style === "dotted"
      ? `0 ${width * 2}`
      : undefined;
}
export function lineCap(style: LineStyle | undefined): "round" | "butt" {
  return style === "dashed" ? "butt" : "round";
}
