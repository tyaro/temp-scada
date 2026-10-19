<script lang="ts">
  import type { ScreenObject, SymbolDefinition } from "./project";
  import type { TagReadings } from "./tag-presentation";
  import { objectTransform } from "./rotation";
  import { compositedOpacity } from "./opacity";
  import Primitive from "./Primitive.svelte";
  let {
    object,
    symbols = [],
    images,
    readings,
    onsummary,
  }: {
    object: ScreenObject;
    symbols?: SymbolDefinition[];
    images?: ReadonlyMap<
      string,
      { url: string; width: number; height: number }
    >;
    readings?: TagReadings;
    onsummary?: (value: string) => void;
  } = $props();
</script>

{#if "width" in object && object.shape.type === "symbol"}
  {@const definition = symbols.find(
    (s) => object.shape.type === "symbol" && s.id === object.shape.symbolId,
  )!}
  <svg
    width={object.width}
    height={object.height}
    viewBox={`0 0 ${definition.width} ${definition.height}`}
    preserveAspectRatio="xMidYMid meet"
    data-symbol-id={definition.id}
    data-symbol-color-mode={object.shape.colorMode}
  >
    {#each [...definition.objects]
      .filter((object) => object.visible !== false)
      .sort((a, b) => a.order - b.order) as child (child.id)}
      <g transform={objectTransform(child)} opacity={compositedOpacity(child)}
        ><Primitive
          object={child}
          color={object.shape.colorMode === "definition"
            ? undefined
            : object.fill}
        /></g
      >
    {/each}
  </svg>
{:else if "width" in object && object.shape.type === "image"}
  {#if images?.get(object.shape.assetId)}
    <image
      data-image-frame
      href={images.get(object.shape.assetId)!.url}
      width={object.width}
      height={object.height}
      preserveAspectRatio="xMidYMid meet"
      pointer-events="none"
    />
  {/if}
{:else}<Primitive {object} {readings} {onsummary} />{/if}

<style>
  svg {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
