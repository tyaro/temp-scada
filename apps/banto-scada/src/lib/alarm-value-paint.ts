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
 * 警報の色を持つ Text の計測の箱を、左右は黒の縁（外側に `alarmOutlineWidth / 2`）、下は下線の下端
 * （縁を含む）まで広げる。上は広げない（計測の箱はフォントの箱で、字形の上に縁の半幅
 * `fontSize × 0.06` より広い余白がある）。状態に関係なく広げるので、警報の状態が変わっても
 * 文字の配置・省略は変わらない。
 * `fitText` はこの箱で収まりを判定し、揃えの余白（2）も縁の外側から取る。
 * 計測は baseline を y=0 とした座標（`TextPrimitive` の probe）。
 */
export function alarmReservedMetrics(
  box: { x: number; y: number; width: number; height: number },
  fontSize: number,
): { x: number; y: number; width: number; height: number } {
  const bleed = alarmOutlineWidth(fontSize) / 2;
  const thickness = Math.max(1, fontSize * 0.08);
  const bottom = Math.max(
    box.y + box.height,
    fontSize * 0.15 + thickness / 2 + bleed,
  );
  return {
    x: box.x - bleed,
    y: box.y,
    width: box.width + bleed * 2,
    height: bottom - box.y,
  };
}

/**
 * 下線の位置と太さ（Text の座標）。計測の `baseline` から `fontSize × 0.15` 下、太さは
 * `max(1, fontSize × 0.08)`、縁取りを含めて Text の枠の内側に収める。`bleed` は
 * `alarmReservedMetrics` で広げた分で、幅と左端は文字の墨の範囲に戻す。
 */
export function alarmUnderlineBox(
  layout: { baseline: number; left: number; inkWidth: number },
  x: number,
  fontSize: number,
  height: number,
  outline: number,
  bleed = 0,
): { x: number; y: number; width: number; height: number } {
  const thickness = Math.max(1, fontSize * 0.08);
  const center = Math.min(
    layout.baseline + fontSize * 0.15,
    height - thickness / 2 - outline / 2,
  );
  return {
    x: x + layout.left + bleed,
    y: center - thickness / 2,
    width: Math.max(0, layout.inkWidth - bleed * 2),
    height: thickness,
  };
}
