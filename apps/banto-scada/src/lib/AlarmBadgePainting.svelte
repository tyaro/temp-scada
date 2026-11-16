<script lang="ts">
  // 警報の小札の描画。色は状態ごとに部品で固定する。仕様: docs/design/graphics/alarm-badge.md
  import type { AlarmBadgeShape } from "./project";
  import { alarmBadgeConditionId, alarmBadgeTargetLabel } from "./alarm-badge";
  import { alarmViewText, type AlarmView } from "./alarm-view";
  import {
    alarmViewBlink,
    alarmViewDefinitions,
    alarmViewOf,
  } from "./alarm-view-state.svelte";
  import { TEXT_FONT } from "./text-layout";
  let {
    shape,
    width,
    height,
  }: { shape: AlarmBadgeShape; width: number; height: number } = $props();
  const uid = $props.id();
  const patternId = `alarm-badge-unknown-${uid}`;
  const view: AlarmView = $derived(alarmViewOf(alarmBadgeConditionId(shape)));
  const target = $derived(
    alarmBadgeTargetLabel(shape, alarmViewDefinitions()) ?? "定義なし",
  );
  const label = $derived(`警報の小札 ${target}: ${alarmViewText(view)}`);

  /** severity ごとの発生中の地と文字、復帰・未確認の文字と枠（薄い地で読める濃さ）。 */
  const SEVERITY = {
    high: { fill: "#dc2626", text: "#ffffff", strong: "#b91c1c" },
    medium: { fill: "#f97316", text: "#111827", strong: "#c2410c" },
    low: { fill: "#facc15", text: "#111827", strong: "#a16207" },
  } as const;
  const severity = $derived(SEVERITY[view.severity ?? "high"]);
  const colors = $derived.by(() => {
    switch (view.state) {
      case "activeAcked":
      case "activeUnacked":
        return {
          fill: severity.fill,
          text: severity.text,
          stroke: severity.strong,
          strokeWidth: 1,
          dash: undefined,
        };
      case "returnedUnacked":
        return {
          fill: "#f9fafb",
          text: severity.strong,
          stroke: severity.strong,
          strokeWidth: 3,
          dash: undefined,
        };
      case "unavailable":
        return {
          fill: "#d1d5db",
          text: "#374151",
          stroke: "#4b5563",
          strokeWidth: 1.5,
          dash: "4 3",
        };
      case "unknown":
        return {
          fill: "#9ca3af",
          text: "#111827",
          stroke: "#4b5563",
          strokeWidth: 1,
          dash: undefined,
        };
      default:
        return {
          fill: "#f3f4f6",
          text: "#374151",
          stroke: "#9ca3af",
          strokeWidth: 1,
          dash: undefined,
        };
    }
  });
  const blink = $derived(
    alarmViewBlink() &&
      (view.state === "activeUnacked" || view.state === "returnedUnacked"),
  );
  const question = $derived(
    view.state === "unavailable" || view.unavailableMark,
  );
  const inset = $derived(
    Math.max(0, Math.min(3, width / 2 - 1, height / 2 - 1)),
  );
  const markRadius = $derived(Math.max(4, Math.min(7, height / 3)));
</script>

<g
  data-alarm-badge
  data-alarm-state={view.state}
  data-alarm-reason={view.reason}
  data-alarm-mark={view.unavailableMark ? "true" : undefined}
  role="img"
  aria-label={label}
  class:blink
>
  <title>{label}</title>
  {#if view.state === "unknown"}
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
    fill={view.state === "unknown" ? `url(#${patternId})` : colors.fill}
    stroke={colors.stroke}
    stroke-width={colors.strokeWidth}
    stroke-dasharray={colors.dash}
  />
  {#if view.state === "activeUnacked"}
    <!-- 未確認は点滅しなくても分かるよう、文字の周りに反転した枠を描く。 -->
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
  <svg {width} {height} overflow="hidden" pointer-events="none"
    ><text
      x={width / 2}
      y={height / 2}
      dominant-baseline="central"
      text-anchor="middle"
      font-family={TEXT_FONT}
      font-size={shape.style.fontSize}
      font-weight={shape.style.fontWeight}
      fill={colors.text}
      >{view.state === "unavailable" && !shape.text ? "?" : shape.text}</text
    ></svg
  >
  {#if question && (view.state !== "unavailable" || shape.text)}
    <g data-alarm-question pointer-events="none">
      <circle
        cx={width - markRadius}
        cy={markRadius}
        r={markRadius}
        fill="#ffffff"
        stroke="#111827"
        stroke-width="1"
      /><text
        x={width - markRadius}
        y={markRadius}
        dominant-baseline="central"
        text-anchor="middle"
        font-family={TEXT_FONT}
        font-size={markRadius * 1.6}
        font-weight="bold"
        fill="#111827">?</text
      >
    </g>
  {/if}
</g>

<style>
  .blink {
    animation: alarm-badge-blink 1s steps(1, end) infinite;
  }
  @keyframes alarm-badge-blink {
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
