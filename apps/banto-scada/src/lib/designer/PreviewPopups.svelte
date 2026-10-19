<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { Modal, restoreFocus } from "@banto/ui";
  import type { Project } from "../project";
  import type { TagReadings } from "../tag-presentation";
  import { projectScreenReferences } from "../screen-references";
  import {
    openPopup,
    frontPopup,
    positionPopup,
    constrainPopups,
    closePopup,
    MAX_PREVIEW_POPUPS,
    MAX_POPUP_PLACEMENTS,
    type PreviewPopups as Windows,
    type PopupFrame,
  } from "../preview-popups";
  import PreviewWindow from "./PreviewWindow.svelte";
  let {
    project,
    images,
    readings,
    onmessage,
  }: {
    project: Project;
    images?: ReadonlyMap<
      string,
      { url: string; width: number; height: number }
    >;
    readings?: TagReadings;
    onmessage: (message: string) => void;
  } = $props();
  let root = $state<HTMLElement>(),
    width = $state(0),
    height = $state(0);
  let windows = $state<Windows>([]),
    picker = $state(false),
    selected = $state(""),
    search = $state("");
  let active = true,
    opener: HTMLElement | null = null;
  const origins = new Map<string, HTMLElement>();
  const controllers: Record<string, { cancel: () => void } | undefined> = {};
  $effect(() => {
    const element = root;
    if (!element) return;
    const initial = element.getBoundingClientRect();
    width = initial.width;
    height = initial.height;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) {
        width = box.width;
        height = box.height;
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  });
  const area = $derived({ width, height });
  // Keep DOM nodes stable during pointer capture; fronting changes only z-index.
  const rendered = $derived(
    [...windows].sort((a, b) => a.screenId.localeCompare(b.screenId)),
  );
  const costs = $derived(projectScreenReferences(project).expandedCosts);
  const options = $derived(
    project.screens
      .map((screen) => ({
        screen,
        reason: windows.some((w) => w.screenId === screen.id)
          ? null
          : windows.length >= MAX_PREVIEW_POPUPS
            ? "小窓は4件までです"
            : windows.reduce((sum, w) => sum + w.cost, 0) +
                  costs.get(screen.id)! >
                MAX_POPUP_PLACEMENTS
              ? "小窓全体の描画配置数が20,000件を超えます"
              : null,
      }))
      .filter((o) =>
        o.screen.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
      ),
  );
  const candidate = $derived(options.find((o) => o.screen.id === selected));
  $effect(() => {
    const next = area;
    untrack(() => (windows = constrainPopups(windows, next)));
  });
  onDestroy(() => {
    active = false;
  });
  export function showPicker(origin: HTMLElement) {
    if (!active) return;
    for (const controller of Object.values(controllers)) controller?.cancel();
    opener = origin;
    selected = "";
    search = "";
    picker = true;
  }
  function focusWindow(id: string) {
    void tick().then(() => {
      if (active)
        requestAnimationFrame(() => {
          if (active)
            root
              ?.querySelector<HTMLElement>(
                `[data-preview-popup="${id}"] [data-popup-move]`,
              )
              ?.focus({ preventScroll: true });
        });
    });
  }
  function open() {
    if (!candidate || candidate.reason) return;
    const id = candidate.screen.id;
    try {
      windows = openPopup(windows, id, costs.get(id)!, area);
      if (opener && !origins.has(id)) origins.set(id, opener);
      picker = false;
      focusWindow(id);
    } catch (error) {
      onmessage(error instanceof Error ? error.message : "小窓を開けません。");
    }
  }
  function front(id: string) {
    if (active) windows = frontPopup(windows, id);
  }
  function frame(id: string, value: PopupFrame) {
    if (active && windows.some((w) => w.screenId === id))
      windows = positionPopup(windows, id, value, area);
  }
  function close(id: string) {
    const panel = root?.querySelector<HTMLElement>(
        `[data-preview-popup="${id}"]`,
      ),
      restore = !!panel?.contains(document.activeElement),
      origin = origins.get(id);
    windows = closePopup(windows, id);
    origins.delete(id);
    if (restore)
      void tick().then(() => {
        if (active) restoreFocus(origin, () => opener);
      });
  }
</script>

<div class="popup-area" bind:this={root} role="group" aria-label="小窓表示領域">
  {#each rendered as entry (entry.screenId)}
    {@const screen = project.screens.find((s) => s.id === entry.screenId)!}
    <PreviewWindow
      bind:this={controllers[entry.screenId]}
      {entry}
      {screen}
      {project}
      {area}
      rank={windows.findIndex((w) => w.screenId === entry.screenId)}
      {images}
      {readings}
      onfront={() => front(entry.screenId)}
      onframe={(value) => frame(entry.screenId, value)}
      onclose={() => close(entry.screenId)}
    />
  {/each}
</div>
<Modal
  open={picker}
  title="画面を小窓で表示確認"
  onclose={() => (picker = false)}
  focusFallback={() => opener}
>
  <p>
    プレビュー専用の読取表示です。位置やサイズは保存せず、画面切替・編集復帰・Project読込で閉じます。
  </p>
  <label
    >画面を検索<input
      type="search"
      aria-label="小窓に表示する画面を検索"
      bind:value={search}
    /></label
  >
  <div class="sources" role="group" aria-label="小窓に表示する画面">
    {#each options as option (option.screen.id)}
      <label
        ><input
          type="radio"
          name="popup-source"
          value={option.screen.id}
          bind:group={selected}
          disabled={!!option.reason}
        /><span
          >{option.screen
            .name}{#if windows.some((w) => w.screenId === option.screen.id)}<small
              >既存の小窓を前面へ表示</small
            >{/if}{#if option.reason}<small>{option.reason}</small>{/if}</span
        ></label
      >
    {/each}
    {#if !options.length}<p>一致する画面がありません。</p>{/if}
  </div>
  <div class="actions">
    <button onclick={() => (picker = false)}>キャンセル</button><button
      disabled={!candidate || !!candidate.reason}
      onclick={open}>小窓を表示</button
    >
  </div>
</Modal>

<style>
  .popup-area {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
  }
  .sources {
    max-height: 40vh;
    overflow: auto;
    margin: 1rem 0;
  }
  .sources label {
    display: flex;
    gap: 0.6rem;
    padding: 0.5rem 0;
    align-items: start;
  }
  .sources input {
    margin-top: 0.3rem;
  }
  small {
    display: block;
    color: var(--banto-text-muted);
    font-size: 0.8rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  input[type="search"] {
    width: 100%;
  }
</style>
