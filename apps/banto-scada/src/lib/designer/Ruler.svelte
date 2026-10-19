<script lang="ts">
  import { rulerTicks } from "../ruler";
  let {
    axis,
    length,
    origin,
    scale,
    extent,
  }: {
    axis: "x" | "y";
    length: number;
    origin: number;
    scale: number;
    extent: number;
  } = $props();
  const ticks = $derived(rulerTicks(length, origin, scale));
  const start = $derived(Math.max(0, origin));
  const end = $derived(Math.min(length, origin + extent * scale));
</script>

<svg
  aria-hidden="true"
  data-testid={`ruler-${axis}`}
  width={axis === "x" ? length : 22}
  height={axis === "y" ? length : 22}
>
  {#if end > start}
    <rect
      class="sheet-span"
      x={axis === "x" ? start : 0}
      y={axis === "y" ? start : 0}
      width={axis === "x" ? end - start : 22}
      height={axis === "y" ? end - start : 22}
    />
  {/if}
  {#each ticks as tick (tick.value)}
    <g
      data-value={tick.value}
      transform={axis === "x"
        ? `translate(${tick.position},0)`
        : `translate(0,${tick.position})`}
    >
      {#if axis === "x"}
        <line x1="0" x2="0" y1={tick.label === null ? 17 : 12} y2="22" />
        {#if tick.label !== null}<text x="3" y="9">{tick.label}</text>{/if}
      {:else}
        <line y1="0" y2="0" x1={tick.label === null ? 17 : 12} x2="22" />
        {#if tick.label !== null}<text
            transform="translate(9,3) rotate(-90)"
            text-anchor="end">{tick.label}</text
          >{/if}
      {/if}
    </g>
  {/each}
</svg>

<style>
  svg {
    display: block;
    overflow: hidden;
    background: var(--banto-bg);
    color: var(--banto-text-muted);
    user-select: none;
  }
  .sheet-span {
    fill: var(--banto-surface);
  }
  line {
    stroke: var(--banto-border);
    stroke-width: 1;
  }
  text {
    fill: currentColor;
    font:
      10px ui-monospace,
      monospace;
  }
</style>
