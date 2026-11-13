<script lang="ts">
  // 画面切替ボタンの描画。仕様: docs/design/graphics/nav-button.md
  import type { NavButtonShape } from "./project";
  import { navButtonColors } from "./nav-button";
  import { TEXT_FONT } from "./text-layout";
  let {
    shape,
    width,
    height,
    current = false,
    disabled = false,
  }: {
    shape: NavButtonShape;
    width: number;
    height: number;
    /** 行き先が表示中の画面のとき、現在の画面の色で描く。 */
    current?: boolean;
    /** プレビューで押せないボタン（未設定・戻る・進む）は薄く描く。 */
    disabled?: boolean;
  } = $props();
  const colors = $derived(navButtonColors(shape, current));
  const radius = $derived(Math.min(6, width / 4, height / 4));
</script>

<g
  data-nav-button
  data-nav-current={current ? "true" : undefined}
  data-nav-disabled={disabled ? "true" : undefined}
  opacity={disabled ? 0.45 : undefined}
>
  <rect
    data-nav-fill
    {width}
    {height}
    rx={radius}
    ry={radius}
    fill={colors.fill}
  />
  {#if shape.label}<text
      data-nav-label
      x={width / 2}
      y={height / 2}
      dominant-baseline="central"
      text-anchor="middle"
      font-family={TEXT_FONT}
      font-size={shape.fontSize}
      fill={colors.textColor}>{shape.label}</text
    >{/if}
</g>
