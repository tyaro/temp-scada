<script lang="ts">
  import ImagePainting from "./ImagePainting.svelte";
  import { imageCropViewBox } from "./image-crop";
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
  {@const source = images.get(screen.backgroundImage.assetId)!}
  {#if screen.backgroundImage.crop}
    {@const cropBox = imageCropViewBox(source, screen.backgroundImage.crop)}
    {@const original = screen.backgroundImage.fit === "original"}
    <g
      data-background-image
      data-background-crop
      transform={original
        ? `translate(${(screen.width - cropBox.width) / 2} ${(screen.height - cropBox.height) / 2})`
        : undefined}
      opacity={screen.backgroundImage.opacity}
      pointer-events="none"
    >
      <ImagePainting
        image={source}
        width={original ? cropBox.width : screen.width}
        height={original ? cropBox.height : screen.height}
        crop={screen.backgroundImage.crop}
        fit={screen.backgroundImage.fit === "original"
          ? "contain"
          : screen.backgroundImage.fit}
      />
    </g>
  {:else}
    <image
      data-background-image
      href={images.get(screen.backgroundImage.assetId)!.url}
      x={screen.backgroundImage.fit === "original"
        ? (screen.width - images.get(screen.backgroundImage.assetId)!.width) / 2
        : 0}
      y={screen.backgroundImage.fit === "original"
        ? (screen.height - images.get(screen.backgroundImage.assetId)!.height) /
          2
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
{/if}
