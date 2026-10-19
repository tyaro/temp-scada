<script lang="ts">
  import { tick } from "svelte";
  import type { Screen } from "../project";
  import ContextActions, { type ContextAction } from "./ContextActions.svelte";
  let {
    screens,
    activeId,
    editable,
    contextKey,
    onopen,
    actions,
  }: {
    screens: Screen[];
    activeId: string | null;
    editable: boolean;
    contextKey: string;
    onopen: (id: string) => void;
    actions: (id: string) => ContextAction[];
  } = $props();
  let root = $state<HTMLElement>();
  $effect(() => {
    const id = activeId;
    const host = root;
    screens.length;
    void tick().then(() => {
      if (!host?.isConnected || activeId !== id) return;
      const active = [
        ...host.querySelectorAll<HTMLButtonElement>("[data-screen-tab]"),
      ].find((button) => button.dataset.screenTab === id);
      if (!active) return;
      const area = host.getBoundingClientRect();
      const box = active.getBoundingClientRect();
      host.scrollLeft +=
        box.left < area.left
          ? box.left - area.left
          : Math.max(0, box.right - area.right);
    });
  });
  function navigate(event: KeyboardEvent) {
    if (
      event.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      (event.target as Element).closest('[role="menu"]')
    )
      return;
    const root = (event.currentTarget as HTMLElement).closest("nav")!;
    const buttons = [
      ...root.querySelectorAll<HTMLButtonElement>("[data-screen-tab]"),
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
    buttons[next].focus({ preventScroll: true });
    const box = buttons[next].getBoundingClientRect();
    const area = root.getBoundingClientRect();
    root.scrollLeft +=
      box.left < area.left
        ? box.left - area.left
        : Math.max(0, box.right - area.right);
  }
</script>

<nav aria-label="画面タブ" bind:this={root}>
  {#each screens as screen (screen.id)}
    {#snippet row()}
      <button
        data-screen-tab={screen.id}
        aria-current={activeId === screen.id ? "page" : undefined}
        title={screen.name}
        onkeydown={navigate}
        onclick={() => onopen(screen.id)}
        ><span class="dot" aria-hidden="true"></span>{screen.name}</button
      >
    {/snippet}
    {#if editable}<ContextActions
        label={`画面タブ：${screen.name}`}
        flat
        {contextKey}
        items={actions(screen.id)}>{@render row()}</ContextActions
      >{:else}{@render row()}{/if}
  {/each}
</nav>

<style>
  nav {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    flex-shrink: 0;
    min-width: 0;
    padding: 0 12px;
    border-bottom: 1px solid var(--banto-border);
    background: var(--studio-chrome);
    scrollbar-width: thin;
  }
  nav > :global(*) {
    flex-shrink: 0;
  }
  button {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 30px;
    max-width: 240px;
    padding: 5px 26px 5px 12px;
    border: 0;
    border-bottom: 2px solid transparent;
    border-radius: 5px 5px 0 0;
    background: transparent;
    color: var(--banto-text-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  button:hover {
    background: var(--banto-surface-hover);
  }
  button[aria-current="page"] {
    color: var(--banto-text);
    background: var(--studio-selection);
    border-bottom-color: var(--banto-primary);
    font-weight: 600;
  }
  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: transparent;
    flex-shrink: 0;
  }
  button[aria-current="page"] .dot {
    background: var(--banto-primary);
  }
  button:focus-visible {
    outline: none;
    box-shadow: inset var(--banto-focus-ring);
  }
</style>
