<script lang="ts">
  import type { SlotProvenance } from "./read-slot-session";
  import { onMount, untrack } from "svelte";
  import { fitText, TEXT_FONT, type TextLayout } from "./text-layout";
  import type { TextStyle } from "./project";
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
    `${tagName ? `${tagName} · ${tagLabel}${tagDetail ? ` · ${tagDetail}` : ""}${origin} · ` : ""}${!current ? "文字の計測中 · " : current.mode === "full" ? "" : current?.mode === "ellipsis" ? "省略表示 · " : "表示枠に収まりません · "}${text}`,
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
  data-tag-name={tagName}
  data-tag-state={tagState}
  data-tag-reason={tagDetail}
  data-tag-source={provenance?.valueSource}
  data-collection-mode={provenance?.collectionMode}
  data-source-timestamp-ms={provenance?.sourceTimestampMs}
  data-catalog-revision={provenance?.catalogRevision}
  data-tag-run-id={provenance ? (provenance.runId ?? "none") : undefined}
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
      fill={color}>{current.text}</text
    >
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
