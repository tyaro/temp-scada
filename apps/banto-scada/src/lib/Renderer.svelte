<script lang="ts">
  import {
    getBounds,
    type Screen,
    type ScreenObject,
    type SymbolDefinition,
  } from "./project";
  import Primitive from "./Primitive.svelte";
  let {
    screen,
    symbols = [],
    editable = false,
    selectedIds = [],
    onselect,
    onmove,
  }: {
    screen: Screen;
    symbols?: SymbolDefinition[];
    editable?: boolean;
    selectedIds?: string[];
    onselect?: (
      id: string | null,
      additive: boolean,
      preserve: boolean,
    ) => string[];
    onmove?: (ids: string[], dx: number, dy: number) => void;
  } = $props();
  let drag = $state<{
    ids: string[];
    pointer: number;
    startX: number;
    startY: number;
    dx: number;
    dy: number;
  } | null>(null);
  function point(event: PointerEvent) {
    const svg = event.currentTarget as SVGSVGElement;
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(
      matrix.inverse(),
    );
  }
  function down(event: PointerEvent) {
    if (!editable || event.button !== 0 || !event.isPrimary) return;
    const id =
      (event.target as Element)
        .closest("[data-object-id]")
        ?.getAttribute("data-object-id") ?? null;
    const ids = onselect?.(id, event.shiftKey, true) ?? (id ? [id] : []);
    const object = screen.objects.find((o) => o.id === id);
    const start = point(event);
    if (!object || !start || !ids.includes(object.id)) return;
    event.preventDefault();
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    drag = {
      ids: [...ids],
      pointer: event.pointerId,
      startX: start.x,
      startY: start.y,
      dx: 0,
      dy: 0,
    };
  }
  function move(event: PointerEvent) {
    if (!editable || !drag || drag.pointer !== event.pointerId) return;
    const p = point(event);
    if (p) drag = { ...drag, dx: p.x - drag.startX, dy: p.y - drag.startY };
  }
  function up(event: PointerEvent) {
    if (!drag || drag.pointer !== event.pointerId) return;
    move(event);
    const finished = drag;
    drag = null;
    if (editable && Math.hypot(finished.dx, finished.dy) > 0.5)
      onmove?.(
        finished.ids,
        Math.round(finished.dx * 100) / 100,
        Math.round(finished.dy * 100) / 100,
      );
  }
  function position(object: ScreenObject) {
    return `translate(${object.x + (editable && drag?.ids.includes(object.id) ? drag.dx : 0)} ${object.y + (editable && drag?.ids.includes(object.id) ? drag.dy : 0)})`;
  }
</script>

<svg
  role="img"
  aria-label={screen.name}
  viewBox={`0 0 ${screen.width} ${screen.height}`}
  preserveAspectRatio="xMidYMid meet"
  class:editable
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={() => (drag = null)}
  onlostpointercapture={() => (drag = null)}
>
  <title>{screen.name}</title>
  {#each [...screen.objects].sort((a, b) => a.order - b.order) as object (object.id)}
    <g
      transform={position(object)}
      data-object-id={object.id}
      data-selected={editable && selectedIds.includes(object.id)
        ? "true"
        : undefined}
    >
      {#if "width" in object && object.shape.type === "symbol"}
        {@const definition = symbols.find(
          (s) =>
            object.shape.type === "symbol" && s.id === object.shape.symbolId,
        )!}
        <svg
          width={object.width}
          height={object.height}
          viewBox={`0 0 ${definition.width} ${definition.height}`}
          preserveAspectRatio="xMidYMid meet"
          data-symbol-id={definition.id}
        >
          {#each [...definition.objects].sort((a, b) => a.order - b.order) as child (child.id)}
            <g transform={`translate(${child.x} ${child.y})`}
              ><Primitive object={child} color={object.fill} /></g
            >
          {/each}
        </svg>
      {:else}<Primitive {object} />{/if}
      {#if editable}
        {@const bounds = getBounds(object)}
        {#if object.shape.type === "polyline"}
          <polyline
            points={object.shape.points.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="transparent"
            stroke-width={Math.max(12, object.shape.strokeWidth + 8)}
          />
        {:else}<rect
            width={bounds.width}
            height={bounds.height}
            x={bounds.x}
            y={bounds.y}
            fill="transparent"
          />{/if}
        {#if selectedIds.includes(object.id)}<rect
            x={bounds.x}
            y={bounds.y}
            width={bounds.width}
            height={bounds.height}
            fill="none"
            stroke="var(--banto-warning)"
            stroke-width="2"
            vector-effect="non-scaling-stroke"
            pointer-events="none"
          />{/if}
      {/if}
    </g>
  {/each}
</svg>

<style>
  .editable {
    touch-action: none;
    cursor: move;
  }
  svg {
    display: block;
    width: 100%;
    height: 100%;
    background: #0b1220;
  }
</style>
