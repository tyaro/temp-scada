<script lang="ts">
  import type { EquipmentContext } from "./symbol-slots";
  import type { Screen, SymbolDefinition } from "./project";
  import type { TagReadings } from "./tag-presentation";
  import { objectTransform } from "./rotation";
  import { compositedOpacity } from "./opacity";
  import ScreenBackground from "./ScreenBackground.svelte";
  import ObjectPainting from "./ObjectPainting.svelte";
  import ScreenView from "./ScreenView.svelte";
  let {
    screen,
    screens,
    symbols,
    equipmentContext,
    images,
    readings,
  }: {
    screen: Screen;
    screens: Screen[];
    symbols: SymbolDefinition[];
    equipmentContext?: EquipmentContext;
    images?: ReadonlyMap<
      string,
      { url: string; width: number; height: number }
    >;
    readings?: TagReadings;
  } = $props();
  const clipId = $props.id();
</script>

<svg
  width="100%"
  height="100%"
  viewBox={`0 0 ${screen.width} ${screen.height}`}
  preserveAspectRatio="xMidYMid meet"
  overflow="hidden"
  pointer-events="none"
  data-screen-painting={screen.id}
>
  <defs
    ><clipPath id={clipId}
      ><rect width={screen.width} height={screen.height} /></clipPath
    ></defs
  >
  <g clip-path={`url(#${clipId})`}>
    <ScreenBackground {screen} {images} />
    {#each [...screen.objects]
      .filter((o) => o.visible !== false)
      .sort((a, b) => a.order - b.order) as object (object.id)}
      <g
        data-projected-object-id={object.id}
        transform={objectTransform(object)}
        opacity={compositedOpacity(object)}
      >
        {#if "width" in object && object.shape.type === "screenView"}
          {@const source = screens.find(
            (s) =>
              object.shape.type === "screenView" &&
              s.id === object.shape.screenId,
          )}
          {#if source}<ScreenView
              {source}
              width={object.width}
              height={object.height}
              {symbols}
              {images}
              {readings}
              {equipmentContext}
            />{/if}
        {:else}<ObjectPainting
            {object}
            {symbols}
            {images}
            {readings}
            {equipmentContext}
          />{/if}
      </g>
    {/each}
  </g>
</svg>
