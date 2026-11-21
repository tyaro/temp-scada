<script lang="ts">
  import { onMount } from "svelte";
  import {
    TrendChart,
    type TrendData,
    type TrendPen as ChartPen,
  } from "@banto-industrial/trend";
  import type { HistoryPresentation } from "./presentation";
  import { historyTime } from "./trend-model";
  import {
    historyResultToTrendSeries,
    isBoolSeries,
    nearestColorSlots,
    type Rgb,
  } from "./trend-adapter";
  import type { TrendPen } from "../trend-definitions";

  // #359: 描画は共通部品 TrendChart。全系列を 1 枚に重ね、範囲は取得した query に固定する
  // （設計 historian-history-presentation.md の「共通部品への置き換え」）。
  let {
    state: presentation,
    pens = [],
  }: {
    state: HistoryPresentation;
    pens?: readonly Pick<TrendPen, "seriesId" | "label" | "color">[];
  } = $props();

  const phaseText = $derived(
    {
      offline: "履歴は未接続です",
      idle: "期間と系列を選んで取得してください",
      loading: presentation.waiting
        ? "前の読取の終了を待っています"
        : "履歴を取得中です",
      ready: "履歴を取得しました",
      partial: "一部の系列を取得できませんでした",
      unavailable: "履歴を利用できません",
      invalid: "履歴応答を確認できません",
      error:
        presentation.errorCode === "tooManyPoints"
          ? "点数が上限を超えています。期間を短くするかmin/maxを選択してください"
          : "履歴を取得できませんでした",
      cancelled: "履歴の取得を取り消しました",
      disposed: "履歴表示を終了しました",
    }[presentation.phase],
  );

  const result = $derived(presentation.result);
  const ready = $derived(
    result?.series.filter((series) => series.status === "ready") ?? [],
  );
  const failed = $derived(
    result?.series.filter((series) => series.status !== "ready") ?? [],
  );
  // Only identity matches receive presentation overrides; no positional mapping.
  const penFor = (seriesId: string) =>
    pens.find((pen) => pen.seriesId === seriesId);
  const nameOf = (seriesId: string) =>
    penFor(seriesId)?.label ??
    result?.series.find((series) => series.seriesId === seriesId)?.segments[0]
      ?.externalName ??
    seriesId;

  // 部品は色の枠しか受けないので、テーマの枠の計算後の色から近い枠を選ぶ（banto-industrial#1272 までのつなぎ）。
  let palette = $state<(Rgb | null)[]>([]);
  function readPalette() {
    const probe = document.createElement("span");
    probe.style.display = "none";
    document.body.append(probe);
    palette = Array.from({ length: 8 }, (_, index) => {
      probe.style.color = `var(--banto-chart-${index + 1})`;
      const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(
        getComputedStyle(probe).color,
      );
      return match
        ? [Number(match[1]), Number(match[2]), Number(match[3])]
        : null;
    });
    probe.remove();
  }
  onMount(() => {
    readPalette();
    const observer = new MutationObserver(readPalette);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    return () => observer.disconnect();
  });

  const chartPens = $derived.by((): ChartPen[] => {
    if (!result) return [];
    const raw = result.query.mode === "raw";
    const slots = nearestColorSlots(
      ready.map((series) => penFor(series.seriesId)?.color),
      palette,
    );
    let analog = 0;
    return ready.map((series, index) => {
      const bool = isBoolSeries(series);
      // 2 本目の数値のペンは右の目盛り（部品の目盛りは左右の 2 本）。
      const axis = !bool && analog++ === 1 ? ("right" as const) : undefined;
      const pen: ChartPen = {
        id: series.seriesId,
        label: nameOf(series.seriesId),
        colorSlot: slots[index],
        unit: series.segments[0]?.unit ?? null,
        ...(axis ? { axis } : {}),
      };
      // raw は点だけ（点の間を結ばない）。bool の minmax は区間の帯。
      if (raw) return { ...pen, lineStyle: "none", marker: "circle" };
      return bool ? { ...pen, bit: true, bitStyle: "band" } : pen;
    });
  });
  const range = $derived(
    result
      ? { startMs: result.query.fromMs, endMs: result.query.toMs }
      : undefined,
  );
  const data = $derived<TrendData | null>(
    result && range
      ? { range, series: historyResultToTrendSeries(result) }
      : null,
  );
  const mixedCount = $derived(
    ready.reduce(
      (sum, series) =>
        sum + series.bins.filter((bin) => bin.state === "mixedSegment").length,
      0,
    ),
  );
</script>

<section
  class="history-trend"
  aria-label="履歴トレンド"
  data-history-phase={presentation.phase}
>
  <header>
    <strong>履歴トレンド</strong><span role="status">{phaseText}</span>
  </header>
  {#if result && range}
    <p class="range">
      {historyTime(result.query.fromMs)} 〜 {historyTime(result.query.toMs)} · UTC・終了時刻を含まない（グラフの目盛りは端末の地方時）
    </p>
    <p class="mode">
      {result.query.mode === "raw"
        ? "観測点を表示します。点の間は結びません。"
        : "区間ごとの最小・最大を縦の線で示し、隣の区間とつなぎます。区間内の順序は表しません。"}
    </p>
    {#if chartPens.length}
      <TrendChart
        {range}
        pens={chartPens}
        {data}
        label="履歴トレンドのグラフ"
        legendLabel="履歴トレンドの凡例"
        height={320}
        emptyMessage="この期間に表示できる数値はありません"
      >
        {#snippet legendBadge(pen)}<small
            class="series-id"
            data-history-legend-series={pen.id}>系列ID: {pen.id}</small
          >{/snippet}
      </TrendChart>
    {/if}
    {#each failed as series (series.seriesId)}
      <p class="notice" data-history-series-status={series.status}>
        {nameOf(series.seriesId)}: {series.status === "unknownSeries"
          ? "系列が見つかりません。未記録やゼロ値とは区別します。"
          : "この系列の履歴を取得できません。"}
      </p>
    {/each}
    {#if mixedCount}<p class="notice" data-history-mixed>
        記録の意味・時刻domain等が混在する区間 {mixedCount}件。最小・最大を混ぜて表示しません。
      </p>{/if}
    <p class="notice">記録範囲・品質・系列の切れ目はまだ表示しません。</p>
  {/if}
</section>

<style>
  .history-trend {
    color: var(--banto-text);
    background: var(--banto-surface);
    border: 1px solid var(--banto-border);
    border-radius: 8px;
    padding: 16px;
    font-size: 13px;
  }
  header {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  header strong {
    font-size: 16px;
  }
  .series-id {
    margin-left: 0.4em;
    color: var(--banto-text-muted);
  }
  header span,
  .range,
  .mode,
  .notice {
    color: var(--banto-text-muted);
  }
</style>
