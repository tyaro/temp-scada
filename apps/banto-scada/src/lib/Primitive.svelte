<script lang="ts">
  import TextPrimitive from "./TextPrimitive.svelte";
  import type { ScreenObject } from "./project";
  import { presentNumeric, type TagReadings } from "./tag-presentation";
  let {
    object,
    color,
    readings,
    onsummary,
  }: {
    object: ScreenObject;
    color?: string;
    readings?: TagReadings;
    onsummary?: (description: string) => void;
  } = $props();
  const binding = $derived(
    object.shape.type === "text" ? object.shape.binding : undefined,
  );
  const presentation = $derived(
    presentNumeric(binding ? readings?.get(binding.externalName) : undefined),
  );
  const shape = $derived("width" in object ? null : object.shape);
  function arrowPoints() {
    if (!shape || shape.arrow !== "end") return "";
    const end = shape.points.at(-1)!;
    const before = [...shape.points]
      .reverse()
      .find((p) => p.x !== end.x || p.y !== end.y);
    // ドラッグ途中は未確定なので、一時的に全頂点が重なる場合も描画を保つ。
    if (!before) return "";
    const length = Math.hypot(end.x - before.x, end.y - before.y);
    const ux = (end.x - before.x) / length,
      uy = (end.y - before.y) / length;
    const size = Math.max(8, shape.strokeWidth * 3);
    return `${end.x},${end.y} ${end.x - ux * size - (uy * size) / 2},${end.y - uy * size + (ux * size) / 2} ${end.x - ux * size + (uy * size) / 2},${end.y - uy * size - (ux * size) / 2}`;
  }
</script>

{#if "width" in object}
  {#if object.shape.type === "rectangle"}<rect
      width={object.width}
      height={object.height}
      fill={object.shape.paint.fillEnabled ? (color ?? object.fill) : "none"}
      stroke={object.shape.paint.stroke
        ? (color ?? object.shape.paint.stroke.color)
        : "none"}
      stroke-width={object.shape.paint.stroke?.width}
    />
  {:else if object.shape.type === "ellipse"}<ellipse
      cx={object.width / 2}
      cy={object.height / 2}
      rx={object.width / 2}
      ry={object.height / 2}
      fill={object.shape.paint.fillEnabled ? (color ?? object.fill) : "none"}
      stroke={object.shape.paint.stroke
        ? (color ?? object.shape.paint.stroke.color)
        : "none"}
      stroke-width={object.shape.paint.stroke?.width}
    />
  {:else if object.shape.type === "text"}<TextPrimitive
      text={binding ? presentation.text : object.shape.text}
      width={object.width}
      height={object.height}
      style={object.shape.style}
      color={color ?? object.fill}
      numeric={!!binding}
      tagName={binding?.externalName}
      tagState={binding ? presentation.state : undefined}
      tagLabel={binding ? presentation.label : undefined}
      {onsummary}
    />{/if}
{:else if shape}
  <polyline
    points={shape.points.map((p) => `${p.x},${p.y}`).join(" ")}
    stroke={color ?? object.fill}
    stroke-width={shape.strokeWidth}
    stroke-linejoin="round"
    stroke-linecap="round"
    fill="none"
  />
  {#if shape.arrow === "end"}<polygon
      points={arrowPoints()}
      fill={color ?? object.fill}
    />{/if}
{/if}
