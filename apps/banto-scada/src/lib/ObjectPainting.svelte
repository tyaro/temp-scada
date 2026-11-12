<script lang="ts">
  import type { TrendDefinition } from "./trend-definitions";
  import { resolveEquipmentProperty } from "./equipment-property";
  import { resolveStateColor } from "./state-color";
  import {
    resolveSymbolSlot,
    symbolEquipmentSlot,
    type EquipmentContext,
  } from "./symbol-slots";
  import { definedSlotState } from "./slot-state";
  import { shapeSlotName } from "./shape-bindings";
  import type { ScreenObject, SymbolDefinition } from "./project";
  import type { TagReadings } from "./tag-presentation";
  import { objectTransform, readableChild } from "./rotation";
  import { compositedOpacity } from "./opacity";
  import ImagePainting from "./ImagePainting.svelte";
  import Primitive from "./Primitive.svelte";
  import TrendPainting from "./TrendPainting.svelte";
  let {
    object,
    symbols = [],
    trends = [],
    equipmentContext,
    ownerDefinition,
    images,
    readings,
    onsummary,
    onopentrend,
  }: {
    object: ScreenObject;
    symbols?: SymbolDefinition[];
    trends?: readonly TrendDefinition[];
    equipmentContext?: EquipmentContext;
    ownerDefinition?: SymbolDefinition;
    images?: ReadonlyMap<
      string,
      { url: string; width: number; height: number }
    >;
    readings?: TagReadings;
    onsummary?: (value: string) => void;
    onopentrend?: (objectId: string) => void;
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
        transform={objectTransform(readableChild(child, object))}
        opacity={compositedOpacity(child)}
        >{#if child.shape.type === "image" && "width" in child}
          {#if images?.get(child.shape.assetId)}<ImagePainting
              image={images.get(child.shape.assetId)!}
              width={child.width}
              height={child.height}
              crop={child.shape.crop}
              fit={child.shape.fit}
            />{/if}
        {:else}
          {@const slotName = shapeSlotName(child.shape)}
          {@const slotDisplay =
            slotName === undefined
              ? undefined
              : resolveSymbolSlot(
                  definition,
                  slotName,
                  object.shape.equipmentId,
                  equipmentContext,
                )}
          <Primitive
            object={child}
            equipmentPropertyDisplay={child.shape.type === "text" &&
            child.shape.equipmentProperty
              ? resolveEquipmentProperty(
                  child.shape.equipmentProperty.field,
                  object.shape.equipmentId,
                  equipmentContext,
                )
              : undefined}
            stateColor={resolveStateColor(
              child,
              definition,
              object.shape.equipmentId,
              equipmentContext,
            )}
            {slotDisplay}
            slotState={slotName === undefined ||
            !slotDisplay ||
            child.shape.type !== "text"
              ? undefined
              : definedSlotState(
                  symbolEquipmentSlot(
                    definition,
                    slotName,
                    object.shape.equipmentId,
                    equipmentContext,
                  ),
                  slotDisplay,
                )}
            color={object.shape.colorMode === "definition"
              ? undefined
              : object.fill}
          />{/if}</g
      >
    {/each}
  </svg>
{:else if "width" in object && object.shape.type === "trend"}
  <TrendPainting
    onopen={onopentrend ? () => onopentrend?.(object.id) : undefined}
    width={object.width}
    height={object.height}
    definition={trends.find(
      (row) => object.shape.type === "trend" && row.id === object.shape.trendId,
    )}
  />
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
    equipmentPropertyDisplay={ownerDefinition &&
    object.shape.type === "text" &&
    object.shape.equipmentProperty
      ? resolveEquipmentProperty(
          object.shape.equipmentProperty.field,
          undefined,
          undefined,
          true,
        )
      : undefined}
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
