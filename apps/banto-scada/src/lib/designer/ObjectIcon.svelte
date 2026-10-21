<script lang="ts">
  import SymbolThumbnail from "./SymbolThumbnail.svelte";
  import type { ScreenObject, SymbolDefinition } from "../project";
  let {
    images,
    object,
    definition,
  }: {
    object: ScreenObject;
    images?: ReadonlyMap<
      string,
      { url: string; width: number; height: number }
    >;
    definition?: SymbolDefinition;
  } = $props();
</script>

{#if definition}<SymbolThumbnail {images} {definition} compact />{:else}
  <svg
    aria-hidden="true"
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
  >
    {#if object.shape.type === "rectangle"}<rect
        x="3"
        y="5"
        width="18"
        height="14"
        rx="1"
      />
    {:else if object.shape.type === "ellipse"}<ellipse
        cx="12"
        cy="12"
        rx="9"
        ry="7"
      />
    {:else if object.shape.type === "screenView"}<rect
        x="2"
        y="3"
        width="20"
        height="15"
        rx="1"
      /><path d="M8 22h8M12 18v4M5 7h8v7H5zM16 7h3M16 11h3" />
    {:else if object.shape.type === "image"}<rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="1"
      /><circle cx="8" cy="9" r="2" /><path d="M3 18l6-6 4 4 3-5 5 7" />
    {:else if object.shape.type === "text"}<path
        d="M4 5h16M12 5v15M8 20h8M4 5v3M20 5v3"
      />
    {:else if object.shape.type === "polyline"}<path
        d="M3 19h7V6h11M17 2l4 4-4 4"
      />
    {:else}<rect x="3" y="3" width="7" height="7" rx="1" /><rect
        x="14"
        y="3"
        width="7"
        height="7"
        rx="1"
      /><rect x="3" y="14" width="7" height="7" rx="1" /><rect
        x="14"
        y="14"
        width="7"
        height="7"
        rx="1"
      />{/if}
  </svg>
{/if}

<style>
  svg {
    flex-shrink: 0;
    color: var(--banto-text-muted);
  }
</style>
