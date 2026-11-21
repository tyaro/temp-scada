import type { TrendSeries } from "@banto-industrial/trend";
import type { HistoryResult, HistorySeriesResult } from "../history-contract";

/**
 * Issue #359: H1 の History の応答を、共通部品 `@banto-industrial/trend` の
 * 区間の契約（`{ tMs, min, max }` と系列ごとの `binMs`）へ写す。
 *
 * 写すときに落ちるもの（共通の契約に無い）: segment の切れ目（identity の変化）、
 * 品質・理由、coverage、`partial`／`mixedSegment` の区別、件数。
 * `gap` と `mixedSegment` の区間は欠測（min・max とも null）として線をつながない。
 * raw の点は min = max の区間にし、bool は 0／1 にする。
 */
export function historyResultToTrendSeries(
  result: HistoryResult,
): Record<string, TrendSeries> {
  const out: Record<string, TrendSeries> = {};
  for (const series of result.series) {
    if (series.status !== "ready") continue;
    out[series.seriesId] =
      result.query.mode === "raw" ? fromRaw(series) : fromBins(series);
  }
  return out;
}

function fromBins(series: HistorySeriesResult): TrendSeries {
  const sorted = [...series.bins].sort((a, b) => a.fromMs - b.fromMs);
  const bins: { tMs: number; min: number | null; max: number | null }[] = [];
  sorted.forEach((bin, index) => {
    const previous = sorted[index - 1];
    // segment が変わる所では、直前に欠測の区間を挟んで線を切る（segment をまたぐ偽の連続を作らない）。
    // 欠測の区間は次の区間の 1ms 前から。区間が 1ms しか離れていないときは間の小数の時刻に置く。
    if (
      previous &&
      previous.segmentId !== null &&
      bin.segmentId !== null &&
      previous.segmentId !== bin.segmentId &&
      bin.fromMs > previous.fromMs
    )
      bins.push({
        tMs: Math.max(bin.fromMs - 1, (previous.fromMs + bin.fromMs) / 2),
        min: null,
        max: null,
      });
    const missing = bin.state === "gap" || bin.state === "mixedSegment";
    bins.push({
      tMs: bin.fromMs,
      min: missing ? null : bin.min,
      max: missing ? null : bin.max,
    });
  });
  // 区間の幅は応答の実際の値。H1 は範囲を整数で割るので 1ms ずれることがあり、広い方を採る。
  const binMs = series.bins.reduce(
    (width, bin) => Math.max(width, bin.toMs - bin.fromMs),
    1,
  );
  return { bins, binMs };
}

function fromRaw(series: HistorySeriesResult): TrendSeries {
  const bins = [...series.raw]
    .sort((a, b) => a.sampleTimeMs - b.sampleTimeMs)
    .map((sample) => {
      const value =
        sample.value === null
          ? null
          : typeof sample.value === "boolean"
            ? Number(sample.value)
            : sample.value;
      return { tMs: sample.sampleTimeMs, min: value, max: value };
    });
  const periods = series.segments.map((segment) => segment.periodMs);
  const binMs = periods.length ? Math.max(1, Math.min(...periods)) : 1;
  return { bins, binMs };
}

/** bool の系列か（segment の値の型で判断する。segment が無ければ false）。 */
export function isBoolSeries(series: HistorySeriesResult): boolean {
  return (
    series.segments.length > 0 &&
    series.segments.every((segment) => segment.valueType === "bool")
  );
}

export type Rgb = readonly [number, number, number];

/** `#rrggbb` を RGB に。形が違えば null。 */
export function hexRgb(color: string | undefined): Rgb | null {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color ?? "");
  return match
    ? [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)]
    : null;
}

/**
 * ペンの色（hex）に最も近い色の枠（1 始まり）を、ペンどうしで重ならないように選ぶ。
 * `palette[i]` は枠 i + 1 の計算後の色（読めなければ null）。色を決めていないペンと、
 * 空きの枠が無いペンは、残りの枠を順に使い、それも尽きたら 9〜16（部品の `--bi-chart-N`）を使う。
 * 上流が CSS の色を受けるようになるまでのつなぎ（banto-industrial#1272）。
 */
export function nearestColorSlots(
  colors: readonly (string | undefined)[],
  palette: readonly (Rgb | null)[],
): number[] {
  const used = new Set<number>();
  const slots: (number | undefined)[] = colors.map(() => undefined);
  colors.forEach((color, index) => {
    const rgb = hexRgb(color);
    if (!rgb) return;
    let best: number | undefined;
    let bestDistance = Infinity;
    palette.forEach((candidate, slotIndex) => {
      if (!candidate || used.has(slotIndex + 1)) return;
      const distance =
        (candidate[0] - rgb[0]) ** 2 +
        (candidate[1] - rgb[1]) ** 2 +
        (candidate[2] - rgb[2]) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = slotIndex + 1;
      }
    });
    if (best !== undefined) {
      used.add(best);
      slots[index] = best;
    }
  });
  let next = 1;
  return slots.map((slot) => {
    if (slot !== undefined) return slot;
    while (used.has(next) && next < 16) next++;
    used.add(next);
    return next;
  });
}
