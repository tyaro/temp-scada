<script lang="ts">
  import {
    getBounds,
    type Point,
    type Screen,
    type ScreenObject,
    type SymbolDefinition,
  } from "./project";
  import { dragOffset, vertexPosition, nextGridCoordinate } from "./snap";
  import {
    resizeGeometry,
    resizeHandles,
    handlePoint,
    type Geometry,
    type ResizeHandle,
  } from "./resize";
  import Primitive from "./Primitive.svelte";
  let {
    screen,
    symbols = [],
    editable = false,
    selectedIds = [],
    showGrid = false,
    snapEnabled = false,
    gridSize = 10,
    onresize,
    onvertexmove,
    onselect,
    onmove,
  }: {
    screen: Screen;
    symbols?: SymbolDefinition[];
    editable?: boolean;
    selectedIds?: string[];
    showGrid?: boolean;
    snapEnabled?: boolean;
    gridSize?: number;
    onresize?: (id: string, geometry: Geometry) => void;
    onvertexmove?: (id: string, index: number, point: Point) => void;
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
    anchor: Point;
  } | null>(null);
  const gridId = $props.id();
  let vertexDrag = $state<{
    id: string;
    index: number;
    pointer: number;
    start: Point;
    origin: Point;
    original: Point;
    current: Point;
  } | null>(null);
  let resizeDrag = $state<{
    id: string;
    handle: ResizeHandle;
    pointer: number;
    start: Point;
    original: Geometry;
    current: Geometry;
  } | null>(null);
  function resizeKey(
    event: KeyboardEvent,
    id: string,
    geometry: Geometry,
    handle: ResizeHandle,
  ) {
    if (
      !editable ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      resizeDrag
    )
      return;
    const vectors: Record<string, Point> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const direction = vectors[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const edge = handlePoint(geometry, handle);
    const amount = event.shiftKey ? 10 : 1;
    const delta = { x: direction.x * amount, y: direction.y * amount };
    if (snapEnabled) {
      if (direction.x)
        delta.x = nextGridCoordinate(edge.x, direction.x, gridSize) - edge.x;
      if (direction.y)
        delta.y = nextGridCoordinate(edge.y, direction.y, gridSize) - edge.y;
    }
    onresize?.(
      id,
      resizeGeometry(geometry, handle, delta, snapEnabled ? gridSize : null),
    );
  }
  function cancelDrag() {
    drag = null;
    vertexDrag = null;
    resizeDrag = null;
  }
  function cancelKey(event: KeyboardEvent) {
    if (event.key === "Escape" && (drag || vertexDrag || resizeDrag)) {
      event.preventDefault();
      cancelDrag();
    }
  }
  function previewObject(object: ScreenObject): ScreenObject {
    if ("width" in object && resizeDrag?.id === object.id)
      return { ...object, ...resizeDrag.current };
    if ("width" in object || vertexDrag?.id !== object.id) return object;
    const vertex = vertexDrag;
    return {
      ...object,
      shape: {
        ...object.shape,
        points: object.shape.points.map((p, i) =>
          i === vertex.index ? vertex.current : p,
        ),
      },
    };
  }
  function vertexKey(
    event: KeyboardEvent,
    object: ScreenObject,
    index: number,
  ) {
    if (
      !editable ||
      object.shape.type !== "polyline" ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    const vector: Record<string, Point> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const direction = vector[event.key];
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    const original = object.shape.points[index],
      point = { ...original };
    if (snapEnabled) {
      if (direction.x)
        point.x =
          nextGridCoordinate(object.x + point.x, direction.x, gridSize) -
          object.x;
      if (direction.y)
        point.y =
          nextGridCoordinate(object.y + point.y, direction.y, gridSize) -
          object.y;
    } else {
      point.x += direction.x * (event.shiftKey ? 10 : 1);
      point.y += direction.y * (event.shiftKey ? 10 : 1);
    }
    onvertexmove?.(object.id, index, point);
  }
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
    if (drag || vertexDrag || resizeDrag) return;
    const resize = (event.target as Element).closest("[data-resize-object-id]");
    if (resize) {
      const object = screen.objects.find(
        (o) => o.id === resize.getAttribute("data-resize-object-id"),
      );
      const handle = resize.getAttribute("data-resize-handle") as ResizeHandle;
      const start = point(event);
      if (
        !object ||
        !("width" in object) ||
        !start ||
        !resizeHandles.includes(handle)
      )
        return;
      event.preventDefault();
      (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
      const original = {
        x: object.x,
        y: object.y,
        width: object.width,
        height: object.height,
      };
      resizeDrag = {
        id: object.id,
        handle,
        pointer: event.pointerId,
        start: { x: start.x, y: start.y },
        original,
        current: original,
      };
      return;
    }
    const handle = (event.target as Element).closest("[data-vertex-object-id]");
    if (handle) {
      const object = screen.objects.find(
        (o) => o.id === handle.getAttribute("data-vertex-object-id"),
      );
      const index = Number(handle.getAttribute("data-vertex-index"));
      const start = point(event);
      if (
        !object ||
        object.shape.type !== "polyline" ||
        !start ||
        !object.shape.points[index]
      )
        return;
      event.preventDefault();
      (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
      const original = { ...object.shape.points[index] };
      vertexDrag = {
        id: object.id,
        index,
        pointer: event.pointerId,
        start: { x: start.x, y: start.y },
        origin: { x: object.x, y: object.y },
        original,
        current: original,
      };
      return;
    }
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
      anchor: { x: object.x, y: object.y },
      pointer: event.pointerId,
      startX: start.x,
      startY: start.y,
      dx: 0,
      dy: 0,
    };
  }
  function move(event: PointerEvent) {
    if (!editable) return;
    const p = point(event);
    if (!p) return;
    const step = snapEnabled && !event.altKey ? gridSize : null;
    if (resizeDrag && resizeDrag.pointer === event.pointerId) {
      resizeDrag = {
        ...resizeDrag,
        current:
          Math.hypot(p.x - resizeDrag.start.x, p.y - resizeDrag.start.y) <= 0.5
            ? resizeDrag.original
            : resizeGeometry(
                resizeDrag.original,
                resizeDrag.handle,
                { x: p.x - resizeDrag.start.x, y: p.y - resizeDrag.start.y },
                step,
              ),
      };
    } else if (vertexDrag && vertexDrag.pointer === event.pointerId) {
      const delta = {
        x: p.x - vertexDrag.start.x,
        y: p.y - vertexDrag.start.y,
      };
      vertexDrag = {
        ...vertexDrag,
        current: vertexPosition(
          vertexDrag.origin,
          vertexDrag.original,
          delta,
          step,
        ),
      };
    } else if (drag && drag.pointer === event.pointerId) {
      const delta = dragOffset(
        drag.anchor,
        { x: p.x - drag.startX, y: p.y - drag.startY },
        step,
      );
      drag = { ...drag, dx: delta.x, dy: delta.y };
    }
  }
  function up(event: PointerEvent) {
    move(event);
    if (resizeDrag && resizeDrag.pointer === event.pointerId) {
      const finished = resizeDrag;
      resizeDrag = null;
      if (editable) onresize?.(finished.id, finished.current);
    } else if (vertexDrag && vertexDrag.pointer === event.pointerId) {
      const finished = vertexDrag;
      vertexDrag = null;
      if (
        editable &&
        (finished.current.x !== finished.original.x ||
          finished.current.y !== finished.original.y)
      )
        onvertexmove?.(finished.id, finished.index, finished.current);
    } else if (drag && drag.pointer === event.pointerId) {
      const finished = drag;
      drag = null;
      if (editable && (finished.dx !== 0 || finished.dy !== 0))
        onmove?.(finished.ids, finished.dx, finished.dy);
    }
  }
  function position(object: ScreenObject) {
    return `translate(${object.x + (editable && drag?.ids.includes(object.id) ? drag.dx : 0)} ${object.y + (editable && drag?.ids.includes(object.id) ? drag.dy : 0)})`;
  }
</script>

<svelte:window onkeydown={cancelKey} />
<svg
  role="img"
  aria-label={screen.name}
  viewBox={`0 0 ${screen.width} ${screen.height}`}
  preserveAspectRatio="xMidYMid meet"
  class:editable
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={cancelDrag}
  onlostpointercapture={cancelDrag}
>
  <title>{screen.name}</title>
  {#if editable && showGrid}
    <defs
      ><pattern
        id={gridId}
        width={gridSize}
        height={gridSize}
        patternUnits="userSpaceOnUse"
        ><path
          d={`M ${gridSize} 0 H 0 V ${gridSize}`}
          fill="none"
          stroke="var(--banto-text-muted)"
          stroke-width="0.6"
          opacity="0.35"
        /></pattern
      ></defs
    >
    <rect
      data-grid="true"
      width={screen.width}
      height={screen.height}
      fill={`url(#${gridId})`}
      pointer-events="none"
    />
  {/if}
  {#each [...screen.objects].sort((a, b) => a.order - b.order) as object (object.id)}
    {@const visual = previewObject(object)}
    <g
      transform={position(visual)}
      data-object-id={object.id}
      data-selected={editable && selectedIds.includes(object.id)
        ? "true"
        : undefined}
    >
      {#if "width" in visual && visual.shape.type === "symbol"}
        {@const definition = symbols.find(
          (s) =>
            object.shape.type === "symbol" && s.id === object.shape.symbolId,
        )!}
        <svg
          width={visual.width}
          height={visual.height}
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
      {:else}<Primitive object={visual} />{/if}
      {#if editable}
        {@const bounds = getBounds(visual)}
        {#if visual.shape.type === "polyline"}
          <polyline
            points={visual.shape.points.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="transparent"
            stroke-width={Math.max(12, visual.shape.strokeWidth + 8)}
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
  {#if editable && selectedIds.length === 1}
    {@const object = screen.objects.find((o) => o.id === selectedIds[0])}
    {#if object && "width" in object && !drag}
      {@const visual = previewObject(object)}
      {#if "width" in visual}
        {#each resizeHandles as handle}
          {@const p = handlePoint(visual, handle)}
          <rect
            x={p.x - 5}
            y={p.y - 5}
            width="10"
            height="10"
            fill="var(--banto-primary)"
            stroke="var(--banto-text-inverse)"
            stroke-width="1.5"
            vector-effect="non-scaling-stroke"
            style:cursor={`${handle}-resize`}
            class="resize-handle"
            role="button"
            tabindex="0"
            data-resize-object-id={object.id}
            data-resize-handle={handle}
            aria-label={`サイズ変更 ${handle}（方向キーで変更）`}
            onkeydown={(event) => resizeKey(event, object.id, visual, handle)}
          />
        {/each}
      {/if}
    {/if}
    {#if object && object.shape.type === "polyline"}
      {@const visual = previewObject(object)}
      {#if visual.shape.type === "polyline"}
        {#each visual.shape.points as p, index}
          <circle
            class="vertex"
            cx={object.x + p.x}
            cy={object.y + p.y}
            r="6"
            fill="var(--banto-primary)"
            stroke="var(--banto-text-inverse)"
            stroke-width="1.5"
            vector-effect="non-scaling-stroke"
            data-vertex-object-id={object.id}
            data-vertex-index={index}
            role="button"
            tabindex="0"
            aria-label={`頂点 ${index + 1}（方向キーで移動）`}
            onkeydown={(event) => vertexKey(event, object, index)}
          />
        {/each}
      {/if}
    {/if}
  {/if}
</svg>

<style>
  .vertex {
    cursor: crosshair;
  }
  .resize-handle:focus-visible,
  .vertex:focus-visible {
    outline: none;
    stroke: var(--banto-warning);
    stroke-width: 3;
  }
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
