import type { HistoryQuery } from "../lib/history-contract";
import type { HistoryService } from "../lib/history/workspace-model";
import type { Project } from "../lib/project";
import type { DemoClock, DemoScenario } from "./scenario";

const PERIOD_MS = 1000;
const SESSION = "demo";

/**
 * 模擬の履歴 service。保存トレンドの pen（`seriesId` はタグ名）を系列として出し、
 * 筋書きを過去の時刻で評価して履歴の応答を作る。記録 DB は無く、現在より先は欠測にする。
 * Project を差し替えるたびに作り直す（系列一覧は Project の版に結び付く）。
 */
export function createDemoHistoryService(
  project: Project,
  scenario: DemoScenario,
  clock: DemoClock,
): HistoryService | undefined {
  const trends = project.trends ?? [];
  if (!trends.length) return undefined;
  const labels = new Map<string, string>();
  for (const trend of trends)
    for (const pen of trend.pens)
      if (!labels.has(pen.seriesId))
        labels.set(pen.seriesId, pen.label?.trim() || pen.seriesId);
  const valueAt = (seriesId: string, timeMs: number) => {
    const values = scenario.values(timeMs / 1000);
    return Object.hasOwn(values, seriesId) ? values[seriesId] : undefined;
  };
  const known = (seriesId: string) =>
    labels.has(seriesId) && valueAt(seriesId, clock.nowMs()) !== undefined;

  function series(seriesId: string, query: HistoryQuery) {
    if (!known(seriesId))
      return {
        seriesId,
        status: "unknownSeries",
        segments: [],
        raw: [],
        bins: [],
        coverage: [],
        watermark: null,
      };
    const nowMs = clock.nowMs();
    const bool = typeof valueAt(seriesId, nowMs) === "boolean";
    const segmentId = "demo";
    const segments = [
      {
        seriesId,
        hubInstanceId: "demo",
        incarnationId: `demo:${seriesId}`,
        externalName: seriesId,
        segmentId,
        valueType: bool ? "bool" : "number",
        unit: null,
        periodMs: PERIOD_MS,
        source: "internal",
      },
    ];
    const span = query.toMs - query.fromMs;
    const raw: unknown[] = [];
    const bins: unknown[] = [];
    if (query.mode === "raw") {
      const step =
        Math.max(1, Math.ceil(span / query.maxPointsPerSeries / PERIOD_MS)) *
        PERIOD_MS;
      for (
        let time = Math.ceil(query.fromMs / step) * step;
        time < query.toMs &&
        time <= nowMs &&
        raw.length < query.maxPointsPerSeries;
        time += step
      )
        raw.push({
          seriesId,
          segmentId,
          recordId: { sessionId: SESSION, sequence: time / PERIOD_MS },
          clockEpoch: "demo",
          sampleTimeMs: time,
          sourceTimeMs: time,
          ingestedAtMs: time,
          quality: "good",
          source: "internal",
          value: valueAt(seriesId, time),
          reason: null,
        });
    } else {
      const count = Math.min(
        query.maxPointsPerSeries,
        Math.max(1, Math.floor(span / PERIOD_MS)),
      );
      for (let index = 0; index < count; index++) {
        const fromMs = query.fromMs + Math.floor((span * index) / count);
        const toMs = query.fromMs + Math.floor((span * (index + 1)) / count);
        let min = Infinity,
          max = -Infinity,
          validCount = 0;
        const step = Math.max(PERIOD_MS, Math.ceil((toMs - fromMs) / 8));
        for (let time = fromMs; time < toMs && time <= nowMs; time += step) {
          const value = Number(valueAt(seriesId, time));
          min = Math.min(min, value);
          max = Math.max(max, value);
          validCount += 1;
        }
        bins.push(
          validCount
            ? {
                fromMs,
                toMs,
                min,
                max,
                validCount,
                invalidCount: 0,
                state: "complete",
                segmentId,
                source: "internal",
              }
            : {
                fromMs,
                toMs,
                min: null,
                max: null,
                validCount: 0,
                invalidCount: 0,
                state: "gap",
                segmentId,
                source: "internal",
              },
        );
      }
    }
    return {
      seriesId,
      status: "ready",
      segments,
      raw,
      bins,
      coverage: [],
      watermark: {
        sessionId: SESSION,
        committedThrough: Math.floor(nowMs / PERIOD_MS),
      },
    };
  }

  return {
    source: {
      async query(query) {
        return {
          version: 1,
          kind: "result",
          query: structuredClone(query),
          status: "ready",
          snapshotId: `demo-${clock.nowMs()}`,
          series: query.seriesIds.map((id) => series(id, query)),
        };
      },
    },
    context: {
      version: 3,
      kind: "historyContext",
      contextId: "demo",
      historianNamespace: trends[0].historianNamespace,
      projectId: project.manifest.projectId,
      projectRevision: project.manifest.projectRevision,
      // The browser demo delivers no live data: its trends stay static.
      series: [...labels].map(([seriesId, label]) => ({
        seriesId,
        label,
        liveUnavailable: "recorderStopped",
      })),
    },
  };
}
