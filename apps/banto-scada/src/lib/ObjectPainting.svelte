<script lang="ts">
  import { resolveStateColor } from "./state-color";
  import { resolveSymbolSlot, type EquipmentContext } from "./symbol-slots";
  import type { ScreenObject, SymbolDefinition } from "./project";
  import type { TagReadings } from "./tag-presentation";
  import { objectTransform } from "./rotation";
  import { compositedOpacity } from "./opacity";
  import ImagePainting from "./ImagePainting.svelte";
  import Primitive from "./Primitive.svelte";
  let {
    object,
    symbols = [],
    equipmentContext,
    ownerDefinition,
    images,
    readings,
    onsummary,
  }: {
    object: ScreenObject;
    symbols?: SymbolDefinition[];
    equipmentContext?: EquipmentContext;
    ownerDefinition?: SymbolDefinition;
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
      <g
        data-symbol-child-id={child.id}
        transform={objectTransform(child)}
        opacity={compositedOpacity(child)}
        ><Primitive
          object={child}
          stateColor={resolveStateColor(
            child,
            definition,
            object.shape.equipmentId,
            equipmentContext,
          )}
          slotDisplay={child.shape.type === "text" && child.shape.slotBinding
            ? resolveSymbolSlot(
                definition,
                child.shape.slotBinding.slotName,
                object.shape.equipmentId,
                equipmentContext,
              )
            : undefined}
          color={object.shape.colorMode === "definition"
            ? undefined
            : object.fill}
        /></g
      >
    {/each}
  </svg>
{:else if "width" in object && object.shape.type === "image"}
  {#if images?.get(object.shape.assetId)}
    <ImagePainting
      image={images.get(object.shape.assetId)!}
      width={object.width}
      height={object.height}
      crop={object.shape.crop}
      fit={object.shape.fit}
    />
  {/if}
{:else}<Primitive
    {object}
    {readings}
    {onsummary}
    stateColor={ownerDefinition
      ? resolveStateColor(object, ownerDefinition)
      : undefined}
  />{/if}

<style>
  svg {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
