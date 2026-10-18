<script lang="ts" module>
  export type CanvasContext = {
    objectId: string | null;
    origin: HTMLElement;
    point: { x: number; y: number };
    designPoint: { x: number; y: number } | null;
  };
  export type CanvasView = {
    hand: boolean;
    zoom: number | null;
    scale: number;
    fit: number;
  };
</script>

<script lang="ts">
  import { tick, untrack } from "svelte";
  import Renderer from "../Renderer.svelte";
  import type { Screen, SymbolDefinition, Point } from "../project";
  import type { Geometry } from "../resize";
  import { snapCoordinate } from "../snap";
  import { PALETTE_MIME } from "./palette-drag";
  import {
    fitZoom,
    viewLayout,
    viewFromCenter,
    zoomAt,
    zoomLevels,
    type ViewState,
  } from "../viewport";
  let {
    screen,
    symbols,
    editable,
    selectedIds,
    showGrid,
    snapEnabled,
    gridSize,
    onbeforeedit,
    onselect,
    onmove,
    onresize,
    onvertexmove,
    canDropPart,
    ondropPart,
    onviewchange,
    oncontextrequest,
  }: {
    screen: Screen | SymbolDefinition;
    symbols: SymbolDefinition[];
    editable: boolean;
    selectedIds: string[];
    showGrid: boolean;
    snapEnabled: boolean;
    gridSize: number;
    onbeforeedit?: () => boolean;
    onselect: (
      id: string | null,
      additive: boolean,
      preserve: boolean,
    ) => string[];
    onmove: (ids: string[], dx: number, dy: number) => void;
    onresize: (id: string, geometry: Geometry) => void;
    onvertexmove: (id: string, index: number, point: Point) => void;
    canDropPart: () => boolean;
    ondropPart: (token: string, center: Point) => void;
    onviewchange: (view: CanvasView) => void;
    oncontextrequest: (request: CanvasContext) => void;
  } = $props();
  let viewport = $state<HTMLDivElement>();
  let dropPoint = $state<Point | null>(null);
  function palettePoint(event: DragEvent): Point | null {
    const svg = viewport?.querySelector<SVGSVGElement>(".sheet > svg");
    const matrix = svg?.getScreenCTM();
    if (!matrix) return null;
    try {
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(
        matrix.inverse(),
      );
      if (
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x < 0 ||
        point.y < 0 ||
        point.x > screen.width ||
        point.y > screen.height
      )
        return null;
      return snapEnabled && !event.altKey
        ? {
            x: Math.min(
              screen.width,
              Math.max(0, snapCoordinate(point.x, gridSize)),
            ),
            y: Math.min(
              screen.height,
              Math.max(0, snapCoordinate(point.y, gridSize)),
            ),
          }
        : { x: point.x, y: point.y };
    } catch {
      return null;
    }
  }
  function dragOver(event: DragEvent) {
    if (
      !editable ||
      !canDropPart() ||
      !event.dataTransfer?.types.includes(PALETTE_MIME)
    )
      return;
    event.preventDefault();
    dropPoint = palettePoint(event);
    event.dataTransfer.dropEffect = dropPoint ? "copy" : "none";
  }
  function dropPart(event: DragEvent) {
    dropPoint = null;
    if (
      !editable ||
      !canDropPart() ||
      !event.dataTransfer?.types.includes(PALETTE_MIME)
    )
      return;
    event.preventDefault();
    const center = palettePoint(event);
    if (center) ondropPart(event.dataTransfer.getData(PALETTE_MIME), center);
  }
  let size = $state({ width: 800, height: 500 });
  let views = $state<Record<string, ViewState>>({});
  let centerRooms = $state<Record<string, boolean>>({});
  let resizeAnchor: { id: string; center: Point } | null = null;
  let hand = $state(false),
    space = $state(false);
  let pan = $state<{
    pointer: number;
    id: string;
    start: Point;
    scroll: Point;
  } | null>(null);
  const stored = $derived(views[screen.id]);
  const fit = $derived(fitZoom(screen, size));
  const scale = $derived(editable && stored?.zoom != null ? stored.zoom : fit);
  const centerRoom = $derived(
    editable && stored?.zoom != null && !!centerRooms[screen.id],
  );
  const layout = $derived(viewLayout(screen, size, scale, centerRoom));
  function restoreCenter(center: Point) {
    if (!viewport) return;
    const state = viewFromCenter(screen, size, scale, center, centerRoom);
    viewport.scrollLeft = state.left;
    viewport.scrollTop = state.top;
    views[screen.id] = state;
  }
  export function preparePanelResize(continuous = false) {
    if (!editable || stored?.zoom == null) return;
    const anchor = {
      id: screen.id,
      center:
        resizeAnchor?.id === screen.id ? resizeAnchor.center : visibleCenter(),
    };
    resizeAnchor = anchor;
    centerRooms[screen.id] = true;
    if (!continuous) finishPanelResize();
  }
  export function finishPanelResize() {
    const anchor = resizeAnchor;
    if (!anchor) return;
    // ResizeObserver and layout restoration settle before the final center is committed.
    void tick().then(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (resizeAnchor !== anchor || screen.id !== anchor.id || !editable)
            return;
          restoreCenter(anchor.center);
          resizeAnchor = null;
        }),
      ),
    );
  }
  export function setHand(value: boolean) {
    hand = value;
  }
  $effect(() => {
    const view = {
      hand,
      zoom: editable ? (stored?.zoom ?? null) : null,
      scale,
      fit,
    };
    untrack(() => onviewchange(view));
  });
  const panning = $derived(editable && (hand || space || !!pan));
  $effect(() => {
    const element = viewport;
    if (!element) return;
    const update = () => {
      if (element.clientWidth && element.clientHeight)
        size = { width: element.clientWidth, height: element.clientHeight };
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  });
  $effect(() => {
    const element = viewport,
      id = screen.id,
      editing = editable;
    // scale と領域サイズの変更時だけ復元し、通常のスクロールを巻き戻さない。
    scale;
    size.width;
    size.height;
    layout.x;
    layout.y;
    const state = untrack(() => views[id]);
    if (resizeAnchor && (resizeAnchor.id !== id || !editing))
      resizeAnchor = null;
    const anchor = resizeAnchor;
    pan = null;
    space = false;
    dropPoint = null;
    if (!element) return;
    void tick().then(() => {
      if (screen.id !== id || editable !== editing || viewport !== element)
        return;
      if (resizeAnchor && resizeAnchor === anchor) {
        restoreCenter(resizeAnchor.center);
        return;
      }
      element.scrollLeft = editing && state?.zoom != null ? state.left : 0;
      element.scrollTop = editing && state?.zoom != null ? state.top : 0;
    });
  });
  export function visibleCenter(): Point {
    return {
      x: ((viewport?.scrollLeft ?? 0) + size.width / 2 - layout.x) / scale,
      y: ((viewport?.scrollTop ?? 0) + size.height / 2 - layout.y) / scale,
    };
  }
  function remember() {
    if (!viewport || !editable || resizeAnchor) return;
    views[screen.id] = {
      zoom: stored?.zoom ?? null,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    };
  }
  export function zoom(value: number | null) {
    if (!viewport || !editable) return;
    resizeAnchor = null;
    if (value === null) {
      views[screen.id] = { zoom: null, left: 0, top: 0 };
      return;
    }
    views[screen.id] = zoomAt(
      screen,
      size,
      scale,
      Math.max(0.25, Math.min(4, value)),
      { x: viewport.scrollLeft, y: viewport.scrollTop },
      { x: size.width / 2, y: size.height / 2 },
      { before: centerRoom, after: !!centerRooms[screen.id] },
    );
  }
  export function revealObject(id: string) {
    if (!viewport || !editable) return;
    const target = [
      ...viewport.querySelectorAll<SVGElement>("[data-object-id]"),
    ].find((element) => element.dataset.objectId === id);
    if (!target) return;
    const bounds = target.getBoundingClientRect();
    const box = viewport.getBoundingClientRect();
    const left = box.left + viewport.clientLeft,
      top = box.top + viewport.clientTop;
    const shift = (
      start: number,
      end: number,
      origin: number,
      extent: number,
    ) =>
      end - start > extent
        ? start - origin
        : start < origin
          ? start - origin
          : end > origin + extent
            ? end - origin - extent
            : 0;
    viewport.scrollLeft += shift(
      bounds.left,
      bounds.right,
      left + 12,
      Math.max(1, viewport.clientWidth - 24),
    );
    viewport.scrollTop += shift(
      bounds.top,
      bounds.bottom,
      top + 12,
      Math.max(1, viewport.clientHeight - 24),
    );
    remember();
    viewport.focus({ preventScroll: true });
  }
  export function stepZoom(direction: number) {
    const next =
      direction > 0
        ? zoomLevels.find((v) => v > scale + 0.001)
        : [...zoomLevels].reverse().find((v) => v < scale - 0.001);
    zoom(next ?? (direction > 0 ? 4 : 0.25));
  }
  function key(event: KeyboardEvent) {
    if (event.key === "Escape" && pan) {
      event.preventDefault();
      event.stopPropagation();
      cancelPan();
      return;
    }
    if (
      !editable ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      (event.target instanceof Element &&
        event.target.closest("input,textarea,select,[contenteditable]"))
    )
      return;
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      requestContext();
      return;
    }
    if (event.code === "Space") {
      event.preventDefault();
      event.stopPropagation();
      space = true;
    }
  }
  function requestContext(event?: MouseEvent) {
    if (!editable || !viewport) return;
    event?.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const point = event
      ? { x: event.clientX, y: event.clientY }
      : {
          x: rect.left + viewport.clientWidth / 2,
          y: rect.top + viewport.clientHeight / 2,
        };
    const svg = viewport.querySelector<SVGSVGElement>(".sheet > svg");
    let designPoint: Point | null = event ? null : visibleCenter();
    if (event && svg?.getScreenCTM()) {
      const p = new DOMPoint(point.x, point.y).matrixTransform(
        svg.getScreenCTM()!.inverse(),
      );
      if (
        Number.isFinite(p.x) &&
        Number.isFinite(p.y) &&
        p.x >= 0 &&
        p.x <= screen.width &&
        p.y >= 0 &&
        p.y <= screen.height
      ) {
        designPoint = {
          x: snapEnabled && !event.altKey ? snapCoordinate(p.x, gridSize) : p.x,
          y: snapEnabled && !event.altKey ? snapCoordinate(p.y, gridSize) : p.y,
        };
        designPoint.x = Math.max(0, Math.min(screen.width, designPoint.x));
        designPoint.y = Math.max(0, Math.min(screen.height, designPoint.y));
      }
    }
    const objectId = event
      ? ((event.target as Element)
          .closest("[data-object-id]")
          ?.getAttribute("data-object-id") ?? null)
      : (selectedIds[0] ?? null);
    oncontextrequest({ objectId, origin: viewport, point, designPoint });
  }
  function releaseSpace(event: KeyboardEvent) {
    if (event.code === "Space") space = false;
  }
  function down(event: PointerEvent) {
    if (!editable || !event.isPrimary || !viewport) return;
    if (event.button !== 0 && event.button !== 1) return;
    if (!hand && !space && event.button !== 1) {
      if (!(event.target as Element).closest('[tabindex="0"]'))
        viewport.focus({ preventScroll: true });
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    viewport.focus({ preventScroll: true });
    viewport.setPointerCapture(event.pointerId);
    pan = {
      pointer: event.pointerId,
      id: screen.id,
      start: { x: event.clientX, y: event.clientY },
      scroll: { x: viewport.scrollLeft, y: viewport.scrollTop },
    };
  }
  function move(event: PointerEvent) {
    if (
      !pan ||
      !viewport ||
      pan.pointer !== event.pointerId ||
      pan.id !== screen.id
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    viewport.scrollLeft = pan.scroll.x - (event.clientX - pan.start.x);
    viewport.scrollTop = pan.scroll.y - (event.clientY - pan.start.y);
    remember();
  }
  function up(event: PointerEvent) {
    if (!pan || pan.pointer !== event.pointerId) return;
    move(event);
    pan = null;
    event.stopPropagation();
    if (viewport?.hasPointerCapture(event.pointerId))
      viewport.releasePointerCapture(event.pointerId);
  }
  function cancelPan() {
    const previous = pan;
    pan = null;
    if (!previous || !viewport) return;
    if (previous.id === screen.id) {
      viewport.scrollLeft = previous.scroll.x;
      viewport.scrollTop = previous.scroll.y;
      remember();
    }
    if (viewport.hasPointerCapture(previous.pointer))
      viewport.releasePointerCapture(previous.pointer);
  }
</script>

<svelte:window
  ondragend={() => (dropPoint = null)}
  onkeyup={releaseSpace}
  onblur={() => {
    space = false;
    cancelPan();
  }}
/>
<!-- svelte-ignore a11y_no_noninteractive_tabindex (スクロール領域をキーボードと Space パンで操作するためのフォーカス先) -->
<div
  bind:this={viewport}
  class="viewport"
  class:panning
  class:preview={!editable}
  class:drop-ready={!!dropPoint}
  role="region"
  aria-label="キャンバス操作領域"
  aria-roledescription="工程図キャンバス"
  tabindex="0"
  oncontextmenu={requestContext}
  onkeydowncapture={key}
  onpointerdowncapture={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={cancelPan}
  onlostpointercapture={() => {
    if (pan) cancelPan();
  }}
  onscroll={remember}
  ondragover={dragOver}
  ondrop={dropPart}
  ondragleave={(event) => {
    if (
      !(event.relatedTarget instanceof Node) ||
      !viewport?.contains(event.relatedTarget)
    )
      dropPoint = null;
  }}
>
  <div
    class="world"
    style:width={`${layout.worldWidth}px`}
    style:height={`${layout.worldHeight}px`}
  >
    <div
      class="sheet"
      data-testid="canvas-sheet"
      style:left={`${layout.x}px`}
      style:top={`${layout.y}px`}
      style:width={`${layout.width}px`}
      style:height={`${layout.height}px`}
    >
      {#key screen.id}
        <Renderer
          {screen}
          {symbols}
          {editable}
          {selectedIds}
          {showGrid}
          {snapEnabled}
          {gridSize}
          {onbeforeedit}
          {onselect}
          {onmove}
          {onresize}
          {onvertexmove}
        />
      {/key}
      {#if dropPoint && editable}
        <div
          class="drop-marker"
          aria-hidden="true"
          style:left={`${dropPoint.x * scale}px`}
          style:top={`${dropPoint.y * scale}px`}
        >
          ＋
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .viewport.drop-ready {
    border-color: var(--banto-primary);
  }
  .drop-marker {
    position: absolute;
    transform: translate(-50%, -50%);
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border: 2px solid var(--banto-primary);
    color: var(--banto-primary);
    background: var(--banto-surface);
    border-radius: 50%;
    pointer-events: none;
    font: bold 20px sans-serif;
  }
  .viewport:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .viewport {
    width: 100%;
    height: clamp(280px, calc(100dvh - 340px), 740px);
    overflow: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--banto-border);
    border-radius: 6px;
    background: var(--banto-bg);
    position: relative;
  }
  .viewport.preview {
    height: clamp(280px, calc(100dvh - 220px), 850px);
  }
  @media (min-width: 1100px) {
    .viewport,
    .viewport.preview {
      flex: 1;
      height: auto;
      min-height: 280px;
    }
  }
  .world {
    position: relative;
  }
  .sheet {
    position: absolute;
    outline: 1px solid var(--banto-border);
    background: #0b1220;
    box-shadow: 0 2px 12px #0003;
  }
  .panning {
    cursor: grab;
    touch-action: none;
  }
  .panning :global(svg),
  .panning :global(svg *) {
    cursor: grab !important;
  }
</style>
