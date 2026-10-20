<script lang="ts">
  import { untrack } from "svelte";
  import { imageCropViewBox, type ImageCrop } from "../image-crop";
  import type { ImageAsset } from "../project";
  import {
    cropGesture,
    type CropGestureMode,
    type CropHandle,
    type CropPoint,
  } from "./image-crop-gesture";
  let {
    asset,
    url,
    crop,
    aspect,
    onchange,
  }: {
    asset: ImageAsset;
    url: string;
    crop?: ImageCrop;
    aspect?: number;
    onchange: (crop: ImageCrop) => void;
  } = $props();
  let svg: SVGSVGElement;
  let drawing = $state(false);
  let scale = $state(1);
  let gesture = $state<{
    id: number;
    mode: CropGestureMode;
    start: CropPoint;
    before?: ImageCrop;
    next: ImageCrop;
    moved: boolean;
    clientX: number;
    clientY: number;
    matrix: number[];
  } | null>(null);
  const box = $derived(imageCropViewBox(asset, gesture?.next ?? crop));
  const handles: { id: CropHandle; x: number; y: number; label: string }[] = [
    { id: "nw", x: 0, y: 0, label: "左上" },
    { id: "n", x: 0.5, y: 0, label: "上" },
    { id: "ne", x: 1, y: 0, label: "右上" },
    { id: "e", x: 1, y: 0.5, label: "右" },
    { id: "se", x: 1, y: 1, label: "右下" },
    { id: "s", x: 0.5, y: 1, label: "下" },
    { id: "sw", x: 0, y: 1, label: "左下" },
    { id: "w", x: 0, y: 0.5, label: "左" },
  ];
  const matrixValues = (m: DOMMatrix) => [m.a, m.b, m.c, m.d, m.e, m.f];
  function point(
    event: PointerEvent,
    matrix = svg.getScreenCTM(),
  ): CropPoint | null {
    if (!matrix) return null;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(
      matrix.inverse(),
    );
    return { x: p.x / asset.width, y: p.y / asset.height };
  }
  function cancel() {
    const id = gesture?.id;
    gesture = null;
    if (id !== undefined && svg?.hasPointerCapture(id))
      svg.releasePointerCapture(id);
  }
  // A different source, committed crop, or numeric draft cancels only the pointer candidate.
  $effect(() => {
    asset;
    url;
    crop;
    aspect;
    untrack(cancel);
  });
  function start(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary || gesture) return;
    const hit = (event.target as Element).closest<SVGElement>(
      "[data-crop-mode]",
    );
    const matrix = svg.getScreenCTM();
    const p = point(event, matrix);
    if (!p) return;
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) {
      if (drawing || !hit || hit.dataset.cropMode === "move") return;
      p.x = Math.max(0, Math.min(1, p.x));
      p.y = Math.max(0, Math.min(1, p.y));
    }
    const mode = drawing
      ? "draw"
      : (hit?.dataset.cropMode as CropGestureMode | undefined);
    if (!mode) return;
    event.preventDefault();
    event.stopPropagation();
    svg.focus({ preventScroll: true });
    const before = crop ? { ...crop } : undefined;
    gesture = {
      id: event.pointerId,
      mode,
      start: p,
      before,
      next: before ?? { x: 0, y: 0, width: 1, height: 1 },
      moved: false,
      clientX: event.clientX,
      clientY: event.clientY,
      matrix: matrixValues(matrix!),
    };
    svg.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    const current = gesture;
    if (!current || event.pointerId !== current.id) return;
    const matrix = svg.getScreenCTM();
    if (
      !matrix ||
      current.matrix.some(
        (n, i) => Math.abs(n - matrixValues(matrix)[i]) > 1e-6,
      )
    )
      return cancel();
    const p = point(event, matrix);
    if (!p) return cancel();
    gesture = {
      ...current,
      moved:
        current.moved ||
        Math.hypot(
          event.clientX - current.clientX,
          event.clientY - current.clientY,
        ) >= 3,
      next: cropGesture(
        asset,
        current.before,
        current.mode,
        current.start,
        p,
        aspect,
      ),
    };
  }
  function finish(event: PointerEvent) {
    if (event.pointerId !== gesture?.id) return;
    move(event);
    const current = gesture;
    cancel();
    if (current?.moved) {
      onchange(current.next);
      drawing = false;
    }
  }
  function interrupted(event: PointerEvent) {
    if (event.pointerId === gesture?.id) cancel();
  }
  function key(event: KeyboardEvent, mode: CropGestureMode = "move") {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey)
      return;
    const directions: Record<string, CropPoint> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const d = directions[event.key];
    if (!d || gesture) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    onchange(
      cropGesture(
        asset,
        crop,
        mode,
        { x: 0, y: 0 },
        { x: (d.x * step) / asset.width, y: (d.y * step) / asset.height },
        aspect,
      ),
    );
  }
  function observe(node: SVGSVGElement) {
    function resized() {
      cancel();
      scale = node.getScreenCTM()?.a || 1;
    }
    const observer = new ResizeObserver(resized);
    observer.observe(node);
    const form = node.closest("form");
    const keydown = (event: KeyboardEvent) => {
      if (!gesture || event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
      } else if (
        event.ctrlKey ||
        event.metaKey ||
        event.key === "Tab" ||
        event.key === "Enter"
      )
        cancel();
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", cancel);
    form?.addEventListener("submit", cancel, true);
    form?.addEventListener("reset", cancel, true);
    return {
      destroy() {
        cancel();
        observer.disconnect();
        window.removeEventListener("keydown", keydown, true);
        window.removeEventListener("blur", cancel);
        form?.removeEventListener("submit", cancel, true);
        form?.removeEventListener("reset", cancel, true);
      },
    };
  }
</script>

<div class="crop-selection">
  <button
    type="button"
    aria-pressed={drawing}
    onclick={() => {
      cancel();
      drawing = !drawing;
    }}>範囲を指定</button
  >
  <p>
    {drawing
      ? "原本上をドラッグして範囲を指定します。"
      : "枠内をドラッグして移動、辺・隅でサイズ変更します。"}
  </p>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex (SVG editor has explicit arrow-key controls) -->
  <svg
    bind:this={svg}
    use:observe
    viewBox={`0 0 ${asset.width} ${asset.height}`}
    role="application"
    aria-label="切出し範囲の操作面"
    tabindex="0"
    data-crop-selection
    data-crop-gesture={gesture ? "active" : undefined}
    class:drawing
    onpointerdown={start}
    onpointermove={move}
    onpointerup={finish}
    onpointercancel={interrupted}
    onlostpointercapture={interrupted}
    onkeydown={(e) => key(e)}
  >
    <image href={url} width={asset.width} height={asset.height} />
    <path
      d={`M0 0H${asset.width}V${asset.height}H0Z M${box.x} ${box.y}v${box.height}h${box.width}v-${box.height}Z`}
      fill="#000"
      fill-opacity="0.4"
      fill-rule="evenodd"
      pointer-events="none"
    />
    <rect
      {...box}
      data-crop-mode="move"
      fill="transparent"
      stroke="var(--banto-primary, #2563eb)"
      vector-effect="non-scaling-stroke"
      stroke-width="2"
      style:cursor={drawing ? "crosshair" : "move"}
    />
    {#each handles as handle}
      <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role (SVG crop handles are keyboard buttons) -->
      <rect
        x={box.x + box.width * handle.x - 7 / scale}
        y={box.y + box.height * handle.y - 7 / scale}
        width={14 / scale}
        height={14 / scale}
        data-crop-mode={handle.id}
        role="button"
        tabindex="0"
        aria-label={`切出し範囲の${handle.label}を変更`}
        fill="var(--banto-surface, white)"
        stroke="var(--banto-primary, #2563eb)"
        vector-effect="non-scaling-stroke"
        style:cursor={drawing ? "crosshair" : `${handle.id}-resize`}
        onkeydown={(e) => key(e, handle.id)}
      />
    {/each}
  </svg>
  <p>
    離すと数値欄へ反映します。適用するまでは図面を変更しません。Escでドラッグを取消。矢印キーで原本1画素、Shift併用で10画素。
  </p>
</div>

<style>
  .crop-selection {
    margin-top: 10px;
  }
  svg {
    display: block;
    width: 100%;
    height: 240px;
    overflow: visible;
    background: var(--banto-surface-alt);
    touch-action: none;
    user-select: none;
  }
  svg.drawing {
    cursor: crosshair;
  }
  p {
    font-size: 10px;
    color: var(--banto-text-muted);
    margin: 5px 0;
  }
  button {
    font: inherit;
    font-size: 11px;
    min-height: 30px;
    border: 1px solid var(--banto-border);
    border-radius: 3px;
    background: var(--banto-surface);
    color: var(--banto-text);
    padding: 5px 6px;
    cursor: pointer;
  }
  button[aria-pressed="true"] {
    background: var(--banto-primary);
    color: var(--banto-primary-contrast, white);
  }
  :is(svg, rect, button):focus-visible {
    outline: 2px solid var(--banto-primary);
    outline-offset: 2px;
  }
</style>
