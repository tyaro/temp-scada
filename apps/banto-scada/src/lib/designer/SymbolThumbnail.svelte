<script lang="ts">
  import { resolveEquipmentProperty } from "../equipment-property";
  import type { SymbolDefinition } from "../project";
  import { objectTransform } from "../rotation";
  import { compositedOpacity } from "../opacity";
  import { resolveStateColor } from "../state-color";
  import ImagePainting from "../ImagePainting.svelte";
  import Primitive from "../Primitive.svelte";
  let {
    images,
    definition,
    compact = false,
  }: {
    definition: SymbolDefinition;
    compact?: boolean;
    images?: ReadonlyMap<
      string,
      { url: string; width: number; height: number }
    >;
  } = $props();
</script>

<svg
  class:compact
  aria-hidden="true"
  viewBox={`0 0 ${definition.width} ${definition.height}`}
  preserveAspectRatio="xMidYMid meet"
>
  {#each [...definition.objects]
    .filter((object) => object.visible !== false)
    .sort((a, b) => a.order - b.order) as object (object.id)}
    <g transform={objectTransform(object)} opacity={compositedOpacity(object)}
      >{#if object.shape.type === "image" && "width" in object}
        {#if images?.get(object.shape.assetId)}<ImagePainting
            image={images.get(object.shape.assetId)!}
            width={object.width}
            height={object.height}
            crop={object.shape.crop}
            fit={object.shape.fit}
          />{/if}
      {:else}<Primitive
          {object}
          equipmentPropertyDisplay={object.shape.type === "text" &&
          object.shape.equipmentProperty
            ? resolveEquipmentProperty(
                object.shape.equipmentProperty.field,
                undefined,
                undefined,
                true,
              )
            : undefined}
          stateColor={resolveStateColor(object, definition)}
          color="var(--banto-text-muted)"
        />{/if}</g
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
  svg.compact {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
  }
</style>
