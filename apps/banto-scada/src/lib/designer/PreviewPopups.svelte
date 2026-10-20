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
    popupKey,
    type PopupKind,
    type PreviewPopups as Windows,
    type PopupFrame,
  } from "../preview-popups";
  import PreviewWindow from "./PreviewWindow.svelte";
  import type { EquipmentContext } from "../symbol-slots";
  let {
    project,
    equipmentContext,
    images,
    readings,
    onmessage,
  }: {
    project: Project;
    equipmentContext?: EquipmentContext;
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
    pickerKind = $state<PopupKind>("screen"),
    selected = $state(""),
    search = $state("");
  let active = true,
    opener: HTMLElement | null = null;
  const origins = new Map<string, HTMLElement>();
  const controllers = $state<
    Record<string, { cancel: () => void } | undefined>
  >({});
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
    [...windows].sort((a, b) => popupKey(a).localeCompare(popupKey(b))),
  );
  const costs = $derived(projectScreenReferences(project).expandedCosts);
  const options = $derived(
    (pickerKind === "screen"
      ? project.screens.map((screen) => ({
          id: screen.id,
          label: screen.name,
          cost: costs.get(screen.id)!,
        }))
      : (project.equipment ?? []).map((item) => ({
          id: item.id,
          label: `${item.code} · ${item.name}`,
          cost: 0,
        }))
    )
      .map((target) => ({
        ...target,
        existing: windows.some(
          (w) => w.kind === pickerKind && w.targetId === target.id,
        ),
        reason: windows.some(
          (w) => w.kind === pickerKind && w.targetId === target.id,
        )
          ? null
          : windows.length >= MAX_PREVIEW_POPUPS
            ? "小窓は4件までです"
            : windows.reduce((sum, w) => sum + w.cost, 0) + target.cost >
                MAX_POPUP_PLACEMENTS
              ? "小窓全体の描画配置数が20,000件を超えます"
              : null,
      }))
      .filter((o) =>
        o.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
      ),
  );
  const candidate = $derived(options.find((o) => o.id === selected));
  $effect(() => {
    const missing = windows.filter((w) =>
      w.kind === "screen"
        ? !project.screens.some((s) => s.id === w.targetId)
        : !project.equipment?.some((e) => e.id === w.targetId),
    );
    for (const entry of missing)
      untrack(() => close(entry.targetId, entry.kind));
  });
  $effect(() => {
    const next = area;
    untrack(() => (windows = constrainPopups(windows, next)));
  });
  onDestroy(() => {
    active = false;
  });
  export function showPicker(origin: HTMLElement, kind: PopupKind = "screen") {
    if (!active) return;
    for (const controller of Object.values(controllers)) controller?.cancel();
    pickerKind = kind;
    opener = origin;
    selected = "";
    search = "";
    picker = true;
  }
  function focusWindow(id: string, kind: PopupKind) {
    void tick().then(() => {
      if (active)
        requestAnimationFrame(() => {
          if (active)
            root
              ?.querySelector<HTMLElement>(
                `[data-preview-popup="${id}"][data-popup-kind="${kind}"] [data-popup-move]`,
              )
              ?.focus({ preventScroll: true });
        });
    });
  }
  function open() {
    if (!candidate || candidate.reason) return;
    const id = candidate.id;
    const key = popupKey({ targetId: id, kind: pickerKind });
    try {
      windows = openPopup(windows, id, candidate.cost, area, pickerKind);
      if (opener && !origins.has(key)) origins.set(key, opener);
      picker = false;
      focusWindow(id, pickerKind);
    } catch (error) {
      onmessage(error instanceof Error ? error.message : "小窓を開けません。");
    }
  }
  function front(id: string, kind: PopupKind) {
    if (active) windows = frontPopup(windows, id, kind);
  }
  function frame(id: string, kind: PopupKind, value: PopupFrame) {
    if (active && windows.some((w) => w.targetId === id && w.kind === kind))
      windows = positionPopup(windows, id, value, area, kind);
  }
  function close(id: string, kind: PopupKind) {
    const panel = root?.querySelector<HTMLElement>(
        `[data-preview-popup="${id}"][data-popup-kind="${kind}"]`,
      ),
      restore = !!panel?.contains(document.activeElement),
      origin = origins.get(popupKey({ targetId: id, kind }));
    windows = closePopup(windows, id, kind);
    origins.delete(popupKey({ targetId: id, kind }));
    if (restore)
      void tick().then(() => {
        if (active) restoreFocus(origin, () => opener);
      });
  }
</script>

<div class="popup-area" bind:this={root} role="group" aria-label="小窓表示領域">
  {#each rendered as entry (popupKey(entry))}
    {@const screen =
      entry.kind === "screen"
        ? project.screens.find((s) => s.id === entry.targetId)
        : undefined}
    <PreviewWindow
      bind:this={controllers[popupKey(entry)]}
      {entry}
      {screen}
      {project}
      {area}
      {equipmentContext}
      rank={windows.findIndex((w) => popupKey(w) === popupKey(entry))}
      {images}
      {readings}
      onfront={() => front(entry.targetId, entry.kind)}
      onframe={(value) => frame(entry.targetId, entry.kind, value)}
      onclose={() => close(entry.targetId, entry.kind)}
    />
  {/each}
</div>
<Modal
  open={picker}
  title={pickerKind === "screen"
    ? "画面を小窓で表示確認"
    : "機器の読取詳細を開く"}
  onclose={() => (picker = false)}
  focusFallback={() => opener}
>
  <p>
    プレビュー専用の読取表示です。位置やサイズは保存せず、画面切替・編集復帰・Project読込で閉じます。
  </p>
  <label
    >{pickerKind === "screen" ? "画面を検索" : "機器を検索"}<input
      type="search"
      aria-label={pickerKind === "screen"
        ? "小窓に表示する画面を検索"
        : "小窓に表示する機器を検索"}
      bind:value={search}
    /></label
  >
  <div
    class="sources"
    role="group"
    aria-label={pickerKind === "screen"
      ? "小窓に表示する画面"
      : "小窓に表示する機器"}
  >
    {#each options as option (option.id)}
      <label
        ><input
          type="radio"
          name="popup-source"
          value={option.id}
          bind:group={selected}
          disabled={!!option.reason}
        /><span
          >{option.label}{#if option.existing}<small
              >既存の小窓を前面へ表示</small
            >{/if}{#if option.reason}<small>{option.reason}</small>{/if}</span
        ></label
      >
    {/each}
    {#if !options.length}<p>
        一致する{pickerKind === "screen" ? "画面" : "機器"}がありません。
      </p>{/if}
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
