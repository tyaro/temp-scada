<script lang="ts">
  import type { TrendDefinition } from "./trend-definitions";
  let {
    width,
    height,
    definition,
  }: { width: number; height: number; definition?: TrendDefinition } = $props();
</script>

<svg {width} {height} overflow="hidden" data-trend-card={definition?.id}>
  <title>{definition?.name ?? "トレンド"} · 履歴表示は準備中</title>
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
    >履歴表示は準備中</text
  >
</svg>
