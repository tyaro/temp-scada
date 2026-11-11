<script lang="ts">
  import type { Snippet } from "svelte";
  let {
    label,
    count,
    children,
    action,
    open = $bindable(true),
  }: {
    label: string;
    count?: number;
    children: Snippet;
    /** 見出しの右に置く操作。summary の外に描き、開閉と混ぜない。 */
    action?: Snippet;
    open?: boolean;
  } = $props();
</script>

{#snippet section()}
  <details bind:open class="tree-section" class:has-action={!!action}>
    <summary
      ><svg
        class="folder"
        aria-hidden="true"
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        ><path
          d="M3 7V5a1 1 0 0 1 1-1h6l2 3h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7h18"
        /></svg
      ><span class="label">{label}</span>{#if count !== undefined}<span
          class="count"
          aria-hidden="true">{count}</span
        >{/if}</summary
    >
    <div class="branches">{@render children()}</div>
  </details>
{/snippet}
{#if action}
  <div class="tree-wrap">
    {@render section()}
    <div class="tree-action">{@render action()}</div>
  </div>
{:else}{@render section()}{/if}

<style>
  .tree-section {
    margin: 0 0 2px;
  }
  summary {
    cursor: pointer;
    padding: 4px;
    min-height: 28px;
    border-radius: 3px;
    font-size: 13px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  summary:hover {
    background: color-mix(in srgb, var(--banto-primary) 6%, transparent);
  }
  summary:focus-visible {
    outline: none;
    box-shadow: inset var(--banto-focus-ring);
  }
  .folder {
    margin: 0 5px 0 2px;
    color: var(--banto-primary);
    vertical-align: middle;
  }
  .count {
    float: right;
    padding: 1px 4px;
    color: var(--banto-text-muted);
    font-size: 11px;
  }
  .has-action > summary {
    padding-right: 30px;
  }
  .tree-wrap {
    position: relative;
  }
  .tree-action {
    position: absolute;
    top: 2px;
    right: 2px;
  }
  .branches {
    margin-left: 10px;
    padding-left: 6px;
    border-left: 1px solid var(--banto-border);
  }
</style>
