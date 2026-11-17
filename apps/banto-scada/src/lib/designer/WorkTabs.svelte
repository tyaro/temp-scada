<script lang="ts">
  import {
    workTabLabel,
    type WorkTabKind,
  } from "./controllers/work-tabs.svelte";
  // 作業タブの並び（作業タブ設計 §2.1）。画面タブと同じく nav＋aria-current の
  // ボタンで、閉じる（×）はタブの外の兄弟ボタン。画面タブとは別の nav にして
  // 横スクロールさせない。
  let {
    tabs,
    selected,
    onselect,
    onclose,
  }: {
    tabs: readonly WorkTabKind[];
    selected: WorkTabKind | null;
    onselect: (kind: WorkTabKind) => void;
    onclose: (kind: WorkTabKind) => void;
  } = $props();
  function navigate(event: KeyboardEvent) {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey)
      return;
    const root = (event.currentTarget as HTMLElement).closest("nav")!;
    const buttons = [
      ...root.querySelectorAll<HTMLButtonElement>("[data-work-tab]"),
    ];
    const index = buttons.indexOf(event.currentTarget as HTMLButtonElement);
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

<nav aria-label="作業タブ">
  {#each tabs as kind (kind)}
    {@const label = workTabLabel(kind)}
    <span class="tab" class:current={selected === kind}>
      <button
        data-work-tab={kind}
        aria-current={selected === kind ? "page" : undefined}
        onkeydown={navigate}
        onclick={() => onselect(kind)}>{label}</button
      ><button
        class="close"
        aria-label={`${label}を閉じる`}
        title={`${label}を閉じる`}
        onclick={() => onclose(kind)}>×</button
      >
    </span>
  {/each}
</nav>

<style>
  nav {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
    padding: 0 12px 0 4px;
    border-left: 1px solid var(--banto-border);
  }
  .tab {
    display: flex;
    align-items: stretch;
    border-bottom: 2px solid transparent;
    border-radius: 5px 5px 0 0;
  }
  .tab.current {
    background: var(--studio-selection);
    border-bottom-color: var(--banto-primary);
  }
  button {
    min-height: 30px;
    border: 0;
    background: transparent;
    color: var(--banto-text-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  button[data-work-tab] {
    padding: 5px 4px 5px 12px;
  }
  button[aria-current="page"] {
    color: var(--banto-text);
    font-weight: 600;
  }
  .close {
    padding: 5px 8px;
    font-size: 13px;
  }
  .tab:hover {
    background: var(--banto-surface-hover);
  }
  .tab.current:hover {
    background: var(--studio-selection);
  }
  .close:hover {
    color: var(--banto-text);
  }
  button:focus-visible {
    outline: none;
    box-shadow: inset var(--banto-focus-ring);
  }
</style>
