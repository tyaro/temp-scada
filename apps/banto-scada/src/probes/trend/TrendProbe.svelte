<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    TrendChart,
    binCount,
    createRangeLoader,
    presetRange,
    type TimeRange,
    type TrendData,
    type TrendFetch,
    type TrendPen,
  } from "@banto-industrial/trend";
  import {
    parseHistoryContract,
    type HistoryQuery,
  } from "../../lib/history-contract";
  import { historyResultToTrendSeries } from "../../lib/history/trend-adapter";

  // #359: 共通部品の TrendChart を、H1 の History の応答から変換した区間で描く。
  // 応答は模擬の source が作り、parseHistoryContract で H1 の契約どおりか確かめてから写す。
  // 操作は e2e/trend-probe.spec.ts が window.__trendProbe から読む。
  const NOW = Date.UTC(2026, 10, 21, 0, 0, 0);
  const GAP_FROM = NOW - 40 * 60_000;
  const GAP_TO = NOW - 32 * 60_000;

  const pens: TrendPen[] = [
    {
      id: "FIC101.PV",
      label: "流量",
      colorSlot: 1,
      unit: "m³/h",
      decimals: 1,
      yMin: 0,
      yMax: 120,
      limits: [
        {
          value: 100,
          side: "upper",
          colorVar: "var(--banto-warning)",
          label: "H",
        },
      ],
    },
    {
      id: "TI201.PV",
      label: "温度",
      colorSlot: 2,
      unit: "℃",
      decimals: 1,
      axis: "right",
    },
    {
      id: "P301.RUN",
      label: "ポンプ運転",
      colorSlot: 3,
      bit: true,
      bitStyle: "band",
    },
  ];

  function valueAt(seriesId: string, t: number): number | boolean {
    const s = (t - NOW) / 60_000;
    if (seriesId === "FIC101.PV") return 80 + 25 * Math.sin(s / 6);
    if (seriesId === "TI201.PV") return 40 + 5 * Math.cos(s / 11);
    return Math.floor(s / 7) % 2 === 0;
  }

  /** H1 の minmax の応答を作る模擬の source（記録 DB の代わり）。 */
  function respond(query: HistoryQuery): unknown {
    const span = query.toMs - query.fromMs;
    // 区間の数は先に整数にする（小数だと最後の区間が要求の終端を越える）。
    const count = Math.min(
      query.maxPointsPerSeries,
      Math.max(1, Math.floor(span / 1000)),
    );
    return {
      version: 1,
      kind: "result",
      query: structuredClone(query),
      status: "ready",
      snapshotId: `probe-${fetches}`,
      series: query.seriesIds.map((seriesId) => {
        const bool = seriesId === "P301.RUN";
        const bins = [];
        for (let i = 0; i < count; i++) {
          const fromMs = query.fromMs + Math.floor((span * i) / count);
          const toMs = query.fromMs + Math.floor((span * (i + 1)) / count);
          const missing = toMs > NOW || (fromMs < GAP_TO && toMs > GAP_FROM);
          const a = Number(valueAt(seriesId, fromMs));
          const b = Number(valueAt(seriesId, toMs));
          bins.push({
            fromMs,
            toMs,
            min: missing ? null : Math.min(a, b),
            max: missing ? null : Math.max(a, b),
            validCount: missing ? 0 : 2,
            invalidCount: 0,
            state: missing ? "gap" : "complete",
            segmentId: "probe",
            source: "internal",
          });
        }
        return {
          seriesId,
          status: "ready",
          segments: [
            {
              seriesId,
              hubInstanceId: "probe",
              incarnationId: `probe:${seriesId}`,
              externalName: seriesId,
              segmentId: "probe",
              valueType: bool ? "bool" : "number",
              unit: null,
              periodMs: 1000,
              source: "internal",
            },
          ],
          raw: [],
          bins,
          coverage: [],
          watermark: null,
        };
      }),
    };
  }

  // H1 の 1 回の問い合わせの上限（history-contract.ts の query の検査）。
  // 製品で 1 時間を超えて見せるときの問い合わせの分割は別に決める。
  const H1_MAX_SPAN_MS = 3_600_000;
  const H1_MAX_POINTS = 8000;
  /** 表示範囲を H1 の上限の幅に収める（右端は保つ）。 */
  function clampToH1(next: TimeRange): TimeRange {
    return next.endMs - next.startMs > H1_MAX_SPAN_MS
      ? { startMs: next.endMs - H1_MAX_SPAN_MS, endMs: next.endMs }
      : next;
  }

  let fetches = 0;
  const requests: { range: TimeRange; bins: number }[] = [];
  const fetchTrend: TrendFetch = async ({ range, penIds, bins }) => {
    fetches++;
    requests.push({ range, bins });
    const query: HistoryQuery = {
      version: 1,
      kind: "query",
      requestId: `probe-${fetches}`,
      seriesIds: [...penIds],
      fromMs: range.startMs,
      toMs: range.endMs,
      mode: "minmax",
      maxPointsPerSeries: Math.min(
        bins,
        Math.floor(H1_MAX_POINTS / penIds.length),
      ),
    };
    const parsed = parseHistoryContract(respond(query));
    if (parsed.kind !== "result") throw Error("unexpected contract");
    for (const series of parsed.series)
      for (const bin of series.bins)
        if (bin.fromMs < query.fromMs || bin.toMs > query.toMs)
          throw Error(`bin outside the query: ${bin.fromMs}..${bin.toMs}`);
    return historyResultToTrendSeries(parsed);
  };

  let range = $state<TimeRange>(presetRange(60 * 60_000, NOW));
  let data = $state<TrendData | null>(null);
  let loading = $state(false);
  let width = $state(0);
  const errors: string[] = [];
  const loader = createRangeLoader({
    fetch: fetchTrend,
    debounceMs: 0,
    onResult(result) {
      data = result;
      loading = false;
    },
    onError(error) {
      errors.push(String(error));
      loading = false;
    },
  });

  $effect(() => {
    if (width < 1) return;
    loading = true;
    loader.request({
      range,
      penIds: pens.map((pen) => pen.id),
      bins: binCount(width),
    });
  });

  onMount(() => {
    (window as unknown as { __trendProbe: unknown }).__trendProbe = {
      get fetches() {
        return fetches;
      },
      get requests() {
        return requests;
      },
      get range() {
        return range;
      },
      get errors() {
        return errors;
      },
      get loaded() {
        return data !== null && !loading;
      },
      now: NOW,
      gap: { fromMs: GAP_FROM, toMs: GAP_TO },
    };
  });
  onDestroy(() => loader.dispose());
</script>

<main class="probe">
  <h1>トレンド実証（#359）</h1>
  <TrendChart
    {range}
    {pens}
    {data}
    {loading}
    bind:width
    label="実証のトレンド"
    height={360}
    nowMs={NOW}
    onRangeChange={(next) => (range = clampToH1(next))}
  />
</main>

<style>
  .probe {
    padding: var(--banto-space-4, 16px);
    background: var(--banto-bg, Canvas);
    color: var(--banto-text, CanvasText);
    min-height: 100vh;
    box-sizing: border-box;
  }
  h1 {
    font-size: 1rem;
    margin: 0 0 var(--banto-space-2, 8px);
  }
</style>
