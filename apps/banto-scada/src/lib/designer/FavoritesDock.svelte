<script lang="ts">
  import { tick } from "svelte";
  import type { FavoriteItem } from "./favorites";
  import type { PalettePart } from "./palette-drag";
  import { PALETTE_MIME } from "./palette-drag";
  import ContextActions from "./ContextActions.svelte";
  import SymbolThumbnail from "./SymbolThumbnail.svelte";
  import builtins from "../symbol-library.json";
  import type { SymbolDefinition } from "../project";
  let {
    items,
    contextKey,
    onplace,
    onremove,
    onbrowse,
    onstartdrag,
    onenddrag,
  }: {
    items: FavoriteItem[];
    contextKey: string;
    onplace: (part: PalettePart) => void;
    onremove: (part: PalettePart) => void;
    onbrowse: () => void;
    onstartdrag: (part: PalettePart) => string | null;
    onenddrag: () => void;
  } = $props();
  let root = $state<HTMLElement>();
  async function remove(part: PalettePart) {
    onremove(part);
    await tick();
    root
      ?.querySelector<HTMLButtonElement>(".dock-part, .browse")
      ?.focus({ preventScroll: true });
  }
  function drag(event: DragEvent, part: PalettePart) {
    const token = onstartdrag(part);
    if (!token || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(PALETTE_MIME, token);
  }
</script>

<section class="favorites-dock" aria-label="お気に入り部品" bind:this={root}>
  <div class="dock-items">
    {#each items as item (item.key)}
      <ContextActions
        label={`お気に入り：${item.label}`}
        {contextKey}
        items={[
          { label: "現在の画面へ配置", run: () => onplace(item.part) },
          { label: "お気に入りから外す", run: () => remove(item.part) },
        ]}
      >
        <button
          class="dock-part"
          aria-label={`お気に入り：${item.label}を配置`}
          title={`${item.label}を配置 · ドラッグして位置を指定`}
          draggable="true"
          ondragstart={(event) => drag(event, item.part)}
          ondragend={onenddrag}
          onclick={() => onplace(item.part)}
        >
          {#if item.part.type === "builtin"}<SymbolThumbnail
              definition={builtins[
                item.part.template
              ] as unknown as SymbolDefinition}
            />
          {:else if item.definition}<SymbolThumbnail
              definition={item.definition}
            />
          {:else}<svg
              aria-hidden="true"
              viewBox="0 0 40 32"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              {#if item.part.type === "basic" && item.part.kind === "rectangle"}<rect
                  x="6"
                  y="6"
                  width="28"
                  height="20"
                  rx="1"
                />
              {:else if item.part.type === "basic" && item.part.kind === "ellipse"}<ellipse
                  cx="20"
                  cy="16"
                  rx="14"
                  ry="10"
                />
              {:else if item.part.type === "basic" && item.part.kind === "text"}<path
                  d="M10 6h20M20 6v20M15 26h10"
                />
              {:else if item.part.type === "basic" && item.part.kind === "line"}<path
                  d="M6 26L34 6"
                />
              {:else}<path d="M6 6h14v20h14" stroke-width="3" />{/if}
            </svg>{/if}
        </button>
      </ContextActions>
    {/each}
  </div>
  {#if !items.length}<span class="empty">部品の☆から登録</span>{/if}
  <button
    class="browse"
    aria-label="部品パネルを開く"
    title="部品パネルを開く"
    onclick={onbrowse}>＋</button
  >
</section>

<style>
  .favorites-dock {
    display: flex;
    align-items: center;
    align-self: center;
    flex-shrink: 0;
    gap: 4px;
    max-width: calc(100% - 24px);
    margin: 6px 12px;
    padding: 4px 8px;
    border: 1px solid var(--banto-border);
    border-radius: 12px;
    background: var(--studio-panel, var(--banto-surface));
    box-shadow: 0 3px 12px #316e8414;
  }
  .dock-items {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow-x: auto;
    min-width: 0;
    scrollbar-width: thin;
  }
  .dock-items > :global(*) {
    flex-shrink: 0;
  }
  button {
    display: grid;
    place-items: center;
    height: 40px;
    width: 46px;
    background: transparent;
    border: 0;
    border-radius: 5px;
    color: var(--banto-text);
    cursor: pointer;
  }
  button:hover {
    background: var(--studio-selection, var(--banto-surface-hover));
  }
  button:focus-visible {
    outline: none;
    box-shadow: inset var(--banto-focus-ring);
  }
  .dock-part {
    padding: 4px;
    cursor: grab;
  }
  .dock-part :global(svg) {
    width: 34px;
    height: 30px;
  }
  .browse {
    width: 34px;
    flex-shrink: 0;
    border-left: 1px solid var(--banto-border);
    border-radius: 0;
    font-size: 28px;
    font-weight: 300;
  }
  .empty {
    font-size: 11px;
    color: var(--banto-text-muted);
    white-space: nowrap;
  }
</style>
