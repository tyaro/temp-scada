<script lang="ts">
  import { untrack } from "svelte";
  import {
    getBounds,
    getLocalBounds,
    type Point,
    type Screen,
    type ScreenObject,
    type SymbolDefinition,
  } from "./project";
  import {
    objectToWorld,
    worldToObject,
    rotateVector,
    rotationTransform,
    objectTransform,
    moveRotatedVertex,
    replaceRotatedVertex,
    resizeRotated,
    rotatedResizeCursor,
  } from "./rotation";
  import { dragOffset, vertexPosition, nextGridCoordinate } from "./snap";
  import {
    resizeGeometry,
    resizeHandles,
    handlePoint,
    type Geometry,
    type ResizeHandle,
  } from "./resize";
  import { canvasColors } from "./canvas-colors";
  import { compositedOpacity } from "./opacity";
  import Primitive from "./Primitive.svelte";
  import type { TagReadings } from "./tag-presentation";
  let {
    screen,
    symbols = [],
    images,
    readings,
    editable = false,
    selectedIds = [],
    showGrid = false,
    snapEnabled = false,
    gridSize = 10,
    onbeforeedit,
    onresize,
    onvertexmove,
    onselect,
    onmove,
  }: {
    screen: Screen | SymbolDefinition;
    symbols?: SymbolDefinition[];
    images?: ReadonlyMap<
      string,
      { url: string; width: number; height: number }
    >;
    readings?: TagReadings;
    editable?: boolean;
    selectedIds?: string[];
    showGrid?: boolean;
    snapEnabled?: boolean;
    gridSize?: number;
    onbeforeedit?: () => boolean;
    onresize?: (id: string, geometry: Geometry) => void;
    onvertexmove?: (id: string, index: number, point: Point) => void;
    onselect?: (
      id: string | null,
      additive: boolean,
      preserve: boolean,
    ) => string[];
    onmove?: (ids: string[], dx: number, dy: number) => void;
  } = $props();
  const background = $derived(
    "background" in screen ? screen.background : "#0b1220",
  );
  const colors = $derived(canvasColors(background));
  let svgElement = $state<SVGSVGElement>();
  let viewScale = $state(1);
  const handleHalfSize = $derived(5 / viewScale);
  $effect(() => {
    const svg = svgElement;
    // viewBox 変更時も、CSS のサイズが同じなら ResizeObserver だけでは検知できない。
    screen.width;
    screen.height;
    if (!svg) return;
    const update = () => {
      const matrix = svg.getScreenCTM();
      const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 1;
      viewScale = scale > 0 ? scale : 1;
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(svg);
    return () => observer.disconnect();
  });
  let textDescriptions = $state<Record<string, string>>({});
  let interactionOwner = $state.raw<Screen | SymbolDefinition | null>(null);
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
    original: Geometry & { rotation: number };
    current: Geometry;
  } | null>(null);
  function resizeKey(
    event: KeyboardEvent,
    id: string,
    geometry: Geometry & { rotation: number },
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
    if (onbeforeedit && !onbeforeedit()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const current = screen.objects.find((object) => object.id === id);
    if (
      !current ||
      current.locked ||
      current.visible === false ||
      !("width" in current)
    )
      return;
    geometry = {
      x: current.x,
      rotation: current.rotation,
      y: current.y,
      width: current.width,
      height: current.height,
    };
    if (current.rotation) {
      const p = handlePoint(geometry, handle);
      const edge = objectToWorld(current, {
        x: p.x - current.x,
        y: p.y - current.y,
      });
      let delta = {
        x: direction.x * (event.shiftKey ? 10 : 1),
        y: direction.y * (event.shiftKey ? 10 : 1),
      };
      if (snapEnabled) {
        if (handle.length === 1) {
          const normal = rotateVector(
            handle === "e" || handle === "w" ? { x: 1, y: 0 } : { x: 0, y: 1 },
            current.rotation,
          );
          const projected = delta.x * normal.x + delta.y * normal.y;
          if (Math.abs(projected) < 1e-12) return;
          const axis = Math.abs(normal.x) >= Math.abs(normal.y) ? "x" : "y";
          const travel = projected * normal[axis];
          const distance =
            (nextGridCoordinate(edge[axis], travel, gridSize) - edge[axis]) /
            normal[axis];
          delta = { x: normal.x * distance, y: normal.y * distance };
        } else {
          if (direction.x)
            delta.x =
              nextGridCoordinate(edge.x, direction.x, gridSize) - edge.x;
          if (direction.y)
            delta.y =
              nextGridCoordinate(edge.y, direction.y, gridSize) - edge.y;
        }
      }
      onresize?.(id, resizeRotated(current, handle, delta, null));
      return;
    }
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
  $effect(() => {
    if (
      (drag || vertexDrag || resizeDrag) &&
      (!editable || interactionOwner !== screen)
    )
      untrack(cancelInteraction);
  });
  function cancelDrag() {
    interactionOwner = null;
    drag = null;
    vertexDrag = null;
    resizeDrag = null;
  }
  export function isInteracting() {
    return !!(drag || vertexDrag || resizeDrag);
  }
  export function cancelInteraction() {
    const pointers = [drag?.pointer, vertexDrag?.pointer, resizeDrag?.pointer];
    cancelDrag();
    for (const pointer of pointers)
      if (pointer !== undefined && svgElement?.hasPointerCapture(pointer))
        svgElement.releasePointerCapture(pointer);
  }
  function cancelKey(event: KeyboardEvent) {
    if (event.key === "Escape" && (drag || vertexDrag || resizeDrag)) {
      event.preventDefault();
      cancelInteraction();
    }
  }
  function previewObject(object: ScreenObject): ScreenObject {
    if ("width" in object && resizeDrag?.id === object.id)
      return { ...object, ...resizeDrag.current };
    if ("width" in object || vertexDrag?.id !== object.id) return object;
    const geometry = replaceRotatedVertex(
      object,
      vertexDrag.index,
      vertexDrag.current,
    );
    return {
      ...object,
      x: geometry.x,
      y: geometry.y,
      shape: { ...object.shape, points: geometry.points },
    };
  }

  function vertexKey(
    event: KeyboardEvent,
    object: ScreenObject,
    index: number,
  ) {
    if (
      !editable ||
      object.locked ||
      object.visible === false ||
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
    if (onbeforeedit && !onbeforeedit()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const current = screen.objects.find((item) => item.id === object.id);
    if (
      !current ||
      current.locked ||
      current.visible === false ||
      current.shape.type !== "polyline" ||
      !current.shape.points[index]
    )
      return;
    if (current.rotation) {
      const start = objectToWorld(current, current.shape.points[index]);
      const amount = event.shiftKey ? 10 : 1;
      const target = { ...start };
      if (direction.x)
        target.x = snapEnabled
          ? nextGridCoordinate(start.x, direction.x, gridSize)
          : start.x + direction.x * amount;
      if (direction.y)
        target.y = snapEnabled
          ? nextGridCoordinate(start.y, direction.y, gridSize)
          : start.y + direction.y * amount;
      onvertexmove?.(object.id, index, worldToObject(current, target));
      return;
    }
    const original = current.shape.points[index],
      point = { ...original };
    if (snapEnabled) {
      if (direction.x)
        point.x =
          nextGridCoordinate(current.x + point.x, direction.x, gridSize) -
          current.x;
      if (direction.y)
        point.y =
          nextGridCoordinate(current.y + point.y, direction.y, gridSize) -
          current.y;
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
      if (onbeforeedit && !onbeforeedit()) {
        event.preventDefault();
        return;
      }
      const object = screen.objects.find(
        (o) => o.id === resize.getAttribute("data-resize-object-id"),
      );
      const handle = resize.getAttribute("data-resize-handle") as ResizeHandle;
      const start = point(event);
      if (
        !object ||
        object.locked ||
        object.visible === false ||
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
        rotation: object.rotation,
        width: object.width,
        height: object.height,
      };
      interactionOwner = screen;
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
      if (onbeforeedit && !onbeforeedit()) {
        event.preventDefault();
        return;
      }
      const object = screen.objects.find(
        (o) => o.id === handle.getAttribute("data-vertex-object-id"),
      );
      const index = Number(handle.getAttribute("data-vertex-index"));
      const start = point(event);
      if (
        !object ||
        object.locked ||
        object.visible === false ||
        object.shape.type !== "polyline" ||
        !start ||
        !object.shape.points[index]
      )
        return;
      event.preventDefault();
      (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
      const original = { ...object.shape.points[index] };
      interactionOwner = screen;
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
    if (
      !object ||
      object.locked ||
      object.visible === false ||
      !start ||
      !ids.includes(object.id) ||
      screen.objects.some(
        (item) =>
          (item.locked || item.visible === false) && ids.includes(item.id),
      )
    )
      return;
    event.preventDefault();
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    interactionOwner = screen;
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
    if (
      (drag || vertexDrag || resizeDrag) &&
      (!editable || interactionOwner !== screen)
    ) {
      cancelInteraction();
      return;
    }
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
            : resizeRotated(
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
        current: (() => {
          const object = screen.objects.find(
            (object) => object.id === vertexDrag!.id,
          )!;
          if (object.shape.type !== "polyline") return vertexDrag!.original;
          return moveRotatedVertex(
            object as typeof object & { shape: typeof object.shape },
            vertexDrag!.index,
            delta,
            step,
          ).points[vertexDrag!.index];
        })(),
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
      interactionOwner = null;
      if (editable) onresize?.(finished.id, finished.current);
    } else if (vertexDrag && vertexDrag.pointer === event.pointerId) {
      const finished = vertexDrag;
      vertexDrag = null;
      interactionOwner = null;
      if (
        editable &&
        (finished.current.x !== finished.original.x ||
          finished.current.y !== finished.original.y)
      )
        onvertexmove?.(finished.id, finished.index, finished.current);
    } else if (drag && drag.pointer === event.pointerId) {
      const finished = drag;
      drag = null;
      interactionOwner = null;
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
  bind:this={svgElement}
  style:--canvas-accent={colors.selection}
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
  <rect
    data-screen-background
    width={screen.width}
    height={screen.height}
    fill={background}
    pointer-events="none"
  />
  {#if "backgroundImage" in screen && screen.backgroundImage && images?.get(screen.backgroundImage.assetId)}
    <image
      data-background-image
      href={images.get(screen.backgroundImage.assetId)!.url}
      x={screen.backgroundImage.fit === "original"
        ? (screen.width - images.get(screen.backgroundImage.assetId)!.width) / 2
        : 0}
      y={screen.backgroundImage.fit === "original"
        ? (screen.height - images.get(screen.backgroundImage.assetId)!.height) /
          2
        : 0}
      width={screen.backgroundImage.fit === "original"
        ? images.get(screen.backgroundImage.assetId)!.width
        : screen.width}
      height={screen.backgroundImage.fit === "original"
        ? images.get(screen.backgroundImage.assetId)!.height
        : screen.height}
      preserveAspectRatio={screen.backgroundImage.fit === "stretch"
        ? "none"
        : screen.backgroundImage.fit === "cover"
          ? "xMidYMid slice"
          : "xMidYMid meet"}
      opacity={screen.backgroundImage.opacity}
      pointer-events="none"
    />
  {/if}
  {#if editable && showGrid}
    <defs
      ><pattern
        id={gridId}
        width={gridSize}
        height={gridSize}
        patternUnits="userSpaceOnUse"
        ><circle
          cx={gridSize / 2}
          cy={gridSize / 2}
          r={0.65 / viewScale}
          fill={colors.grid}
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
  {#each [...screen.objects]
    .filter((object) => object.visible !== false)
    .sort((a, b) => a.order - b.order) as object (object.id)}
    {@const visual = previewObject(object)}
    <g
      transform={position(visual)}
      pointer-events={editable && object.locked ? "none" : undefined}
      data-object-id={object.id}
      data-selected={editable && selectedIds.includes(object.id)
        ? "true"
        : undefined}
    >
      {#if visual.shape.type === "text" && textDescriptions[object.id]}<title
          >{textDescriptions[object.id]}</title
        >{/if}
      <g
        transform={rotationTransform(visual)}
        data-object-rotation={visual.rotation}
        opacity={compositedOpacity(visual)}
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
            data-symbol-color-mode={visual.shape.colorMode}
          >
            {#each [...definition.objects]
              .filter((object) => object.visible !== false)
              .sort((a, b) => a.order - b.order) as child (child.id)}
              <g
                transform={objectTransform(child)}
                opacity={compositedOpacity(child)}
                ><Primitive
                  object={child}
                  color={visual.shape.colorMode === "definition"
                    ? undefined
                    : object.fill}
                /></g
              >
            {/each}
          </svg>
        {:else}<Primitive
            object={visual}
            {readings}
            onsummary={(value) => {
              textDescriptions[object.id] = value;
            }}
          />{/if}
      </g>
      {#if editable}
        {@const bounds = getBounds(visual)}
        {#if visual.shape.type === "polyline"}
          <polyline
            transform={rotationTransform(visual)}
            points={visual.shape.points.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="transparent"
            stroke-width={Math.max(12, visual.shape.strokeWidth + 8)}
          />
        {:else}
          {@const hit = getLocalBounds(visual)}
          <rect
            transform={rotationTransform(visual)}
            width={hit.width}
            height={hit.height}
            x={hit.x}
            y={hit.y}
            fill="transparent"
          />{/if}
        {#if selectedIds.includes(object.id)}<rect
            x={bounds.x}
            y={bounds.y}
            width={bounds.width}
            height={bounds.height}
            fill="none"
            stroke="var(--canvas-accent)"
            stroke-width="2"
            vector-effect="non-scaling-stroke"
            pointer-events="none"
          />{/if}
      {/if}
    </g>
  {/each}
  {#if editable && selectedIds.length === 1}
    {@const object = screen.objects.find((o) => o.id === selectedIds[0])}
    {#if object && !object.locked && object.visible !== false && "width" in object && !drag}
      {@const visual = previewObject(object)}
      {#if "width" in visual}
        {#each resizeHandles as handle}
          {@const local = handlePoint(visual, handle)}
          {@const p = objectToWorld(visual, {
            x: local.x - visual.x,
            y: local.y - visual.y,
          })}
          <rect
            x={p.x - handleHalfSize}
            y={p.y - handleHalfSize}
            width={handleHalfSize * 2}
            height={handleHalfSize * 2}
            fill="var(--canvas-accent)"
            stroke={background}
            stroke-width="1.5"
            vector-effect="non-scaling-stroke"
            style:cursor={rotatedResizeCursor(handle, visual.rotation)}
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
    {#if object && !object.locked && object.visible !== false && object.shape.type === "polyline"}
      {@const visual = previewObject(object)}
      {#if visual.shape.type === "polyline"}
        {#each visual.shape.points as p, index}
          {@const world = objectToWorld(
            visual as typeof visual & { shape: typeof visual.shape },
            p,
          )}
          <circle
            class="vertex"
            cx={world.x}
            cy={world.y}
            r={6 / viewScale}
            fill="var(--canvas-accent)"
            stroke={background}
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
    stroke: var(--canvas-accent);
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
  }
</style>
