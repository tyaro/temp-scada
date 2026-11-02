import type {
  HistoryBin,
  HistoryCoverage,
  HistoryIdentity,
  HistoryQuery,
  HistoryResult,
  HistorySample,
  HistorySeriesResult,
} from "../history-contract";
import { freezeHistory } from "./owned-json";

export interface TrendPoint {
  time: number;
  value: number;
  sample: HistorySample;
}
export interface TrendLane {
  identity: HistoryIdentity;
  points: TrendPoint[];
  nulls: HistorySample[];
  ranges: HistoryBin[];
  gaps: HistoryBin[];
  extent: [number, number] | null;
}
export interface TrendSeries {
  seriesId: string;
  status: HistorySeriesResult["status"];
  lanes: TrendLane[];
  coverage: HistoryCoverage[];
  mixed: HistoryBin[];
  watermark: HistorySeriesResult["watermark"];
}
export interface HistoryTrendModel {
  query: HistoryQuery;
  status: HistoryResult["status"];
  snapshotId: string | null;
  series: TrendSeries[];
}

/** Input is an owned H1 result from the validated controller. Raw observations
 * stay individual points: H1 does not expose internal SDK SourceEpoch. */
export function projectHistoryTrend(result: HistoryResult): HistoryTrendModel {
  return freezeHistory({
    query: { ...result.query, seriesIds: [...result.query.seriesIds] },
    status: result.status,
    snapshotId: result.snapshotId,
    series: result.series.map((series): TrendSeries => {
      const lanes = series.segments.map((identity): TrendLane => ({
        identity: { ...identity },
        points: [],
        nulls: [],
        ranges: [],
        gaps: [],
        extent: null,
      }));
      const bySegment = new Map(
        lanes.map((lane) => [lane.identity.segmentId, lane]),
      );
      for (const sample of series.raw) {
        const lane = bySegment.get(sample.segmentId)!;
        const owned = { ...sample, recordId: { ...sample.recordId } };
        if (sample.value === null) lane.nulls.push(owned);
        else
          lane.points.push({
            time: sample.sampleTimeMs,
            value:
              typeof sample.value === "boolean"
                ? Number(sample.value)
                : sample.value,
            sample: owned,
          });
      }
      const mixed: HistoryBin[] = [];
      for (const bin of series.bins) {
        if (bin.state === "mixedSegment") mixed.push({ ...bin });
        else {
          const lane = bySegment.get(bin.segmentId!)!;
          (bin.state === "gap" ? lane.gaps : lane.ranges).push({ ...bin });
        }
      }
      for (const lane of lanes) {
        if (lane.identity.valueType === "bool") lane.extent = [0, 1];
        else {
          const values = [
            ...lane.points.map((p) => p.value),
            ...lane.ranges.flatMap((b) => [b.min!, b.max!]),
          ];
          if (values.length)
            lane.extent = [Math.min(...values), Math.max(...values)];
        }
      }
      return {
        seriesId: series.seriesId,
        status: series.status,
        lanes,
        coverage: series.coverage.map((range) => ({ ...range })),
        mixed,
        watermark: series.watermark ? { ...series.watermark } : null,
      };
    }),
  });
}

/** Normalize before subtracting to avoid overflow of extreme finite values. */
export function trendY(value: number, extent: [number, number]): number {
  const [low, high] = extent;
  if (low === high) return 0.5;
  const scale = Math.max(Math.abs(low), Math.abs(high), 1);
  return Math.max(
    0,
    Math.min(1, (value / scale - low / scale) / (high / scale - low / scale)),
  );
}
export function trendX(time: number, query: HistoryQuery): number {
  return Math.max(
    0,
    Math.min(1, (time - query.fromMs) / (query.toMs - query.fromMs)),
  );
}
export function historyTime(time: number): string {
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toISOString() : `${time} ms`;
}
export function historyReason(reason: string | null): string {
  const labels: Record<string, string> = {
    bad: "品質不良",
    stale: "更新停止",
    unknownQuality: "品質不明",
    simulationExcluded: "SIM除外",
    unknownSource: "由来不明",
    sourceUnavailable: "取得不能",
    unresolved: "未解決",
    identityPending: "識別確認待ち",
    missingValue: "値なし",
    nonFinite: "非有限",
    typeMismatch: "型不一致",
    unrecorded: "未記録",
    expired: "保持期限経過",
    pendingFlush: "保存待ち",
    recorderStopped: "記録停止",
    samplingMissed: "周期欠測",
    storageLoss: "保存欠落",
    unknownCoverage: "記録範囲未確認",
  };
  return reason === null ? "" : (labels[reason] ?? reason);
}
