<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { withSvgTextMeasure } from "./svg-text-measure";
  import { TEXT_FONT } from "./text-layout";
  import {
    fitStaticLines,
    type StaticLinesLayout,
    type StaticLine,
  } from "./multiline-text-layout";
  import type { TextStyle } from "./project";
  let {
    text,
    width,
    height,
    style,
    color,
    onsummary,
  }: {
    text: string;
    width: number;
    height: number;
    style: TextStyle;
    color: string;
    onsummary?: (description: string) => void;
  } = $props();
  let viewport = $state<SVGSVGElement>(),
    probe = $state<SVGTextElement>();
  let fontRevision = $state(0);
  let layout = $state<(StaticLinesLayout & { key: string }) | null>(null);
  const key = $derived(
    JSON.stringify([
      text,
      width,
      height,
      style.fontSize,
      style.fontWeight,
      style.align,
      style.wrap ?? "none",
    ]),
  );
  const current = $derived(layout?.key === key ? layout : null);
  const description = $derived(
    `${!current ? "文字の計測中 · " : current.mode === "full" ? "" : current.mode === "ellipsis" ? "省略表示 · " : "表示枠に収まりません · "}${text}`,
  );
  function x(line: StaticLine) {
    return (
      (style.align === "center"
        ? (width - line.inkWidth) / 2
        : style.align === "right"
          ? width - 2 - line.inkWidth
          : 2) - line.left
    );
  }
  onMount(() => {
    let active = true;
    const changed = () => {
      if (active) fontRevision += 1;
    };
    void document.fonts.ready.then(changed);
    document.fonts.addEventListener("loadingdone", changed);
    document.fonts.addEventListener("loadingerror", changed);
    let retryFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (layout || !active || retryFrame !== null) return;
      retryFrame = requestAnimationFrame(() => {
        retryFrame = null;
        if (!layout && active) fontRevision += 1;
      });
    });
    if (viewport) observer.observe(viewport);
    return () => {
      active = false;
      if (retryFrame !== null) cancelAnimationFrame(retryFrame);
      document.fonts.removeEventListener("loadingdone", changed);
      document.fonts.removeEventListener("loadingerror", changed);
      observer.disconnect();
    };
  });
  $effect(() => {
    fontRevision;
    const element = probe,
      snapshot = key;
    if (!element) return;
    untrack(() => {
      try {
        const fitted = withSvgTextMeasure(element, (measure) =>
          fitStaticLines(
            text,
            width,
            height,
            style.fontSize,
            measure,
            style.wrap ?? "none",
          ),
        );
        layout = { ...fitted, key: snapshot };
      } catch {
        layout = null;
      }
    });
  });
  $effect(() => {
    const value = description;
    untrack(() => onsummary?.(value));
  });
</script>

<svg
  bind:this={viewport}
  {width}
  {height}
  viewBox={`0 0 ${width} ${height}`}
  overflow="hidden"
  data-text-layout={current?.mode ?? "pending"}
  data-text-multiline="true"
  data-text-wrap={style.wrap ?? "none"}
  data-text-line-count={current?.totalLines}
  data-text-visible-lines={current?.visibleLines}
  role="img"
  aria-label={description}
>
  <title>{description}</title>
  <text
    bind:this={probe}
    x="0"
    y="0"
    visibility="hidden"
    aria-hidden="true"
    font-family={TEXT_FONT}
    font-size={style.fontSize}
    font-weight={style.fontWeight}
    style="white-space:pre"
  />
  {#if current && current.visibleLines > 0}
    <g aria-hidden="true">
      {#each current.lines as line, index}
        <text
          data-text-content
          data-text-line={index}
          x={x(line)}
          y={line.baseline}
          font-family={TEXT_FONT}
          font-size={style.fontSize}
          font-weight={style.fontWeight}
          fill={color}
          style="white-space:pre">{line.text}</text
        >
      {/each}
    </g>
  {:else}
    <svg
      x={Math.max(0, (width - Math.min(width, height, 16)) / 2)}
      y={Math.max(0, (height - Math.min(width, height, 16)) / 2)}
      width={Math.min(width, height, 16)}
      height={Math.min(width, height, 16)}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d="M8 1 15 14H1Z" fill="none" stroke={color} stroke-width="1.5" />
      <path d="M8 5v4m0 2v1" stroke={color} stroke-width="1.5" />
    </svg>
  {/if}
</svg>
