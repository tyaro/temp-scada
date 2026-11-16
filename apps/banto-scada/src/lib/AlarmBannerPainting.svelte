<script lang="ts">
  // 最新の警報の帯の描画。色は状態ごとに部品で固定する。仕様: docs/design/graphics/alarm-banner.md
  import { untrack } from "svelte";
  import type { AlarmBannerShape } from "./project";
  import type { AlarmBannerView } from "./alarm-banner";
  import { alarmBannerViewOf, alarmViewBlink } from "./alarm-view-state.svelte";
  import { TEXT_FONT } from "./text-layout";
  import { fitTextWidth } from "./multiline-text-layout";
  import { withSvgTextMeasure } from "./svg-text-measure";
  let {
    shape,
    width,
    height,
  }: { shape: AlarmBannerShape; width: number; height: number } = $props();
  const uid = $props.id();
  const patternId = `alarm-banner-unknown-${uid}`;
  const view: AlarmBannerView = $derived(alarmBannerViewOf());

  /** 小札と同じ severity の配色（発生中の地と文字、復帰・未確認の文字と枠）。 */
  const SEVERITY = {
    high: { fill: "#dc2626", text: "#ffffff", strong: "#b91c1c" },
    medium: { fill: "#f97316", text: "#111827", strong: "#c2410c" },
    low: { fill: "#facc15", text: "#111827", strong: "#a16207" },
  } as const;
  const unknown = $derived(view.kind !== "alarm" && view.kind !== "none");
  const colors = $derived.by(() => {
    const selected = view.selected;
    if (selected) {
      const severity = SEVERITY[selected.severity];
      return selected.state === "returnedUnacked"
        ? {
            fill: "#f9fafb",
            text: severity.strong,
            stroke: severity.strong,
            strokeWidth: 3,
          }
        : {
            fill: severity.fill,
            text: severity.text,
            stroke: severity.strong,
            strokeWidth: 1,
          };
    }
    if (unknown)
      return {
        fill: "#9ca3af",
        text: "#111827",
        stroke: "#4b5563",
        strokeWidth: 1,
      };
    return {
      fill: "#f3f4f6",
      text: "#374151",
      stroke: "#9ca3af",
      strokeWidth: 1,
    };
  });
  const unacked = $derived(
    view.selected?.state === "activeUnacked" ||
      view.selected?.state === "returnedUnacked",
  );
  const blink = $derived(alarmViewBlink() && unacked);

  const PAD = 8;
  const GAP = 12;
  const CHIP_PAD = 6;
  let probe: SVGTextElement | undefined = $state();
  let fontRevision = $state(0);
  let measured = $state<{
    key: string;
    main: string;
    count: number;
    unavailable: number;
  } | null>(null);
  const key = $derived(
    JSON.stringify([
      view.main,
      view.count,
      view.unavailable,
      width,
      shape.style.fontSize,
      shape.style.fontWeight,
    ]),
  );
  $effect(() => {
    const changed = () => (fontRevision += 1);
    document.fonts?.addEventListener("loadingdone", changed);
    return () => document.fonts?.removeEventListener("loadingdone", changed);
  });
  // 幅に収まらない主の文字は「…」で省略する（測れないときは枠で切るだけ）。
  $effect(() => {
    fontRevision;
    const element = probe,
      snapshot = key;
    if (!element) return;
    untrack(() => {
      try {
        measured = withSvgTextMeasure(element, (measure) => {
          const widthOf = (text?: string) => (text ? measure(text).width : 0);
          const count = widthOf(view.count);
          const unavailable = widthOf(view.unavailable);
          const layout = rightLayout(count, unavailable);
          return {
            key: snapshot,
            main: fitTextWidth(
              view.main,
              Math.max(0, layout.mainEnd - PAD),
              measure,
            ).text,
            count,
            unavailable,
          };
        });
      } catch {
        measured = null;
      }
    });
  });
  const current = $derived(measured?.key === key ? measured : null);
  /** 右の区画（件数・評価不能）の位置と、主の文字が使える右端。 */
  function rightLayout(count: number, unavailable: number) {
    let edge = width - PAD;
    const chipWidth = unavailable ? unavailable + CHIP_PAD * 2 : 0;
    const chipX = edge - chipWidth;
    if (chipWidth) edge = chipX - GAP;
    const countEnd = edge;
    if (count) edge = countEnd - count - GAP;
    return {
      chipX,
      chipWidth,
      countEnd,
      mainEnd: view.count || view.unavailable ? edge : width - PAD,
    };
  }
  // 測れないとき（隠れた画面など）は文字数から見積もり、枠で切る。
  const estimate = (text?: string) =>
    text ? [...text].length * shape.style.fontSize * 0.9 : 0;
  const layout = $derived(
    rightLayout(
      current?.count ?? estimate(view.count),
      current?.unavailable ?? estimate(view.unavailable),
    ),
  );
  const mainText = $derived(current?.main ?? view.main);
  const inset = $derived(
    Math.max(0, Math.min(3, width / 2 - 1, height / 2 - 1)),
  );
  const chipInset = $derived(Math.max(0, Math.min(4, height / 2 - 4)));
