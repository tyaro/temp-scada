<script lang="ts">
  import type { Snippet } from "svelte";
  let {
    label,
    count,
    children,
    open = $bindable(true),
  }: {
    label: string;
    count?: number;
    children: Snippet;
    open?: boolean;
  } = $props();
</script>

<details bind:open class="tree-section">
  <summary
    ><svg
      class="folder"
      aria-hidden="true"
      width="19"
      height="19"
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

<style>
  .tree-section {
    margin: 4px 0 10px;
  }
  summary {
    cursor: pointer;
    padding: 8px 4px;
    border-radius: 5px;
    font-size: 13px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  summary:hover {
    background: var(--banto-surface);
  }
  summary:focus-visible {
    outline: none;
    box-shadow: inset var(--banto-focus-ring);
  }
  .folder {
    margin: 0 7px 0 2px;
    color: var(--banto-primary);
    vertical-align: middle;
  }
  .count {
    float: right;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--banto-surface);
    color: var(--banto-text-muted);
    font-size: 11px;
  }
  .branches {
    margin-left: 8px;
    padding-left: 10px;
    border-left: 1px solid var(--banto-border);
  }
</style>
