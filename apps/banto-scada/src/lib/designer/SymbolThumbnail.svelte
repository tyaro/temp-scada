<script lang="ts">
  import type { SymbolDefinition } from "../project";
  import Primitive from "../Primitive.svelte";
  let { definition }: { definition: SymbolDefinition } = $props();
</script>

<svg
  aria-hidden="true"
  viewBox={`0 0 ${definition.width} ${definition.height}`}
  preserveAspectRatio="xMidYMid meet"
>
  {#each [...definition.objects].sort((a, b) => a.order - b.order) as object (object.id)}
    <g transform={`translate(${object.x} ${object.y})`}
      ><Primitive {object} color="var(--banto-text-muted)" /></g
    >
  {/each}
</svg>

<style>
  svg {
    width: 48px;
    height: 40px;
    display: block;
    pointer-events: none;
  }
</style>
