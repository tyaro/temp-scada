<script lang="ts">
  // 左ペインの「レイヤー」タブの中身。ツリーの操作は App の layer-tree controller が持つ（R7b）。
  import type { ComponentProps } from "svelte";
  import CanvasOnlyArea from "./CanvasOnlyArea.svelte";
  import LayerTree from "./LayerTree.svelte";

  type TreeProps = ComponentProps<typeof LayerTree>;
  let {
    editing,
    canvasActive,
    images,
    tree,
  }: {
    /** `mode === "edit"` */
    editing: boolean;
    canvasActive: boolean;
    images: TreeProps["images"];
    tree: TreeProps["tree"];
  } = $props();
</script>

{#if editing}
  <CanvasOnlyArea {canvasActive}>
    <LayerTree {images} {tree} />
  </CanvasOnlyArea>
{/if}
