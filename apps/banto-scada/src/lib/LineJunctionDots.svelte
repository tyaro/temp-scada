<script lang="ts">
  import type { LineJunction } from "./line-junction";
  let { junctions }: { junctions: readonly LineJunction[] | undefined } =
    $props();
</script>

<!-- 分岐の点は選択・hit・外接矩形に含めない（描画だけ）。同じ座標の点もあり得るので座標をキーにしない。 -->
{#each junctions ?? [] as junction}<circle
    data-line-junction={junction.afterId}
    cx={junction.x}
    cy={junction.y}
    r={junction.diameter / 2}
    fill={junction.color}
    opacity={junction.opacity}
    pointer-events="none"
  />{/each}
