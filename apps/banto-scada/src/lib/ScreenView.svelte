<script lang="ts">
  import type { EquipmentContext } from "./symbol-slots";
  import type { Screen, SymbolDefinition } from "./project";
  import type { TagReadings } from "./tag-presentation";
  import { objectTransform } from "./rotation";
  import { compositedOpacity } from "./opacity";
  import ScreenBackground from "./ScreenBackground.svelte";
  import ObjectPainting from "./ObjectPainting.svelte";
  let {
    source,
    width,
    height,
    symbols,
    equipmentContext,
    images,
    readings,
  }: {
    source: Screen;
    width: number;
    height: number;
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
  {width}
  {height}
  viewBox={`0 0 ${source.width} ${source.height}`}
  preserveAspectRatio="xMidYMid meet"
  overflow="hidden"
  pointer-events="none"
  data-screen-view={source.id}
>
  <defs
    ><clipPath id={clipId}
      ><rect width={source.width} height={source.height} /></clipPath
    ></defs
  >
  <g clip-path={`url(#${clipId})`}>
    <ScreenBackground screen={source} {images} />
    {#each [...source.objects]
      .filter((o) => o.visible !== false)
      .sort((a, b) => a.order - b.order) as child (child.id)}
      <g
        data-source-object-id={child.id}
        transform={objectTransform(child)}
        opacity={compositedOpacity(child)}
      >
        <ObjectPainting
          object={child}
          {symbols}
          {images}
          {readings}
          {equipmentContext}
        />
      </g>
    {/each}
  </g>
</svg>
