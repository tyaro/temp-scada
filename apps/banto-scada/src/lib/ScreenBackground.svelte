<script lang="ts">
  import type { Screen, SymbolDefinition } from "./project";
  let {
    screen,
    images,
  }: {
    screen: Screen | SymbolDefinition;
    images?: ReadonlyMap<
      string,
      { url: string; width: number; height: number }
    >;
  } = $props();
  const background = $derived(
    "background" in screen ? screen.background : "#0b1220",
  );
</script>

<rect
  data-screen-background
  width={screen.width}
  height={screen.height}
  fill={background}
  pointer-events="none"
/>
{#if "backgroundImage" in screen && screen.backgroundImage && images?.get(screen.backgroundImage.assetId)}
  <image
    data-background-image
    href={images.get(screen.backgroundImage.assetId)!.url}
    x={screen.backgroundImage.fit === "original"
      ? (screen.width - images.get(screen.backgroundImage.assetId)!.width) / 2
      : 0}
    y={screen.backgroundImage.fit === "original"
      ? (screen.height - images.get(screen.backgroundImage.assetId)!.height) / 2
      : 0}
    width={screen.backgroundImage.fit === "original"
      ? images.get(screen.backgroundImage.assetId)!.width
      : screen.width}
    height={screen.backgroundImage.fit === "original"
      ? images.get(screen.backgroundImage.assetId)!.height
      : screen.height}
    preserveAspectRatio={screen.backgroundImage.fit === "stretch"
      ? "none"
      : screen.backgroundImage.fit === "cover"
        ? "xMidYMid slice"
        : "xMidYMid meet"}
    opacity={screen.backgroundImage.opacity}
    pointer-events="none"
  />
{/if}
