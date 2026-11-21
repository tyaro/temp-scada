<script lang="ts">
  // 連続配置中の帯。状態と終了の処理は App が持つ（R7c）。
  let {
    armedLabel,
    drawing = false,
    onstop,
  }: {
    /** 選択中の部品名。未選択なら null */
    armedLabel: string | null;
    /** 線・配管をクリックで頂点を足して描く（#306 E4）。 */
    drawing?: boolean;
    onstop: () => void;
  } = $props();
</script>

<div class="placement-bar" role="status" aria-label="連続配置の状態">
  <span
    >{armedLabel !== null && drawing
      ? `${armedLabel}を描く · クリックで頂点を追加、接続先の近くで吸着／ダブルクリック・Enterで確定、Backspaceで1点戻す、Escで取消`
      : armedLabel !== null
        ? `${armedLabel}を連続配置 · キャンバスをクリック／Enterで中央へ配置`
        : "連続配置 · 部品を選んでください"}</span
  >
  <button onclick={onstop}>配置を終了 <kbd>Esc</kbd></button>
</div>

<style>
  /* App の要素向けの基本（button）と同じ値を当てる。 */
  button {
    display: block;
    text-align: left;
    border: 1px solid var(--banto-border);
    background: var(--banto-surface);
    color: var(--banto-text);
    border-radius: 6px;
    font: inherit;
    cursor: pointer;
  }
  button:hover {
    border-color: var(--banto-primary);
  }
  button:focus-visible {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  .placement-bar {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    padding: 4px 12px;
    color: var(--banto-text);
    background: var(--studio-selection);
    font-size: 12px;
    flex-shrink: 0;
  }
  .placement-bar span {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .placement-bar button {
    width: auto;
    margin: 0;
    padding: 3px 7px;
    font-size: 11px;
    background: transparent;
    border: 0;
  }
  .placement-bar kbd {
    margin-left: 4px;
    color: var(--banto-text-muted);
  }
</style>
