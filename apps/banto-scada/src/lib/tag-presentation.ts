import type { SlotProvenance } from "./read-slot-session";
import { isSimulatedSlot, type SlotPresentation } from "./slot-presentation";
import type { NumericFormat } from "./project";
/** Host が SDK の解決状態・Quality を変換して渡す表示用データ。Hub wire DTO ではない。 */
export type NumericReading = (
  | { state: "disconnected" | "unresolved" | "invalid" }
  | {
      state: "resolved";
      quality: "good" | "stale" | "bad";
      numericValue: number | null;
      /** bit タグで Good のときだけ。このとき numericValue は null。 */
      boolValue?: boolean;
    }
) & { provenance?: SlotProvenance };
export type TagReadings = ReadonlyMap<string, NumericReading>;
const labels = {
  disconnected: "未接続",
  unresolved: "未解決",
  invalid: "値が不正",
  stale: "更新停止",
  bad: "不良",
  good: "Good",
};
/**
 * Text of a Good finite number. Without a format the value is shown as is.
 * `decimals` rounds with `toFixed` (on the stored binary value); a result
 * that rounds to zero drops its minus sign. The unit follows after a space.
 */
export function formatNumber(value: number, format?: NumericFormat) {
  let text =
    format?.decimals === undefined
      ? String(value)
      : value.toFixed(format.decimals);
  if (/^-0(?:\.0+)?$/.test(text)) text = text.slice(1);
  return format?.unit === undefined ? text : `${text} ${format.unit}`;
}
/** 不成立時に静的テキストや直前値へフォールバックして正常値に見せない。 */
export function presentNumeric(
  reading?: NumericReading,
  format?: NumericFormat,
) {
  let state: keyof typeof labels =
    reading && reading.state !== "resolved" ? reading.state : "disconnected";
  if (reading?.state === "resolved") {
    state = reading.quality;
    if (
      state === "good" &&
      reading.boolValue === undefined &&
      (reading.numericValue === null || !Number.isFinite(reading.numericValue))
    )
      state = "invalid";
  }
  const label = labels[state];
  const origin =
    reading?.state === "resolved" && state !== "invalid"
      ? reading.provenance
      : undefined;
  const simulated = origin && isSimulatedSlot(origin);
  const text =
    state === "good" && reading?.state === "resolved"
      ? reading.boolValue !== undefined
        ? String(reading.boolValue)
        : formatNumber(reading.numericValue!, format)
      : `-- · ${label}`;
  return {
    state,
    label,
    text: simulated ? `SIM · ${text}` : text,
    ...(origin ? { provenance: { ...origin } } : {}),
  };
}
/**
 * A Good number slot shown with the Text's format, keeping the SIM prefix.
 * Other slots and unavailable readings keep their own text.
 */
export function formatSlotText(
  display: SlotPresentation,
  format?: NumericFormat,
) {
  if (
    !format ||
    display.state !== "good" ||
    display.value.type !== "number" ||
    !Number.isFinite(display.value.value)
  )
    return display.text;
  const text = formatNumber(display.value.value, format);
  return isSimulatedSlot(display.provenance) ? `SIM · ${text}` : text;
}
