<script lang="ts">
  import {
    equipmentPropertyLabels,
    type EquipmentPropertyPresentation,
  } from "./equipment-property";
  import type { SlotProvenance } from "./read-slot-session";
  import { onMount, untrack } from "svelte";
  import { fitText, TEXT_FONT, type TextLayout } from "./text-layout";
  import type { TextStyle } from "./project";
  import {
    ALARM_OUTLINE_COLOR,
    alarmOutlineWidth,
    alarmUnderlineBox,
    type AlarmTextPaint,
  } from "./alarm-value-paint";
  let {
    text,
    width,
    height,
    style,
    color,
    numeric = false,
    tagName,
    tagState,
    tagLabel,
    tagDetail,
    provenance,
    equipmentProperty,
    alarm,
    onsummary,
  }: {
    text: string;
    width: number;
    height: number;
    style: TextStyle;
    color: string;
    numeric?: boolean;
    tagName?: string;
    tagState?: string;
    tagLabel?: string;
    tagDetail?: string;
    provenance?: SlotProvenance;
    equipmentProperty?: EquipmentPropertyPresentation;
    /**
     * 数値の警報の色（色ごとの選択と縁取りの結果）。仕様:
     * docs/design/graphics/alarm-value-color.md「見た目」
     */
    alarm?: AlarmTextPaint;
    onsummary?: (description: string) => void;
  } = $props();
  let viewport = $state<SVGSVGElement>();
  let probe = $state<SVGTextElement>();
  let fontRevision = $state(0);
  let layout = $state<(TextLayout & { key: string }) | null>(null);
  const key = $derived(
    JSON.stringify([
      text,
      width,
      height,
      style.fontSize,
      style.fontWeight,
      style.align,
      numeric,
    ]),
  );
  const current = $derived(layout?.key === key ? layout : null);
  const x = $derived(
    (style.align === "center"
      ? (width - (current?.inkWidth ?? 0)) / 2
      : style.align === "right"
        ? width - 2 - (current?.inkWidth ?? 0)
        : 2) - (current?.left ?? 0),
  );
  const origin = $derived(
    provenance
      ? ` · source ${provenance.valueSource} · mode ${provenance.collectionMode} · catalog ${provenance.catalogRevision} · run ${provenance.runId ?? "none"} · t ${provenance.sourceTimestampMs}`
      : "",
  );
  const description = $derived(
    `${equipmentProperty ? `${equipmentPropertyLabels[equipmentProperty.field]} · 保存した機器情報${equipmentProperty.state === "example" ? " · 定義編集中の例示" : ""} · ` : ""}${tagName ? `${tagName} · ${tagLabel}${tagDetail ? ` · ${tagDetail}` : ""}${origin} · ` : ""}${!current ? "文字の計測中 · " : current.mode === "full" ? "" : current?.mode === "ellipsis" ? "省略表示 · " : "表示枠に収まりません · "}${text}${alarm ? ` · ${alarm.title}` : ""}`,
  );
  const fill = $derived(alarm?.text?.color ?? color);
  const outline = $derived(alarmOutlineWidth(style.fontSize));
  const underline = $derived(
    alarm?.underline && current?.text
      ? alarmUnderlineBox(
          current,
          x,
          style.fontSize,
          height,
          alarm.underline.outline ? outline : 0,
        )
      : undefined,
  );
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
      // Measuring text writes to the SVG probe. Defer it past this observer delivery.
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
    const element = probe;
    const snapshot = key;
    if (!element) return;
    untrack(() => {
      try {
        const fitted = fitText(
          text,
          width,
          height,
          style.fontSize,
          numeric,
          (value) => {
            element.textContent = value;
            const box = element.getBBox();
            if (value.trim() && box.width === 0 && box.height === 0)
              throw new Error("Text is not measurable while hidden");
            return box;
          },
        );
        element.textContent = "";
        layout = { ...fitted, key: snapshot };
      } catch {
        element.textContent = "";
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
  data-equipment-property={equipmentProperty?.field}
  data-equipment-property-state={equipmentProperty?.state}
  data-tag-name={tagName}
  data-tag-state={tagState}
  data-tag-reason={tagDetail}
  data-tag-source={provenance?.valueSource}
  data-collection-mode={provenance?.collectionMode}
  data-source-timestamp-ms={provenance?.sourceTimestampMs}
  data-catalog-revision={provenance?.catalogRevision}
  data-tag-run-id={provenance ? (provenance.runId ?? "none") : undefined}
  data-alarm-tone={alarm?.tone}
  data-alarm-underline={alarm?.underline?.severity}
  data-alarm-outline={alarm?.text?.outline ? "true" : undefined}
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
  />
  {#if current?.text}
    <text
      data-text-content
      {x}
      y={current.baseline}
      font-family={TEXT_FONT}
      font-size={style.fontSize}
      font-weight={style.fontWeight}
      {fill}
      stroke={alarm?.text?.outline ? ALARM_OUTLINE_COLOR : undefined}
      stroke-width={alarm?.text?.outline ? outline : undefined}
      stroke-linejoin={alarm?.text?.outline ? "round" : undefined}
      paint-order={alarm?.text?.outline ? "stroke" : undefined}
      >{current.text}</text
    >
    {#if underline && alarm?.underline}
      <!-- 未確認の下線。点滅は下線だけに当て、文字は薄くしない。 -->
      <rect
        data-alarm-underline-mark
        class:blink={alarm.blink}
        x={underline.x}
        y={underline.y}
        width={underline.width}
        height={underline.height}
        fill={alarm.underline.color}
        stroke={alarm.underline.outline ? ALARM_OUTLINE_COLOR : undefined}
        stroke-width={alarm.underline.outline ? outline : undefined}
        paint-order={alarm.underline.outline ? "stroke" : undefined}
      />
    {/if}
  {:else if current?.mode !== "full"}
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

<style>
  .blink {
    animation: alarm-value-blink 1s steps(1, end) infinite;
  }
  @keyframes alarm-value-blink {
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
