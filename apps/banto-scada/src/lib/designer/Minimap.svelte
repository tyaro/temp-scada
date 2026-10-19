<script lang="ts">
  import { onDestroy } from "svelte";
  import Renderer from "../Renderer.svelte";
  import type { Point, Screen, SymbolDefinition } from "../project";
  import type { CanvasView } from "./CanvasWorkspace.svelte";
  let {
    screen,
    symbols,
    view,
    oncenter,
    onfit,
  }: {
    screen: Screen | SymbolDefinition;
    symbols: SymbolDefinition[];
    view: CanvasView;
    oncenter: (point: Point) => void;
    onfit: () => void;
  } = $props();
  let map = $state<HTMLButtonElement>();
  let drag: { pointer: number; center: Point } | null = null;
  const ratio = $derived(Math.min(120 / screen.width, 68 / screen.height));
  const bounds = $derived(view.bounds);
  const rect = $derived({
    x: Math.max(0, Math.min(screen.width, bounds.x)),
    y: Math.max(0, Math.min(screen.height, bounds.y)),
    width: Math.max(
      0,
      Math.min(screen.width, bounds.x + bounds.width) - Math.max(0, bounds.x),
    ),
    height: Math.max(
      0,
      Math.min(screen.height, bounds.y + bounds.height) - Math.max(0, bounds.y),
    ),
  });
  function center() {
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  }
  function navigate(point: Point) {
    oncenter({
      x: Math.max(0, Math.min(screen.width, point.x)),
      y: Math.max(0, Math.min(screen.height, point.y)),
    });
  }
  function point(event: PointerEvent) {
    if (!map) return;
    const box = map.getBoundingClientRect();
    navigate({
      x:
        ((event.clientX - box.left - map.clientLeft) / map.clientWidth) *
        screen.width,
      y:
        ((event.clientY - box.top - map.clientTop) / map.clientHeight) *
        screen.height,
    });
  }
  function finish(cancel: boolean) {
    const previous = drag;
    drag = null;
    if (!previous) return;
    if (cancel) oncenter(previous.center);
    if (map?.hasPointerCapture(previous.pointer))
      map.releasePointerCapture(previous.pointer);
  }
  onDestroy(() => finish(false));
  function key(event: KeyboardEvent) {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey)
      return;
    if (event.key === "Escape" && drag) {
      event.preventDefault();
      event.stopPropagation();
      finish(true);
      return;
    }
    const delta = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[event.key];
    if (delta) {
      event.preventDefault();
      event.stopPropagation();
      const current = center();
      navigate({
        x: current.x + (delta[0] * bounds.width) / 5,
        y: current.y + (delta[1] * bounds.height) / 5,
      });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      onfit();
    }
  }
</script>

<svelte:window onblur={() => finish(true)} />
<section class="minimap" aria-label="ミニマップ">
  <button
    bind:this={map}
    class="map"
    aria-label="ミニマップで表示位置を移動"
    title="クリック・ドラッグ・矢印キーで移動。Enterで全体表示。Escでドラッグを取消。"
    style:width={`${screen.width * ratio}px`}
    style:height={`${screen.height * ratio}px`}
    onkeydown={key}
    onpointerdown={(event) => {
      if (event.button !== 0 || !event.isPrimary || !map) return;
      event.preventDefault();
      map.focus({ preventScroll: true });
      drag = { pointer: event.pointerId, center: center() };
      map.setPointerCapture(event.pointerId);
      point(event);
    }}
    onpointermove={(event) => {
      if (drag?.pointer === event.pointerId) point(event);
    }}
    onpointerup={(event) => {
      if (drag?.pointer === event.pointerId) {
        point(event);
        finish(false);
      }
    }}
    onpointercancel={() => finish(true)}
    onlostpointercapture={() => finish(true)}
  >
    <div class="thumbnail" aria-hidden="true">
      <Renderer {screen} {symbols} />
    </div>
    <svg
      class="outline"
      aria-hidden="true"
      viewBox={`0 0 ${screen.width} ${screen.height}`}
    >
      <rect
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        fill="#16a08520"
        stroke="var(--banto-primary)"
        stroke-width="2"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  </button>
  <span>ミニマップ · {Math.round(view.scale * 100)}%</span>
</section>

<style>
  .minimap {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
    gap: 2px;
    padding: 4px;
  }
  .map {
    position: relative;
    display: block;
    padding: 0;
    box-sizing: content-box;
    border: 1px solid var(--banto-border);
    background: var(--banto-bg);
    border-radius: 3px;
    overflow: hidden;
    cursor: crosshair;
    touch-action: none;
  }
  .map:focus-visible {
    outline: 2px solid var(--banto-primary);
    outline-offset: 2px;
  }
  .thumbnail,
  .outline {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  .thumbnail :global(svg) {
    display: block;
    width: 100%;
    height: 100%;
  }
  span {
    font-size: 10px;
    color: var(--banto-text-muted);
    white-space: nowrap;
  }
</style>
