<script lang="ts">
  import { imageCropViewBox, type ImageCrop } from "./image-crop";
  let {
    image,
    width,
    height,
    crop,
  }: {
    image: { url: string; width: number; height: number };
    width: number;
    height: number;
    crop?: ImageCrop;
  } = $props();
  const id = $props.id();
  const box = $derived(imageCropViewBox(image, crop));
</script>

{#if crop}
  <svg
    data-image-crop
    {width}
    {height}
    viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
    preserveAspectRatio="xMidYMid meet"
    overflow="hidden"
    pointer-events="none"
  >
    <defs
      ><clipPath {id} clipPathUnits="userSpaceOnUse"><rect {...box} /></clipPath
      ></defs
    >
    <g clip-path={`url(#${id})`}>
      <image
        data-image-frame
        href={image.url}
        width={image.width}
        height={image.height}
        preserveAspectRatio="none"
      />
    </g>
  </svg>
{:else}
  <image
    data-image-frame
    href={image.url}
    {width}
    {height}
    preserveAspectRatio="xMidYMid meet"
    pointer-events="none"
  />
{/if}
