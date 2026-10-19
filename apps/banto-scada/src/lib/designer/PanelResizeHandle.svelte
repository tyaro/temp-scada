<script lang="ts">
  import { onDestroy } from "svelte";
  let {
    side,
    value,
    min,
    max,
    standard,
    onstart,
    onchange,
    onend,
    canCommit = () => true,
  }: {
    side: "left" | "right" | "bottom";
    value: number;
    min: number;
    max: number;
    standard: number;
    onstart: () => void;
    onchange: (width: number) => void;
    onend: (commit: boolean) => void;
    canCommit?: () => boolean;
  } = $props();
  let element: HTMLDivElement;
  let drag = $state<{ pointer: number; x: number; width: number } | null>(null);
  const label = $derived(
    side === "bottom"
      ? "タグ参照パネルの高さ"
      : side === "left"
        ? "左パネルの幅"
        : "プロパティの幅",
  );
  const coordinate = (event: PointerEvent) =>
    side === "bottom" ? event.clientY : event.clientX;
  const clamp = (width: number) =>
    Math.max(min, Math.min(max, Math.round(width)));
  function stop(commit: boolean) {
    const previous = drag;
    if (!previous) return;
    // The native resize can precede Svelte layout teardown and pointer release.
    commit = commit && canCommit();
    drag = null;
    if (!commit) onchange(clamp(previous.width));
    if (element?.hasPointerCapture(previous.pointer))
      element.releasePointerCapture(previous.pointer);
    onend(commit);
  }
  export function cancel() {
    stop(false);
  }
  function down(event: PointerEvent) {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    element.focus({ preventScroll: true });
    drag = { pointer: event.pointerId, x: coordinate(event), width: value };
    element.setPointerCapture(event.pointerId);
    onstart();
  }
  function move(event: PointerEvent) {
    if (drag?.pointer !== event.pointerId) return;
    onchange(
      clamp(
        drag.width + (coordinate(event) - drag.x) * (side === "left" ? 1 : -1),
      ),
    );
  }
  function key(event: KeyboardEvent) {
    if (event.key === "Escape" && drag) {
      event.preventDefault();
      event.stopPropagation();
      stop(false);
      return;
    }
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.isComposing ||
      drag
    )
      return;
    const step = event.shiftKey ? 32 : 8;
    let next: number;
    if (
      event.key === (side === "bottom" ? "ArrowUp" : "ArrowLeft") ||
      event.key === (side === "bottom" ? "ArrowDown" : "ArrowRight")
    )
      next =
        value +
        (event.key === "ArrowRight" || event.key === "ArrowDown"
          ? step
          : -step) *
          (side === "left" ? 1 : -1);
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "Enter") next = standard;
    else return;
    event.preventDefault();
    onstart();
    onchange(clamp(next));
    onend(true);
  }
  function reset() {
    onstart();
    onchange(clamp(standard));
    onend(true);
  }
  onDestroy(() => stop(false));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (WAI-ARIA window splitter: a focusable separator with keyboard range controls.) -->
<div
  class="resize-handle"
  class:dragging={!!drag}
  class:bottom={side === "bottom"}
  bind:this={element}
  style:left={side === "left" ? `${value - 4}px` : undefined}
  style:right={side === "right" ? `${value - 4}px` : undefined}
  role="separator"
  tabindex="0"
  aria-label={label}
  aria-orientation={side === "bottom" ? "horizontal" : "vertical"}
  aria-controls={side === "bottom"
    ? "designer-references-panel"
    : side === "left"
      ? "designer-project-panel"
      : "designer-inspector-panel"}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={value}
  aria-valuetext={`${value}px`}
  title={`${label}：ドラッグ・${side === "bottom" ? "上下" : "左右"}キーで調整、Shiftで大きく移動、Enter・ダブルクリックで標準${side === "bottom" ? "高さ" : "幅"}、Escでドラッグ取消`}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={(event) => {
    if (drag?.pointer === event.pointerId) {
      move(event);
      stop(true);
    }
  }}
  onpointercancel={() => stop(false)}
  onlostpointercapture={() => stop(false)}
  onkeydown={key}
  ondblclick={reset}
></div>

<style>
  .resize-handle {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 8px;
    z-index: 2;
    cursor: col-resize;
    touch-action: none;
  }
  .resize-handle::after {
    content: "";
    position: absolute;
    left: 3px;
    width: 2px;
    height: 100%;
    background: transparent;
  }
  .resize-handle:hover::after,
  .resize-handle:focus-visible::after,
  .dragging::after {
    background: var(--banto-primary);
  }
  .resize-handle.bottom {
    left: 0;
    right: 0;
    top: -4px;
    bottom: auto;
    width: 100%;
    height: 8px;
    cursor: row-resize;
  }
  .bottom::after {
    left: 0;
    top: 3px;
    height: 2px;
    width: 100%;
  }
  .resize-handle:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 1px var(--banto-primary);
  }
</style>
