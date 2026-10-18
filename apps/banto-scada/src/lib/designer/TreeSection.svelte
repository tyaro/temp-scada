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
    margin: 2px 0 6px;
  }
  summary {
    cursor: pointer;
    padding: 8px 4px;
    min-height: 36px;
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
    margin: 0 7px 0 2px;
    color: var(--banto-primary);
    vertical-align: middle;
  }
  .count {
    float: right;
    padding: 1px 4px;
    color: var(--banto-text-muted);
    font-size: 11px;
  }
  .branches {
    margin-left: 12px;
    padding-left: 8px;
    border-left: 1px solid var(--banto-border);
  }
</style>