</script>

<g
  data-alarm-banner
  data-alarm-banner-kind={view.kind}
  data-alarm-state={view.selected?.state}
  data-alarm-severity={view.selected?.severity}
  data-alarm-condition={view.selected?.conditionId}
  role="img"
  aria-label={view.label}
  class:blink
>
  <title>{view.label}</title>
  {#if unknown}
    <defs>
      <pattern
        id={patternId}
        width="6"
        height="6"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
        ><rect width="6" height="6" fill={colors.fill} /><line
          x1="0"
          y1="0"
          x2="0"
          y2="6"
          stroke="#4b5563"
          stroke-width="2"
        /></pattern
      >
    </defs>
  {/if}
  <rect
    data-alarm-fill
    {width}
    {height}
    rx="3"
    ry="3"
    fill={unknown ? `url(#${patternId})` : colors.fill}
    stroke={colors.stroke}
    stroke-width={colors.strokeWidth}
  />
  {#if view.selected?.state === "activeUnacked"}
    <!-- 未確認は点滅しなくても分かるよう、内側に反転した枠を描く。 -->
    <rect
      data-alarm-unacked-frame
      x={inset}
      y={inset}
      width={Math.max(0, width - inset * 2)}
      height={Math.max(0, height - inset * 2)}
      rx="2"
      ry="2"
      fill="none"
      stroke={colors.text}
      stroke-width="2"
    />
  {/if}
  <svg {width} {height} overflow="hidden" pointer-events="none">
    <text
      bind:this={probe}
      x="0"
      y="0"
      visibility="hidden"
      aria-hidden="true"
      font-family={TEXT_FONT}
      font-size={shape.style.fontSize}
      font-weight={shape.style.fontWeight}
      style="white-space:pre"
    />
    <svg
      width={Math.max(0, layout.mainEnd)}
      {height}
      overflow="hidden"
      aria-hidden="true"
      ><text
        data-alarm-banner-main
        x={PAD}
        y={height / 2}
        dominant-baseline="central"
        font-family={TEXT_FONT}
        font-size={shape.style.fontSize}
        font-weight={shape.style.fontWeight}
        fill={colors.text}
        style="white-space:pre">{mainText}</text
      ></svg
    >
    {#if view.count}
      <text
        data-alarm-banner-count
        aria-hidden="true"
        x={layout.countEnd}
        y={height / 2}
        dominant-baseline="central"
        text-anchor="end"
        font-family={TEXT_FONT}
        font-size={shape.style.fontSize}
        font-weight={shape.style.fontWeight}
        fill={colors.text}
        style="white-space:pre">{view.count}</text
      >
    {/if}
    {#if view.unavailable}
      <g data-alarm-banner-unavailable aria-hidden="true">
        <rect
          x={layout.chipX}
          y={chipInset}
          width={layout.chipWidth}
          height={Math.max(0, height - chipInset * 2)}
          rx="2"
          ry="2"
          fill="#d1d5db"
          stroke="#4b5563"
          stroke-width="1"
          stroke-dasharray="4 3"
        /><text
          x={layout.chipX + CHIP_PAD}
          y={height / 2}
          dominant-baseline="central"
          font-family={TEXT_FONT}
          font-size={shape.style.fontSize}
          font-weight={shape.style.fontWeight}
          fill="#374151"
          style="white-space:pre">{view.unavailable}</text
        >
      </g>
    {/if}
  </svg>
</g>

<style>
  .blink {
    animation: alarm-banner-blink 1s steps(1, end) infinite;
  }
  @keyframes alarm-banner-blink {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .blink {
      animation: none;
    }
  }
</style>
