import type { FillPaint, PaintColor } from "../project";
import { parseNumericProperty } from "./numeric-properties";
export const radialPercent = (value: number) => String(value * 100);
export function radialGradientFromForm(
  data: Pick<FormData, "get">,
  baseline?: Extract<FillPaint, { type: "radialGradient" }>,
): Extract<FillPaint, { type: "radialGradient" }> {
  const percent = (name: string, before?: number) => {
    const raw = String(data.get(name));
    const value = parseNumericProperty(raw) / 100;
    // Preserve untouched f64 values across percentage multiplication and division.
    return before !== undefined && raw === radialPercent(before)
      ? before
      : value;
  };
  const center = {
    x: percent("radialCenterX", baseline?.center.x),
    y: percent("radialCenterY", baseline?.center.y),
  };
  const radius = percent("radialRadius", baseline?.radius);
  if (center.x < 0 || center.x > 1 || center.y < 0 || center.y > 1)
    throw new Error("放射グラデーションの中心は0〜100%にしてください。");
  if (radius <= 0 || radius > 2)
    throw new Error(
      "放射グラデーションの半径は0より大きく200%以下にしてください。",
    );
  const color = (prefix: string, before?: PaintColor): PaintColor => {
    const color = String(data.get(`${prefix}Color`)),
      alpha = percent(`${prefix}Alpha`, before?.alpha);
    if (!/^#[0-9a-fA-F]{6}$/.test(color))
      throw new Error("放射グラデーションの色を6桁のHEXで指定してください。");
    if (alpha < 0 || alpha > 1)
      throw new Error("放射グラデーションの不透明度は0〜100%にしてください。");
    return { color, alpha };
  };
  return {
    type: "radialGradient",
    center,
    radius,
    start: color("radialStart", baseline?.start),
    end: color("radialEnd", baseline?.end),
  };
}
