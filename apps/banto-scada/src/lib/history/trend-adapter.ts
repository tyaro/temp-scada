import type { TrendSeries } from "@banto-industrial/trend";
import type { HistoryResult, HistorySeriesResult } from "../history-contract";

/**
 * Issue #359: H1 の History の応答を、共通部品 `@banto-industrial/trend` の
 * 区間の契約（`{ tMs, min, max }` と系列ごとの `binMs`）へ写す。
 *
 * 写すときに落ちるもの（共通の契約に無い）: 品質・理由、coverage、`partial`／`mixedSegment`
 * の区別、件数。この関数は segment を分けない（実証のページ用）。製品は `historyTrendPens`。
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

/** 履歴のペン 1 本。segment が 1 つなら系列そのもの、複数なら segment ごと。 */
export interface HistoryTrendPen {
  /** 分けなければ系列ID。分けたときは `系列ID~番号`。 */
  id: string;
  seriesId: string;
  unit: string | null;
  bool: boolean;
  /** segment ごとに分けたときの何番目か・いくつに分けたか。分けなければ null。 */
  part: { index: number; count: number } | null;
  series: TrendSeries;
}

/**
 * ready の系列をペンにする。segment（記録の意味・単位・型の区切り）が複数ある系列は segment ごとの
 * ペンに分け、ほかの segment の区間は欠測にする。線は segment ごとの別の path になり、
 * segment をまたいでつながらない。区間の時刻と長さは変えない（欠測の区間を挟んで正常な区間を
 * 打ち切らない）。bool の minmax は段の形にする（`boolSteps`）。
 */
export function historyTrendPens(result: HistoryResult): HistoryTrendPen[] {
  const raw = result.query.mode === "raw";
  const pens: HistoryTrendPen[] = [];
  for (const series of result.series) {
    if (series.status !== "ready") continue;
    const segments = series.segments;
    if (segments.length <= 1) {
      const bool = segments[0]?.valueType === "bool";
      pens.push({
        id: series.seriesId,
        seriesId: series.seriesId,
        unit: segments[0]?.unit ?? null,
        bool,
        part: null,
        series: raw ? fromRaw(series) : fromBins(series, undefined, bool),
      });
      continue;
    }
    segments.forEach((segment, index) => {
      const keep = new Set([segment.segmentId]);
      const bool = segment.valueType === "bool";
      pens.push({
        id: `${series.seriesId}~${index + 1}`,
        seriesId: series.seriesId,
        unit: segment.unit,
        bool,
        part: { index: index + 1, count: segments.length },
        series: raw ? fromRaw(series, keep) : fromBins(series, keep, bool),
      });
    });
  }
  return pens;
}

function fromBins(
  series: HistorySeriesResult,
  keep?: ReadonlySet<string>,
  bool = false,
): TrendSeries {
  const sorted = [...series.bins].sort((a, b) => a.fromMs - b.fromMs);
  const bins: { tMs: number; min: number | null; max: number | null }[] = [];
  for (const bin of sorted) {
    const missing =
      bin.state === "gap" ||
      bin.state === "mixedSegment" ||
      (keep !== undefined &&
        (bin.segmentId === null || !keep.has(bin.segmentId)));
    const value = {
      min: missing ? null : bin.min,
      max: missing ? null : bin.max,
    };
    if (bool && !missing) bins.push(...boolSteps(bin.fromMs, bin.toMs, value));
    else bins.push({ tMs: bin.fromMs, ...value });
  }
  // 区間の幅は応答の実際の値。H1 は範囲を整数で割るので 1ms ずれることがあり、広い方を採る。
  const binMs = series.bins.reduce(
    (width, bin) => Math.max(width, bin.toMs - bin.fromMs),
    1,
  );
  return { bins, binMs };
}

/**
 * bool の区間を、始め・中・終わりの 3 つの小区間に分ける。部品の包絡は区間の中央の縦線を
 * 隣の区間の近い端へつなぐので、1 区間 1 点では OFF→ON が斜めの線になる。小区間に分けると、
 * 区間の中は水平で、区間の境目でほぼ垂直に変わる段の形になる（両方の状態を含む区間は縦線）。
 */
export function boolSteps(
  fromMs: number,
  toMs: number,
  value: { min: number | null; max: number | null },
): { tMs: number; min: number | null; max: number | null }[] {
  const width = toMs - fromMs;
  if (!(width > 0)) return [{ tMs: fromMs, ...value }];
  const edge = width / 1000;
  return [
    { tMs: fromMs, ...value },
    { tMs: fromMs + edge, ...value },
    { tMs: toMs - edge, ...value },
  ];
}

function fromRaw(
  series: HistorySeriesResult,
  keep?: ReadonlySet<string>,
): TrendSeries {
  const bins = [...series.raw]
    .filter((sample) => keep === undefined || keep.has(sample.segmentId))
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
