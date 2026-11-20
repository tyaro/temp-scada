<script lang="ts">
  // 左ペインの「部品」タブの中身。配置とお気に入りの状態は App が持つ（R7b）。
  import type { ComponentProps } from "svelte";
  import CanvasOnlyArea from "./CanvasOnlyArea.svelte";
  import PartPalette from "./PartPalette.svelte";

  type PaletteProps = ComponentProps<typeof PartPalette>;
  let {
    editing,
    canvasActive,
    images,
    definitions,
    allowSymbols,
    hasAlarmDefinitions,
    contextKey,
    positionPlacement,
    isFavorite,
    isArmed,
    onarm,
    onimmediate,
    ontoggleFavorite,
    onedit,
    onduplicate,
    onadd,
    onstartdrag,
    onenddrag,
    onbuiltin,
    onplace,
  }: {
    /** `mode === "edit"` */
    editing: boolean;
    canvasActive: boolean;
    images: PaletteProps["images"];
    definitions: PaletteProps["definitions"];
    allowSymbols: boolean;
    hasAlarmDefinitions: boolean;
    contextKey: string;
    positionPlacement: boolean;
    isFavorite: PaletteProps["isFavorite"];
    isArmed: PaletteProps["isArmed"];
    onarm: PaletteProps["onarm"];
    onimmediate: PaletteProps["onimmediate"];
    ontoggleFavorite: PaletteProps["ontoggleFavorite"];
    onedit: PaletteProps["onedit"];
    onduplicate: PaletteProps["onduplicate"];
    onadd: PaletteProps["onadd"];
    onstartdrag: PaletteProps["onstartdrag"];
    onenddrag: PaletteProps["onenddrag"];
    onbuiltin: PaletteProps["onbuiltin"];
    onplace: PaletteProps["onplace"];
  } = $props();
</script>

{#if editing}
  <CanvasOnlyArea {canvasActive}>
    <PartPalette
      {images}
      {isFavorite}
      {positionPlacement}
      {isArmed}
      {onarm}
      {onimmediate}
      {ontoggleFavorite}
      {contextKey}
      {onedit}
      {onduplicate}
      {definitions}
      {allowSymbols}
      {hasAlarmDefinitions}
      {onadd}
      {onstartdrag}
      {onenddrag}
      {onbuiltin}
      {onplace}
    />
  </CanvasOnlyArea>
{/if}
