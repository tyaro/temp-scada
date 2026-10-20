<script lang="ts">
  import { Menu, MenuItem } from "@banto/ui";
  import type { FloatingInspector } from "./controllers/floating-inspector.svelte";
  let { layout, onclose }: { layout?: FloatingInspector; onclose: () => void } =
    $props();
</script>

<div class="panel-header">
  <h2>
    {#if layout?.floating}<button
        type="button"
        class="grip"
        aria-label="プロパティパネルを移動"
        aria-describedby="inspector-placement-help"
        title="ドラッグで移動。Enterでキーボード操作"
        onpointerdown={(event) => layout?.pointerStart("move", event)}
        onkeydown={(event) => layout?.keyboardStart("move", event)}
        >⠿ プロパティ</button
      >{:else}プロパティ{/if}
  </h2>
  <div class="actions">
    {#if layout}
      <Menu label="プロパティの配置" placement="bottom-end">
        {#snippet trigger(props)}<button
            {...props}
            type="button"
            title="プロパティの配置"
            aria-label="プロパティの配置">⋯</button
          >{/snippet}
        <MenuItem
          label={layout.preferredFloating
            ? "右へ戻す"
            : layout.supported
              ? "浮動にする"
              : "浮動にする（広い画面で利用できます）"}
          disabled={layout.blocked ||
            (!layout.preferredFloating && !layout.supported)}
          onSelect={layout.toggle}
        />
        <MenuItem
          label="プロパティ配置を保存"
          disabled={layout.blocked || layout.saving || layout.gesturing}
          onSelect={() => void layout?.save()}
        />
        <MenuItem
          label="保存したプロパティ配置に戻す"
          disabled={layout.blocked || !layout.hasSaved}
          onSelect={layout.restore}
        />
        <MenuItem label="プロパティを隠す" onSelect={onclose} />
      </Menu>
    {/if}
    <button
      type="button"
      aria-label="プロパティを隠す"
      title="プロパティを隠す"
      onclick={onclose}>×</button
    >
  </div>
</div>
<span class="sr-only" id="inspector-placement-help"
  >EnterまたはSpaceで開始、矢印で8px、Shiftと矢印で32px、Enterで確定、Escapeで取消、Tabで確定して移動します。</span
>
{#if layout}<span class="sr-only" role="status" aria-live="polite"
    >{layout.announcement}</span
  >{/if}

<style>
  .panel-header {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--banto-surface);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--banto-border);
  }
  h2 {
    font-size: 13px;
    margin: 0;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  button {
    width: 28px;
    height: 28px;
    margin: 0;
    padding: 2px;
    font-size: 20px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--banto-text);
    cursor: pointer;
  }
  button:hover {
    background: var(--banto-surface-hover);
  }
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .grip {
    width: auto;
    font: inherit;
    font-weight: inherit;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  .grip:active {
    cursor: grabbing;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
