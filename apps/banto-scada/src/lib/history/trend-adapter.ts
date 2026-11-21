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
  const bins = [...series.bins]
    .sort((a, b) => a.fromMs - b.fromMs)
    .map((bin) => {
      const missing = bin.state === "gap" || bin.state === "mixedSegment";
      return {
        tMs: bin.fromMs,
        min: missing ? null : bin.min,
        max: missing ? null : bin.max,
      };
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
