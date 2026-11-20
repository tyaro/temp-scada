import type { AlarmSeverity } from "./alarms";
import type { AlarmValueColor } from "./alarm-value-color";
import { contrastRatio } from "./canvas-colors";

/**
 * 数値の警報の色の見た目（意味 → 色・縁取り）。状態の合成は `alarm-value-color.ts`。
 * 仕様: docs/design/graphics/alarm-value-color.md「見た目」。
 */

export type AlarmPaintKey = AlarmSeverity | "unknown";

/** 部品で固定した色。Project では変えない。 */
export const ALARM_VALUE_COLORS: Record<
  AlarmPaintKey,
  { light: string; dark: string }
> = {
  high: { light: "#dc2626", dark: "#f87171" },
  medium: { light: "#c2410c", dark: "#fb923c" },
  low: { light: "#a16207", dark: "#facc15" },
  unknown: { light: "#6b7280", dark: "#9ca3af" },
};

/** 縁取りの色と、それが要る背景との比の下限。 */
export const ALARM_OUTLINE_COLOR = "#000000";
export const ALARM_MIN_CONTRAST = 4.5;

export interface AlarmColorChoice {
  color: string;
  /** 黒の縁取りを付ける（どちらの組も背景との比が 4.5 に届かない）。 */
  outline: boolean;
}

/**
 * 色ごとに、画面の背景との比の高い方の組を選ぶ。どちらも 4.5 に届かなければ、
 * 暗い組の色に黒の縁取りを付ける。
 */
export function alarmColorOn(
  key: AlarmPaintKey,
  background: string,
): AlarmColorChoice {
  const { light, dark } = ALARM_VALUE_COLORS[key];
  const onLight = contrastRatio(light, background);
  const onDark = contrastRatio(dark, background);
  if (Math.max(onLight, onDark) < ALARM_MIN_CONTRAST)
    return { color: dark, outline: true };
  return { color: onLight >= onDark ? light : dark, outline: false };
}

/** 縁取りの太さ（SVG の `stroke-width`、`paint-order: stroke` で外側だけが見える）。 */
export function alarmOutlineWidth(fontSize: number): number {
  return Math.max(1, fontSize * 0.12);
}

export type AlarmTextTone = "normal" | AlarmSeverity | "unknown";

/** `TextPrimitive` に渡す、色ごとの選択と縁取りの結果。 */
export interface AlarmTextPaint {
  tone: AlarmTextTone;
  /** 文字の色。`normal` のときは無い（配置の fill のまま）。 */
  text?: AlarmColorChoice;
  underline?: AlarmColorChoice & { severity: AlarmSeverity };
  blink: boolean;
  title: string;
}

export function alarmTextPaint(
  value: AlarmValueColor,
  background: string,
): AlarmTextPaint {
  const tone: AlarmTextTone =
    value.tone === "severity"
      ? (value.severity ?? "high")
      : value.tone === "unknown"
        ? "unknown"
        : "normal";
  return {
    tone,
    ...(tone === "normal" ? {} : { text: alarmColorOn(tone, background) }),
    ...(value.underline
      ? {
          underline: {
            ...alarmColorOn(value.underline, background),
            severity: value.underline,
          },
        }
      : {}),
    blink: value.blink,
    title: value.title,
  };
}

/**
 * 下線の位置と太さ（Text の座標）。計測の `baseline` から `fontSize × 0.15` 下、太さは
 * `max(1, fontSize × 0.08)`、縁取りを含めて Text の枠の内側に収める。
 */
export function alarmUnderlineBox(
  layout: { baseline: number; left: number; inkWidth: number },
  x: number,
  fontSize: number,
  height: number,
  outline: number,
): { x: number; y: number; width: number; height: number } {
  const thickness = Math.max(1, fontSize * 0.08);
  const center = Math.min(
    layout.baseline + fontSize * 0.15,
    height - thickness / 2 - outline / 2,
  );
  return {
    x: x + layout.left,
    y: center - thickness / 2,
    width: layout.inkWidth,
    height: thickness,
  };
}
