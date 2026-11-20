<script lang="ts">
  // Symbol 定義の編集中に中央の先頭へ出す帯。状態と「画面へ戻る」の処理は App が持ち、ここは値と callback で描く（R7c）。
  let {
    usageCount,
    strokeOverflow,
    onreturn,
  }: {
    /** 定義を共有している配置の数 */
    usageCount: number;
    /** 枠線が表示領域外へ出ている図形の件数 */
    strokeOverflow: number;
    onreturn: () => void;
  } = $props();
</script>

<div class="definition-banner" role="note">
  <div class="definition-banner-row">
    <strong>Symbol 定義を編集中 · {usageCount} 配置で共有</strong>
    <details class="definition-banner-help">
      <summary>説明</summary>
      <p>
        確定した形状は全画面の参照配置へ反映されます。図形ごとの配色は「共有定義の色」の配置へ反映し、「配置の単色」は配置色を維持します。slotの状態の色に従うTextは両方の配置で状態の色を優先します。別の形にする場合は定義を複製してください。
      </p>
    </details>
    <button onclick={onreturn}>画面へ戻る</button>
  </div>
  {#if strokeOverflow > 0}<p role="status">
      枠線が表示領域外へ出ている図形が{strokeOverflow}件あります。配置では領域外が切れます。図形の位置・寸法または定義の表示領域を変更してください。
    </p>{/if}
</div>

<style>
  /* App の要素向けの基本（p・button）と、section p の折返しを同じ値で当てる。 */
  p {
    font-size: 13px;
    line-height: 1.8;
    color: var(--banto-text-muted);
    overflow-wrap: anywhere;
  }
  button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 9px 10px;
    margin: 8px 0;
    border: 1px solid var(--banto-border);
    background: var(--banto-surface);
    color: var(--banto-text);
    border-radius: 6px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  button:hover {
    border-color: var(--banto-primary);
  }
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  /* App の `main > section > :not(.canvas-stack)` の flex-shrink 指定は子の根に届かないため、ここで持つ。 */
  .definition-banner {
    flex-shrink: 0;
    border: 1px solid var(--banto-primary);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 16px;
    background: var(--banto-surface);
  }
  .definition-banner button {
    width: auto;
    margin-bottom: 0;
  }
  /* UX精査 P1-3: 図面の高さを取らないよう、見出しと「画面へ戻る」を1行にし説明は畳む。 */
  .definition-banner-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .definition-banner-row > strong {
    flex: 1;
    min-width: 0;
  }
  .definition-banner-row > button {
    padding: 3px 12px;
    min-height: 0;
  }
  .definition-banner-help > summary {
    cursor: pointer;
    color: var(--banto-text-muted);
    white-space: nowrap;
  }
  .definition-banner-help[open] {
    flex-basis: 100%;
    order: 3;
  }
  .definition-banner-help > p,
  .definition-banner > p {
    margin: 6px 0 0;
  }
</style>
