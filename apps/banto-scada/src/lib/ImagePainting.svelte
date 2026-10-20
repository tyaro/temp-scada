<script lang="ts">
  import { imageAspectRatio, type ImageFit } from "./image-fit";
  import { imageCropViewBox, type ImageCrop } from "./image-crop";
  let {
    image,
    width,
    height,
    crop,
    fit = "contain",
  }: {
    image: { url: string; width: number; height: number };
    width: number;
    height: number;
    crop?: ImageCrop;
    fit?: ImageFit;
  } = $props();
  const id = $props.id();
  const box = $derived(imageCropViewBox(image, crop));
</script>

{#if crop || fit === "cover"}
  <svg
    data-image-crop={crop ? true : undefined}
    data-image-fit={fit}
    {width}
    {height}
    viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
    preserveAspectRatio={imageAspectRatio(fit)}
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
    data-image-fit={fit}
    href={image.url}
    {width}
    {height}
    preserveAspectRatio={imageAspectRatio(fit)}
    pointer-events="none"
  />
{/if}
