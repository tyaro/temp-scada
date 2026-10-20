<script lang="ts">
  import { slotPresentation, type SlotPresentation } from "./symbol-slots";
  import { patternGeometry } from "./pattern-paint";
  import { linearGradientEndpoints } from "./linear-gradient";
  import { lineDash, lineCap } from "./line-style";
  import TextPrimitive from "./TextPrimitive.svelte";
  import type { ScreenObject } from "./project";
  import { presentNumeric, type TagReadings } from "./tag-presentation";
  let {
    object,
    color,
    readings,
    slotDisplay,
    onsummary,
  }: {
    object: ScreenObject;
    color?: string;
    readings?: TagReadings;
    slotDisplay?: SlotPresentation;
    onsummary?: (description: string) => void;
  } = $props();
  const gradientId = $props.id();
  const fill = $derived(
    object.shape.type === "rectangle" || object.shape.type === "ellipse"
      ? object.shape.paint.fill
      : null,
  );
  const gradient = $derived(
    fill?.paint.type === "linearGradient" ? fill.paint : null,
  );
  const pattern = $derived(fill?.paint.type === "pattern" ? fill.paint : null);
  const patternPath = $derived(
    pattern ? patternGeometry(pattern.kind, pattern.spacing, pattern.size) : "",
  );
  const endpoints = $derived(
    gradient && "width" in object
      ? linearGradientEndpoints(object.width, object.height, gradient.angle)
      : null,
  );
  const fillColor = $derived(
    !fill?.enabled
      ? "none"
      : gradient || pattern
        ? `url(#${gradientId})`
        : fill?.paint.type === "solid"
          ? (color ?? fill.paint.color)
          : "none",
  );
  const fillAlpha = $derived(
    fill?.paint.type === "solid" ? fill.paint.alpha : undefined,
  );
  const binding = $derived(
    object.shape.type === "text" ? object.shape.binding : undefined,
  );
  const slotBinding = $derived(
    object.shape.type === "text" ? object.shape.slotBinding : undefined,
  );
  const bound = $derived(!!binding || !!slotBinding);
  const presentation = $derived(
    slotBinding
      ? (slotDisplay ?? slotPresentation("unbound"))
      : presentNumeric(
          binding ? readings?.get(binding.externalName) : undefined,
        ),
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

{#if gradient && endpoints}
  <defs
    ><linearGradient
      id={gradientId}
      gradientUnits="userSpaceOnUse"
      {...endpoints}
    >
      <stop
        offset="0%"
        stop-color={color ?? gradient.start.color}
        stop-opacity={gradient.start.alpha}
      />
      <stop
        offset="100%"
        stop-color={color ?? gradient.end.color}
        stop-opacity={gradient.end.alpha}
      />
    </linearGradient></defs
  >
{/if}
{#if pattern}
  <defs
    ><pattern
      id={gradientId}
      patternUnits="userSpaceOnUse"
      patternContentUnits="userSpaceOnUse"
      width={pattern.spacing}
      height={pattern.spacing}
      patternTransform={`rotate(${pattern.angle})`}
    >
      {#if pattern.background}<rect
          width={pattern.spacing}
          height={pattern.spacing}
          fill={color ?? pattern.background.color}
          fill-opacity={pattern.background.alpha}
        />{/if}
      <path
        d={patternPath}
        fill={color ?? pattern.foreground.color}
        fill-opacity={pattern.foreground.alpha}
        fill-rule="nonzero"
      />
    </pattern></defs
  >
{/if}
{#if "width" in object}
  {#if object.shape.type === "rectangle"}<rect
      width={object.width}
      height={object.height}
      fill={fillColor}
      stroke={object.shape.paint.stroke
        ? (color ?? object.shape.paint.stroke.color)
        : "none"}
      fill-opacity={fillAlpha}
      stroke-opacity={object.shape.paint.stroke?.alpha}
      stroke-width={object.shape.paint.stroke?.width}
      stroke-dasharray={lineDash(
        object.shape.paint.stroke?.lineStyle,
        object.shape.paint.stroke?.width ?? 1,
      )}
      stroke-linecap={lineCap(object.shape.paint.stroke?.lineStyle)}
    />
  {:else if object.shape.type === "ellipse"}<ellipse
      cx={object.width / 2}
      cy={object.height / 2}
      rx={object.width / 2}
      ry={object.height / 2}
      fill={fillColor}
      stroke={object.shape.paint.stroke
        ? (color ?? object.shape.paint.stroke.color)
        : "none"}
      fill-opacity={fillAlpha}
      stroke-opacity={object.shape.paint.stroke?.alpha}
      stroke-width={object.shape.paint.stroke?.width}
      stroke-dasharray={lineDash(
        object.shape.paint.stroke?.lineStyle,
        object.shape.paint.stroke?.width ?? 1,
      )}
      stroke-linecap={lineCap(object.shape.paint.stroke?.lineStyle)}
    />
  {:else if object.shape.type === "text"}<TextPrimitive
      text={bound ? presentation.text : object.shape.text}
      width={object.width}
      height={object.height}
      style={object.shape.style}
      color={color ?? object.fill!}
      numeric={bound}
      tagName={slotBinding?.slotName ?? binding?.externalName}
      tagState={bound ? presentation.state : undefined}
      tagLabel={bound ? presentation.label : undefined}
      {onsummary}
    />{/if}
{:else if shape}
  <polyline
    points={shape.points.map((p) => `${p.x},${p.y}`).join(" ")}
    stroke={color ?? object.fill!}
    stroke-width={shape.strokeWidth}
    stroke-linejoin="round"
    stroke-linecap={lineCap(shape.lineStyle)}
    stroke-dasharray={lineDash(shape.lineStyle, shape.strokeWidth)}
    fill="none"
  />
  {#if shape.arrow === "end"}<polygon
      points={arrowPoints()}
      fill={color ?? object.fill!}
    />{/if}
{/if}
