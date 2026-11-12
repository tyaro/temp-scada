<script lang="ts">
  import {
    resolveEquipmentProperty,
    type EquipmentPropertyPresentation,
  } from "./equipment-property";
  import { slotPresentation, type SlotPresentation } from "./symbol-slots";
  import { slotStateText, type SlotStateEvaluation } from "./slot-state";
  import { patternGeometry } from "./pattern-paint";
  import { linearGradientEndpoints } from "./linear-gradient";
  import { lineDash, lineCap } from "./line-style";
  import TextPrimitive from "./TextPrimitive.svelte";
  import MultilineTextPrimitive from "./MultilineTextPrimitive.svelte";
  import type { ScreenObject } from "./project";
  import {
    formatSlotText,
    presentNumeric,
    type TagReadings,
  } from "./tag-presentation";
  let {
    object,
    color,
    readings,
    slotDisplay,
    slotState,
    equipmentPropertyDisplay,
    stateColor,
    onsummary,
  }: {
    object: ScreenObject;
    color?: string;
    readings?: TagReadings;
    slotDisplay?: SlotPresentation;
    /** Defined state of the slot; a known state replaces the raw value text. */
    slotState?: SlotStateEvaluation;
    equipmentPropertyDisplay?: EquipmentPropertyPresentation;
    /**
     * Resolved state color (`resolveStateColor`); it overrides the normal
     * color, and undefined keeps the normal color.
     */
    stateColor?: string;
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
  const radial = $derived(
    fill?.paint.type === "radialGradient" ? fill.paint : null,
  );
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
      : gradient || radial || pattern
        ? `url(#${gradientId})`
        : fill?.paint.type === "solid"
          ? (stateColor ?? color ?? fill.paint.color)
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
  const metadata = $derived(
    object.shape.type === "text" && object.shape.equipmentProperty
      ? (equipmentPropertyDisplay ??
          resolveEquipmentProperty(object.shape.equipmentProperty.field))
      : undefined,
  );
  const bound = $derived(!!binding || !!slotBinding);
  const format = $derived(
    object.shape.type === "text" ? object.shape.format : undefined,
  );
  const presentation = $derived.by(() => {
    if (!slotBinding)
      return presentNumeric(
        binding ? readings?.get(binding.externalName) : undefined,
        format,
      );
    const display = slotDisplay ?? slotPresentation("unbound");
    return { ...display, text: formatSlotText(display, format) };
  });
  /**
   * The defined state replaces the reading when it is known, or when a Good
   * reading cannot be a state (e.g. a fractional word reads as invalid).
   * Other unknown readings keep their own text and reason.
   */
  const definedState = $derived(
    slotBinding &&
      slotState &&
      (slotState.state === "known" || presentation.state === "good")
      ? slotState
      : undefined,
  );
  const textColor = $derived(stateColor ?? color ?? object.fill!);
  const lineColor = $derived(stateColor ?? color ?? object.fill!);
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
{#if radial}
  <defs
    ><radialGradient
      id={gradientId}
      gradientUnits="objectBoundingBox"
      cx={radial.center.x}
      cy={radial.center.y}
      r={radial.radius}
      fx={radial.center.x}
      fy={radial.center.y}
      spreadMethod="pad"
    >
      <stop
        offset="0%"
        stop-color={color ?? radial.start.color}
        stop-opacity={radial.start.alpha}
      />
      <stop
        offset="100%"
        stop-color={color ?? radial.end.color}
        stop-opacity={radial.end.alpha}
      />
    </radialGradient></defs
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
  {:else if object.shape.type === "text"}
    {#if !bound && !metadata && (object.shape.text.includes("\n") || (object.shape.style.wrap === "word" && object.shape.text.length > 0))}
      <MultilineTextPrimitive
        text={object.shape.text}
        width={object.width}
        height={object.height}
        style={object.shape.style}
        color={textColor}
        {onsummary}
      />
    {:else}<TextPrimitive
        text={metadata
          ? metadata.text
          : bound
            ? definedState
              ? slotStateText(definedState)
              : presentation.text
            : object.shape.text}
        equipmentProperty={metadata}
        width={object.width}
        height={object.height}
        style={object.shape.style}
        color={textColor}
        numeric={bound}
        tagName={slotBinding?.slotName ?? binding?.externalName}
        tagState={bound
          ? definedState?.state === "unknown"
            ? definedState.reason
            : presentation.state
          : undefined}
        tagLabel={bound
          ? definedState?.state === "known" && definedState.none
            ? "未割付（なしとして表示）"
            : definedState?.state === "unknown"
              ? slotPresentation(definedState.reason).label
              : presentation.label
          : undefined}
        provenance={slotBinding
          ? slotDisplay?.provenance
          : presentation.provenance}
        tagDetail={slotBinding ? slotDisplay?.reason : undefined}
        {onsummary}
      />{/if}{/if}
{:else if shape}
  <polyline
    points={shape.points.map((p) => `${p.x},${p.y}`).join(" ")}
    stroke={lineColor}
    stroke-width={shape.strokeWidth}
    stroke-linejoin="round"
    stroke-linecap={lineCap(shape.lineStyle)}
    stroke-dasharray={lineDash(shape.lineStyle, shape.strokeWidth)}
    fill="none"
  />
  {#if shape.arrow === "end"}<polygon
      points={arrowPoints()}
      fill={lineColor}
    />{/if}
{/if}
