<script lang="ts" module>
  export type ToolbarAction = {
    label: string;
    icon: string;
    disabled?: boolean;
    run: () => void;
  };
  export type ToolbarGroup = { label: string; items: ToolbarAction[] };
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  let {
    groups,
    selectionCount,
    modes,
    controls,
    status,
  }: {
    groups: ToolbarGroup[];
    selectionCount: number;
    modes: Snippet;
    controls: Snippet;
    status: Snippet;
  } = $props();
  let root: HTMLDivElement;
  let active = $state("");
  const enabled = $derived(
    groups.flatMap((g) => g.items).filter((item) => !item.disabled),
  );
  const tabStop = $derived(
    enabled.find((item) => item.label === active)?.label ?? enabled[0]?.label,
  );
  function navigate(event: KeyboardEvent) {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey)
      return;
    const buttons = [
      ...root.querySelectorAll<HTMLButtonElement>(
        "button[data-edit-action]:not(:disabled)",
      ),
    ];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % buttons.length;
    else if (event.key === "ArrowLeft")
      next = (index + buttons.length - 1) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else return;
    event.preventDefault();
    buttons[next].focus();
  }
</script>

<div
  bind:this={root}
  role="toolbar"
  aria-label="共通編集ツールバー"
  aria-orientation="horizontal"
  onkeydown={navigate}
  tabindex="-1"
>
  {@render modes()}
  {#each groups as group (group.label)}
    <div class="group" role="group" aria-label={group.label}>
      {#each group.items as item (item.label)}
        <button
          type="button"
          data-edit-action
          aria-label={item.label}
          title={item.label}
          disabled={item.disabled}
          tabindex={tabStop === item.label ? 0 : -1}
          onfocus={() => (active = item.label)}
          onclick={item.run}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24"
            ><path d={item.icon} /></svg
          >
        </button>
      {/each}
    </div>
  {/each}
  {@render controls()}
  {#if groups.length}<span class="selection" title="Shift + クリックで複数選択"
      >{selectionCount} 件選択</span
    >{/if}
  {@render status()}
</div>

<style>
  [role="toolbar"] {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 4px 12px;
    background: var(--banto-surface);
    border-bottom: 1px solid var(--banto-border);
    flex-shrink: 0;
  }
  .group {
    display: flex;
    gap: 2px;
    padding-right: 6px;
    margin-right: 2px;
    border-right: 1px solid var(--banto-border);
  }
  button {
    width: 32px;
    height: 32px;
    padding: 6px;
    display: grid;
    place-items: center;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--banto-text);
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--banto-surface-hover);
    border-color: var(--banto-border);
  }
  button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  svg {
    width: 20px;
    height: 20px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .selection {
    font-size: 12px;
    color: var(--banto-text-muted);
    margin-left: 6px;
    white-space: nowrap;
  }
</style>
