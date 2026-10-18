<script lang="ts" module>
  export type DesignerPanel = "project" | "layers" | "parts";
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  let {
    active = $bindable<DesignerPanel>("project"),
    editable,
    projectPanel,
    layersPanel,
    partsPanel,
  }: {
    active?: DesignerPanel;
    editable: boolean;
    projectPanel: Snippet;
    layersPanel: Snippet;
    partsPanel: Snippet;
  } = $props();
  const panels = [
    { id: "project", label: "プロジェクト" },
    { id: "layers", label: "レイヤー" },
    { id: "parts", label: "部品" },
  ] as const;
  const shown = $derived(editable ? active : "project");
  function navigate(event: KeyboardEvent) {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey)
      return;
    const buttons = [
      ...(
        event.currentTarget as HTMLElement
      ).querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
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

<div class="sidebar-panels">
  <div
    role="tablist"
    aria-label="Designer 左パネル"
    tabindex="-1"
    onkeydown={navigate}
  >
    {#each panels as panel}
      <button
        type="button"
        role="tab"
        id={`designer-tab-${panel.id}`}
        aria-controls={`designer-panel-${panel.id}`}
        aria-selected={shown === panel.id}
        tabindex={shown === panel.id ? 0 : -1}
        disabled={!editable && panel.id !== "project"}
        onclick={() => (active = panel.id)}>{panel.label}</button
      >
    {/each}
  </div>
  <!-- Keep mounted: switching tabs must not unregister drafts or reset searches. -->
  {#each panels as panel}
    <div
      role="tabpanel"
      id={`designer-panel-${panel.id}`}
      aria-labelledby={`designer-tab-${panel.id}`}
      hidden={shown !== panel.id}
      tabindex="0"
      class="panel"
    >
      {#if panel.id === "project"}{@render projectPanel()}
      {:else if panel.id === "layers"}{@render layersPanel()}
      {:else}{@render partsPanel()}{/if}
    </div>
  {/each}
</div>

<style>
  .sidebar-panels {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
  }
  [role="tablist"] {
    display: flex;
    flex-shrink: 0;
    border-bottom: 1px solid var(--banto-border);
  }
  button {
    flex: 1;
    min-width: 0;
    padding: 10px 2px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--banto-text-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  button[aria-selected="true"] {
    color: var(--banto-primary);
    border-bottom-color: var(--banto-primary);
    background: var(--banto-surface);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button:focus-visible,
  .panel:focus-visible {
    outline: none;
    box-shadow: inset var(--banto-focus-ring);
  }
  .panel {
    min-height: 0;
    overflow: auto;
    padding: 10px 8px;
    flex: 1;
  }
  .panel[hidden] {
    display: none;
  }
  @media (max-width: 1099px) {
    .panel {
      max-height: 520px;
    }
  }
</style>
