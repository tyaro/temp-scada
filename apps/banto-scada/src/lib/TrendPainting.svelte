<script lang="ts">
  import type { TrendDefinition } from "./trend-definitions";
  let {
    width,
    height,
    definition,
    onopen,
  }: {
    width: number;
    height: number;
    definition?: TrendDefinition;
    onopen?: () => void;
  } = $props();
</script>

<svg {width} {height} overflow="hidden" data-trend-card={definition?.id}>
  <title>{definition?.name ?? "トレンド"} · 履歴トレンド</title>
  <rect
    x="1"
    y="1"
    width={Math.max(0, width - 2)}
    height={Math.max(0, height - 2)}
    rx="6"
    fill="var(--banto-surface, #f9fdff)"
    stroke="var(--banto-border, #c6e1e9)"
  />
  <text
    x="14"
    y="30"
    fill="var(--banto-text, #172846)"
    font-size="16"
    data-trend-name>{definition?.name ?? "トレンド"}</text
  >
  <text x="14" y="58" fill="var(--banto-text-muted, #5a7290)" font-size="12"
    >{definition?.pens.length ?? 0}系列 · {definition?.mode ?? ""}</text
  >
  <text x="14" y="86" fill="var(--banto-text-muted, #5a7290)" font-size="12"
    >{onopen ? "履歴を開く（終了UTCを指定）" : "履歴トレンド"}</text
  >
  {#if onopen}
    <g
      role="button"
      tabindex="0"
      aria-label={`${definition?.name ?? "トレンド"}の履歴を開く`}
      pointer-events="all"
      onclick={(event) => {
        event.stopPropagation();
        onopen?.();
      }}
      onkeydown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          onopen?.();
        }
      }}
    >
      <rect
        class="hit"
        width={Math.max(0, width)}
        height={Math.max(0, height)}
        rx="6"
        fill="transparent"
      />
    </g>
  {/if}
</svg>

<style>
  [role="button"] {
    cursor: pointer;
  }
  [role="button"]:focus-visible .hit {
    stroke: var(--banto-primary);
    stroke-width: 3px;
  }
</style>
