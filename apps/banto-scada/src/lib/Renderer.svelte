<script lang="ts">
  import type { Screen, ScreenObject } from "./project";
  let {
    screen,
    editable = false,
    selectedId = null,
    onselect,
    onmove,
  }: {
    screen: Screen;
    editable?: boolean;
    selectedId?: string | null;
    onselect?: (id: string | null) => void;
    onmove?: (id: string, x: number, y: number) => void;
  } = $props();
  let drag = $state<{
    id: string;
    pointer: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
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
    onselect?.(id);
    const object = screen.objects.find((o) => o.id === id);
    const start = point(event);
    if (!object || !start) return;
    event.preventDefault();
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    drag = {
      id: object.id,
      pointer: event.pointerId,
      startX: start.x,
      startY: start.y,
      x: object.x,
      y: object.y,
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
        finished.id,
        Math.round((finished.x + finished.dx) * 100) / 100,
        Math.round((finished.y + finished.dy) * 100) / 100,
      );
  }
  function position(object: ScreenObject) {
    return `translate(${object.x + (editable && drag?.id === object.id ? drag.dx : 0)} ${object.y + (editable && drag?.id === object.id ? drag.dy : 0)})`;
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
    <g transform={position(object)} data-object-id={object.id}>
      {#if object.shape.type === "rectangle"}
        <rect width={object.width} height={object.height} fill={object.fill} />
      {:else if object.shape.type === "ellipse"}
        <ellipse
          cx={object.width / 2}
          cy={object.height / 2}
          rx={object.width / 2}
          ry={object.height / 2}
          fill={object.fill}
        />
      {:else if object.shape.type === "text"}
        <text
          x="0"
          y={object.height * 0.8}
          font-size={object.height * 0.7}
          fill={object.fill}>{object.shape.text}</text
        >
      {/if}
      {#if editable}
        <rect
          width={object.width}
          height={object.height}
          fill="transparent"
          stroke={selectedId === object.id ? "var(--banto-warning)" : "none"}
          stroke-width="2"
          vector-effect="non-scaling-stroke"
        />
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
