import { normalizeRotation } from "../rotation";
import { patternGeometry, type PatternKind } from "../pattern-paint";
import type { FillPaint, PaintColor } from "../project";
import { parseNumericProperty } from "./numeric-properties";
export function patternFromForm(
  data: Pick<FormData, "get">,
): Extract<FillPaint, { type: "pattern" }> {
  const number = (name: string) => parseNumericProperty(String(data.get(name)));
  const color = (prefix: string): PaintColor => {
    const color = String(data.get(`${prefix}Color`)),
      alpha = number(`${prefix}Alpha`) / 100;
    if (!/^#[0-9a-fA-F]{6}$/.test(color))
      throw new Error("模様の色を6桁のHEXで指定してください。");
    if (alpha < 0 || alpha > 1)
      throw new Error("模様の不透明度は0〜100%にしてください。");
    return { color, alpha };
  };
  const kind = String(data.get("patternKind")) as PatternKind,
    spacing = number("patternSpacing"),
    size = number("patternSize");
  patternGeometry(kind, spacing, size);
  const background = data.get("patternBackgroundEnabled");
  if (background !== "true" && background !== "false")
    throw new Error("模様の背景の有無を選択してください。");
  return {
    type: "pattern",
    kind,
    spacing,
    size,
    angle: normalizeRotation(number("patternAngle")),
    foreground: color("patternForeground"),
    background: background === "true" ? color("patternBackground") : null,
  };
}
