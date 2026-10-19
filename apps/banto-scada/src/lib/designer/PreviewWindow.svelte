<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { hasVisibleLayerAbove } from "@banto/ui";
  import type { Project, Screen } from "../project";
  import type { TagReadings } from "../tag-presentation";
  import type { PreviewPopup, PopupArea, PopupFrame } from "../preview-popups";
  import ScreenPainting from "../ScreenPainting.svelte";
  let {
    entry,
    screen,
    project,
    area,
    rank,
    images,
    readings,
    onfront,
    onframe,
    onclose,
  }: {
    entry: PreviewPopup;
    screen: Screen;
    project: Project;
    area: PopupArea;
    rank: number;
    images?: ReadonlyMap<
      string,
      { url: string; width: number; height: number }
    >;
    readings?: TagReadings;
    onfront: () => void;
    onframe: (frame: PopupFrame) => void;
    onclose: () => void;
  } = $props();
  let panel = $state<HTMLElement>();
  let drag = $state<{
    pointer: number;
    target: HTMLElement;
    x: number;
    y: number;
    frame: PopupFrame;
    kind: "move" | "resize";
  } | null>(null);
  function release() {
    const previous = drag;
    drag = null;
    if (previous?.target.hasPointerCapture(previous.pointer))
      previous.target.releasePointerCapture(previous.pointer);
    return previous;
  }
  function finish(cancel: boolean) {
    const previous = release();
    if (cancel && previous) onframe(previous.frame);
  }
  export function cancel() {
    finish(true);
  }
  onDestroy(() => {
    release();
  });
  $effect(() => {
    area.width;
    area.height;
    untrack(() => finish(true));
  });
  function down(event: PointerEvent, kind: "move" | "resize") {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    event.stopPropagation();
    onfront();
    const target = event.currentTarget as HTMLElement;
    target.focus({ preventScroll: true });
    drag = {
      pointer: event.pointerId,
      target,
      x: event.clientX,
      y: event.clientY,
      frame: entry.frame,
      kind,
    };
    target.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent) {
    if (drag?.pointer !== event.pointerId) return;
    const dx = event.clientX - drag.x,
      dy = event.clientY - drag.y;
    onframe(
      drag.kind === "move"
        ? { ...drag.frame, x: drag.frame.x + dx, y: drag.frame.y + dy }
        : {
            ...drag.frame,
            width: drag.frame.width + dx,
            height: drag.frame.height + dy,
          },
    );
  }
  function keys(event: KeyboardEvent, kind: "move" | "resize") {
    if (
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      drag
    )
      return;
    const delta = (
      {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      } as Record<string, number[]>
    )[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    onfront();
    const step = event.shiftKey ? 32 : 8,
      f = entry.frame;
    onframe(
      kind === "move"
        ? { ...f, x: f.x + delta[0] * step, y: f.y + delta[1] * step }
        : {
            ...f,
            width: f.width + delta[0] * step,
            height: f.height + delta[1] * step,
          },
    );
  }
  function escape(event: KeyboardEvent) {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isComposing ||
      hasVisibleLayerAbove({ except: panel })
    )
      return;
    if (drag) {
      event.preventDefault();
      finish(true);
      return;
    }
    if (panel?.contains(document.activeElement)) {
      event.preventDefault();
      onclose();
    }
  }
  function focusChanged() {
    if (drag && hasVisibleLayerAbove({ except: panel })) finish(true);
  }
</script>

<svelte:window onkeydown={escape} onblur={() => finish(true)} />
<svelte:document onfocusin={focusChanged} />
<div
  class="preview-window"
  bind:this={panel}
  role="dialog"
  aria-modal="false"
  aria-label={`画面の小窓：${screen.name}`}
  data-preview-popup={screen.id}
  tabindex="-1"
  style:left={`${entry.frame.x}px`}
  style:top={`${entry.frame.y}px`}
  style:width={`${entry.frame.width}px`}
  style:height={`${entry.frame.height}px`}
  style:z-index={rank + 1}
  onpointerdowncapture={onfront}
  onfocusin={onfront}
>
  <header>
    <button
      class="move"
      data-popup-move
      aria-label={`小窓を移動：${screen.name}`}
      title="ドラッグまたは方向キーで移動・Shiftで大きく移動"
      onpointerdown={(e) => down(e, "move")}
      onpointermove={move}
      onpointerup={(e) => {
        move(e);
        finish(false);
      }}
      onpointercancel={() => finish(true)}
      onlostpointercapture={() => finish(true)}
      onkeydown={(e) => keys(e, "move")}
      >{screen.name}<small>読取表示の確認</small></button
    >
    <button
      class="close"
      aria-label={`小窓を閉じる：${screen.name}`}
      title="小窓を閉じる"
      onclick={onclose}>×</button
    >
  </header>
  <div class="content">
    <ScreenPainting
      {screen}
      screens={project.screens}
      symbols={project.symbols}
      {images}
      {readings}
    />
  </div>
  <button
    class="resize"
    data-popup-resize
    aria-label={`小窓のサイズを変更：${screen.name}`}
    title="ドラッグまたは方向キーでサイズ変更"
    onpointerdown={(e) => down(e, "resize")}
    onpointermove={move}
    onpointerup={(e) => {
      move(e);
      finish(false);
    }}
    onpointercancel={() => finish(true)}
    onlostpointercapture={() => finish(true)}
    onkeydown={(e) => keys(e, "resize")}>◢</button
  >
</div>

<style>
  .preview-window {
    position: absolute;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    pointer-events: auto;
    border: 1px solid var(--banto-border);
    border-radius: 5px;
    background: var(--banto-bg);
    color: var(--banto-text);
    box-shadow: 0 5px 20px #0003;
    overflow: hidden;
    min-width: 0;
    min-height: 0;
  }
  .preview-window:focus-within {
    border-color: var(--banto-primary);
  }
  header {
    display: flex;
    flex-shrink: 0;
    min-height: 34px;
    border-bottom: 1px solid var(--banto-border);
    background: var(--banto-bg-subtle, var(--banto-bg));
  }
  button {
    color: inherit;
    background: none;
    border: 0;
    border-radius: 0;
  }
  .move {
    display: block;
    flex: 1;
    min-width: 0;
    text-align: left;
    padding: 6px 9px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: move;
    touch-action: none;
    font-weight: 600;
  }
  small {
    font-size: 10px;
    font-weight: 400;
    margin-left: 10px;
    color: var(--banto-text-muted);
  }
  .close {
    flex: 0 0 34px;
    font-size: 22px;
    cursor: pointer;
  }
  .close:hover {
    background: var(--banto-danger);
    color: white;
  }
  .content {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .resize {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 22px;
    height: 22px;
    padding: 0;
    cursor: nwse-resize;
    touch-action: none;
    color: var(--banto-text-muted);
    background: var(--banto-bg);
    opacity: 0.85;
  }
  button:focus-visible {
    outline: 2px solid var(--banto-primary);
    outline-offset: -3px;
  }
</style>
