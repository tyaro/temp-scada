<script lang="ts">
  // W4: 作業画面の表示中、レイヤー・部品は inert にして理由を示す（R7b で App の snippet から移した）。
  import type { Snippet } from "svelte";

  let { canvasActive, children }: { canvasActive: boolean; children: Snippet } =
    $props();
</script>

{#if !canvasActive}<p class="canvas-only-note">画面タブを選ぶと使えます</p>{/if}
<div class="canvas-only" inert={!canvasActive}>
  {@render children()}
</div>

<style>
  /* App の p の基本（行の高さ）と同じ値を当てる。 */
  .canvas-only-note {
    margin: 4px 0 8px;
    font-size: 12px;
    line-height: 1.8;
    color: var(--banto-text-muted);
  }
  .canvas-only[inert] {
    opacity: 0.55;
  }
</style>
