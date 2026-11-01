<script lang="ts">
  import type { HistoryPresentation } from "./presentation";
  import {
    projectHistoryTrend,
    trendX,
    trendY,
    historyTime,
    historyReason,
  } from "./trend-model";
  let { state: presentation }: { state: HistoryPresentation } = $props();
  const model = $derived(
    presentation.result ? projectHistoryTrend(presentation.result) : undefined,
  );
  let selected = $state("");
  const series = $derived(
    model?.series.find((row) => row.seriesId === selected) ?? model?.series[0],
  );
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
  const x = (time: number) =>
    model ? 60 + trendX(time, model.query) * 620 : 60;
  const numberLabel = (value: number) =>
    Number.isInteger(value) && Math.abs(value) < 1e8
      ? String(value)
      : value.toPrecision(4);
</script>

<section
  class="history-trend"
  aria-label="履歴トレンド"
  data-history-phase={presentation.phase}
>
  <header>
    <strong>履歴トレンド</strong><span role="status">{phaseText}</span>
  </header>
  {#if model && series}
    <label
      >系列 <select
        value={series.seriesId}
        onchange={(event) => (selected = event.currentTarget.value)}
        aria-label="表示する履歴系列"
      >
        {#each model.series as row}<option value={row.seriesId}
            >{row.lanes[0]?.identity.externalName ?? row.seriesId}</option
          >{/each}
      </select></label
    >
    <p class="range">
      {historyTime(model.query.fromMs)} 〜 {historyTime(model.query.toMs)} · UTC・終了時刻を含まない
    </p>
    <p class="mode">
      {model.query.mode === "raw"
        ? "観測点を表示します。点の間は補間しません。"
        : "区間ごとの最小・最大を表示します。区間内の順序は表しません。"}
    </p>
    {#if series.status !== "ready"}
      <p class="notice">
        {series.status === "unknownSeries"
          ? "系列が見つかりません。未記録やゼロ値とは区別します。"
          : "この系列の履歴を取得できません。"}
      </p>
    {:else}
      <div class="coverage">
        <span>記録範囲</span>
        <svg viewBox="0 0 700 24" role="img" aria-label="記録範囲と欠測理由">
          {#each series.coverage as range}
            <rect
              x={x(range.fromMs)}
              y="2"
              width={Math.max(0.1, x(range.toMs) - x(range.fromMs))}
              height="18"
              data-coverage-reason={range.reason}
            >
              <title
                >{historyReason(range.reason)} · {historyTime(range.fromMs)} 〜 {historyTime(
                  range.toMs,
                )}</title
              >
            </rect>
          {/each}
        </svg>
        <div class="legend">
          {#each [...new Set(series.coverage.map((row) => row.reason))] as reason}<span
              >{historyReason(reason)}</span
            >{/each}
          {#if !series.coverage.length}<span
              >記録範囲の追加情報はありません</span
            >{/if}
        </div>
      </div>
      {#each series.lanes as lane (lane.identity.segmentId)}
        <article data-history-segment={lane.identity.segmentId}>
          <h3>
            {lane.identity.externalName} · {lane.identity.unit ?? "単位なし"}
            <small
              >{lane.identity.segmentId} · {lane.identity.source} · {lane
                .identity.valueType}</small
            >
          </h3>
          <svg
            viewBox="0 0 700 144"
            role="img"
            aria-label={`${lane.identity.externalName} ${lane.identity.segmentId} の履歴`}
          >
            <line class="axis" x1="60" x2="680" y1="116" y2="116" />
            {#if lane.extent}
              <text x="54" y="24" text-anchor="end"
                >{lane.identity.valueType === "bool"
                  ? "true"
                  : numberLabel(lane.extent[1])}</text
              >
              <text x="54" y="116" text-anchor="end"
                >{lane.identity.valueType === "bool"
                  ? "false"
                  : numberLabel(lane.extent[0])}</text
              >
              {#each lane.points as point}
                {@const y = 116 - trendY(point.value, lane.extent) * 92}
                <circle
                  cx={x(point.time)}
                  cy={y}
                  r="3"
                  data-history-point
                  data-record-session={point.sample.recordId.sessionId}
                  data-clock-epoch={point.sample.clockEpoch}
                  data-value={point.value}
                >
                  <title
                    >{historyTime(point.time)} · {lane.identity.valueType ===
                    "bool"
                      ? String(Boolean(point.value))
                      : point.value} · source {point.sample.sourceTimeMs ===
                    null
                      ? "なし"
                      : historyTime(point.sample.sourceTimeMs)} · {point.sample
                      .quality} · {point.sample.source}</title
                  >
                </circle>
              {/each}
              {#each lane.ranges as bin}
                {@const from = x(bin.fromMs)}
                {@const width = Math.max(0.1, x(bin.toMs) - from)}
                {#if lane.identity.valueType === "bool"}
                  {#each bin.min === bin.max ? [bin.min!] : [bin.min!, bin.max!] as value}
                    <line
                      class="boolean-range"
                      x1={from}
                      x2={from + width}
                      y1={116 - trendY(value, lane.extent) * 92}
                      y2={116 - trendY(value, lane.extent) * 92}
                      data-history-envelope
                      data-bin-state={bin.state}
                      data-value={value}
                      ><title
                        >{historyTime(bin.fromMs)} 〜 {historyTime(bin.toMs)} · {Boolean(
                          value,
                        )}を含む · {bin.state}</title
                      ></line
                    >
                  {/each}
                {:else}
                  {@const top = 116 - trendY(bin.max!, lane.extent) * 92}
                  {@const bottom = 116 - trendY(bin.min!, lane.extent) * 92}
                  <rect
                    class="envelope"
                    x={from}
                    y={top}
                    {width}
                    height={Math.max(1, bottom - top)}
                    data-history-envelope
                    data-bin-state={bin.state}
                    data-min={bin.min}
                    data-max={bin.max}
                    ><title
                      >{historyTime(bin.fromMs)} 〜 {historyTime(bin.toMs)} · 最小
                      {bin.min} / 最大 {bin.max} · 有効 {bin.validCount} / 無値 {bin.invalidCount}
                      · {bin.state}</title
                    ></rect
                  >
                {/if}
              {/each}
            {/if}
            {#each lane.nulls as sample}<line
                class="missing"
                x1={x(sample.sampleTimeMs)}
                x2={x(sample.sampleTimeMs)}
                y1="8"
                y2="18"
                data-history-null
                data-null-reason={sample.reason}
                ><title
                  >{historyTime(sample.sampleTimeMs)} · {historyReason(
                    sample.reason,
                  )} · {sample.quality ?? "品質なし"} · {sample.source ??
                    "由来なし"}</title
                ></line
              >{/each}
            {#each lane.gaps as bin}<rect
                class="missing-bin"
                x={x(bin.fromMs)}
                y="8"
                width={Math.max(0.1, x(bin.toMs) - x(bin.fromMs))}
                height="10"
                data-history-gap
                ><title
                  >{historyTime(bin.fromMs)} 〜 {historyTime(bin.toMs)} · 数値なし
                  · 無値 {bin.invalidCount}</title
                ></rect
              >{/each}
          </svg>
          <p class="counts">
            観測点 {lane.points.length} · 無値 {lane.nulls.length} · 範囲 {lane
              .ranges.length} · 数値なし区間 {lane.gaps.length}
          </p>
          {#if lane.nulls.length}<p class="notice">
              {[
                ...new Set(
                  lane.nulls.map((sample) => historyReason(sample.reason)),
                ),
              ].join("・")}
            </p>{/if}
          {#if !lane.points.length && !lane.ranges.length}<p class="notice">
              表示できる数値はありません
            </p>{/if}
        </article>
      {/each}
      {#if series.mixed.length}<p class="notice" data-history-mixed>
          記録の意味・時刻domain等が混在する区間 {series.mixed
            .length}件。最小・最大を混ぜて表示しません。
        </p>{/if}
    {/if}
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
  header span,
  .range,
  .mode,
  .notice,
  .counts,
  small {
    color: var(--banto-text-muted);
  }
  select {
    background: var(--banto-surface);
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    padding: 4px;
    max-width: 100%;
  }
  article {
    border-top: 1px solid var(--banto-border);
    margin-top: 12px;
  }
  h3 {
    font-size: 13px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  small {
    font-weight: 400;
  }
  svg {
    width: 100%;
    display: block;
    overflow: visible;
  }
  svg text {
    fill: var(--banto-text-muted);
    font-size: 11px;
  }
  .axis {
    stroke: var(--banto-border);
  }
  circle {
    fill: var(--banto-primary);
  }
  .envelope {
    fill: color-mix(in srgb, var(--banto-primary) 28%, transparent);
    stroke: var(--banto-primary);
  }
  [data-bin-state="partial"] {
    stroke-dasharray: 3 2;
  }
  .boolean-range {
    stroke: var(--banto-primary);
    stroke-width: 3;
  }
  .missing {
    stroke: var(--banto-text-muted);
    stroke-width: 2;
  }
  .missing-bin,
  .coverage rect {
    fill: color-mix(in srgb, var(--banto-text-muted) 24%, transparent);
    stroke: var(--banto-text-muted);
    stroke-dasharray: 3 2;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    color: var(--banto-text-muted);
  }
  .coverage > span {
    font-weight: 500;
  }
</style>
