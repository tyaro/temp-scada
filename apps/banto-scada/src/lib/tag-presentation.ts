import type { SlotProvenance } from "./read-slot-session";
import { isSimulatedSlot } from "./slot-presentation";
/** Host が SDK の解決状態・Quality を変換して渡す表示用データ。Hub wire DTO ではない。 */
export type NumericReading = (
  | { state: "disconnected" | "unresolved" | "invalid" }
  | {
      state: "resolved";
      quality: "good" | "stale" | "bad";
      numericValue: number | null;
    }
) & { provenance?: SlotProvenance };
export type TagReadings = ReadonlyMap<string, NumericReading>;
const labels = {
  disconnected: "未接続",
  unresolved: "未解決",
  invalid: "値が不正",
  stale: "Stale",
  bad: "Bad",
  good: "Good",
};
/** 不成立時に静的テキストや直前値へフォールバックして正常値に見せない。 */
export function presentNumeric(reading?: NumericReading) {
  let state: keyof typeof labels =
    reading && reading.state !== "resolved" ? reading.state : "disconnected";
  if (reading?.state === "resolved") {
    state = reading.quality;
    if (
      state === "good" &&
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
      ? String(reading.numericValue)
      : `-- · ${label}`;
  return {
    state,
    label,
    text: simulated ? `SIM · ${text}` : text,
    ...(origin ? { provenance: { ...origin } } : {}),
  };
}
