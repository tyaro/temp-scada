<script lang="ts">
  import type { TrendDefinition } from "./trend-definitions";
  import type { EquipmentContext } from "./symbol-slots";
  import type { Screen, SymbolDefinition } from "./project";
  import type { TagReadings } from "./tag-presentation";
  import { objectTransform } from "./rotation";
  import { compositedOpacity } from "./opacity";
  import ScreenBackground from "./ScreenBackground.svelte";
  import ObjectPainting from "./ObjectPainting.svelte";
  import LineJunctionDots from "./LineJunctionDots.svelte";
  import { screenJunctions } from "./line-junction";
  import { screenHopPaths } from "./line-hop";
  let {
    source,
    width,
    height,
    symbols,
    trends = [],
    equipmentContext,
    images,
    readings,
  }: {
    source: Screen;
    width: number;
    height: number;
    symbols: SymbolDefinition[];
    trends?: readonly TrendDefinition[];
    equipmentContext?: EquipmentContext;
    images?: ReadonlyMap<
      string,
      { url: string; width: number; height: number }
    >;
    readings?: TagReadings;
  } = $props();
  const clipId = $props.id();
  const junctions = $derived(screenJunctions(source.objects));
  const hops = $derived(
    screenHopPaths(source.objects, source.lineHops === true),
  );
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
          hopPath={hops.get(child.id)}
          {symbols}
          {images}
          {readings}
          {equipmentContext}
          {trends}
        />
      </g>
      <LineJunctionDots junctions={junctions.get(child.id)} />
    {/each}
  </g>
</svg>
