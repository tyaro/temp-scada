<script lang="ts">
  // 中央の下端の状態行。message・編集中の読取状態・タグ参照の開閉ボタンを描く。状態と開閉の処理は App が持つ（R7c）。
  import type { ComponentProps } from "svelte";
  import SlotReadStatus from "./SlotReadStatus.svelte";

  let {
    message,
    editing,
    readStatusKey,
    screen,
    screens,
    symbols,
    equipmentContext,
    showReferencesToggle,
    referenceCount,
    referenceUsageCount,
    referencesExpanded,
    ontogglereferences,
  }: {
    message: string;
    /** `mode === "edit"`（読取状態の表示） */
    editing: boolean;
    /** SlotReadStatus を作り直す鍵（`workspaceGeneration:screen.id`） */
    readStatusKey: string;
    screen: ComponentProps<typeof SlotReadStatus>["screen"];
    screens: ComponentProps<typeof SlotReadStatus>["screens"];
    symbols: ComponentProps<typeof SlotReadStatus>["symbols"];
    equipmentContext: ComponentProps<typeof SlotReadStatus>["equipmentContext"];
    /** タグ参照の開閉ボタンを出すか */
    showReferencesToggle: boolean;
    referenceCount: number;
    referenceUsageCount: number;
    referencesExpanded: boolean;
    ontogglereferences: () => void;
  } = $props();
</script>

<div class="status-row">
  <p role="status" data-testid="project-status">{message}</p>
  {#if editing}
    <!-- 編集中は読取状態を図面の上に置かず、ステータス行へまとめる（UX精査 P1-3）。 -->
    {#key readStatusKey}
      <SlotReadStatus
        {screen}
        {screens}
        {symbols}
        {equipmentContext}
        alert={false}
        inline
      />
    {/key}
  {/if}
  {#if showReferencesToggle}
    <button
      class="references-toggle"
      aria-expanded={referencesExpanded}
      aria-controls="designer-references-panel"
      aria-label={`Project のタグ参照 · ${referenceCount} タグ / ${referenceUsageCount} 配置`}
      title={`Project のタグ参照 · ${referenceCount} タグ / ${referenceUsageCount} 配置`}
      onclick={ontogglereferences}
      >タグ参照 {referenceCount}
      <span aria-hidden="true">{referencesExpanded ? "▾" : "▴"}</span></button
    >
  {/if}
</div>

<style>
  /* App の要素向けの基本（p・button・section p の折返し）を同じ値で当てる。 */
  p {
    font-size: 13px;
    line-height: 1.8;
    color: var(--banto-text-muted);
    overflow-wrap: anywhere;
  }
  button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 9px 10px;
    margin: 8px 0;
    border: 1px solid var(--banto-border);
    background: var(--banto-surface);
    color: var(--banto-text);
    border-radius: 6px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  button:hover {
    border-color: var(--banto-primary);
  }
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  /* App の `.canvas-stack > :not(.canvas-area)` の flex-shrink 指定は子の根に届かないため、ここで持つ。 */
  .status-row {
    flex-shrink: 0;
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .status-row > [role="status"] {
    flex: 1;
    min-width: 0;
  }
  .references-toggle {
    flex: none;
    width: auto;
    white-space: nowrap;
    margin-right: 8px;
    padding: 1px 8px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--banto-text-muted);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .references-toggle:hover,
  .references-toggle[aria-expanded="true"] {
    border-color: var(--banto-border);
    color: var(--banto-text);
  }
  .references-toggle:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
</style>
