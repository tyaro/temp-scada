<script lang="ts">
  import { zoomLevels } from "../viewport";
  import type { CanvasView } from "./CanvasWorkspace.svelte";
  let {
    view,
    showGrid = $bindable(false),
    snapEnabled = $bindable(false),
    gridSize = $bindable(10),
    onhand,
    onzoom,
    onstep,
    placing,
    onplacing,
  }: {
    view: CanvasView;
    showGrid?: boolean;
    snapEnabled?: boolean;
    gridSize?: number;
    onhand: (hand: boolean) => void;
    onzoom: (zoom: number | null) => void;
    onstep: (direction: number) => void;
    placing: boolean;
    onplacing: () => void;
  } = $props();
</script>

<div class="group" role="group" aria-label="グリッドとスナップ">
  <label class="toggle" title="グリッド表示">
    <input aria-label="グリッド表示" type="checkbox" bind:checked={showGrid} />
    <svg aria-hidden="true" viewBox="0 0 24 24"
      ><path d="M3 3H21V21H3ZM3 9H21M3 15H21M9 3V21M15 3V21" /></svg
    >
  </label>
  <label class="toggle" title="グリッドにスナップ（Alt で一時解除）">
    <input
      aria-label="グリッドにスナップ"
      type="checkbox"
      bind:checked={snapEnabled}
    />
    <svg aria-hidden="true" viewBox="0 0 24 24"
      ><path
        d="M4 12V4H9V12A3 3 0 0 0 15 12V4H20V12A8 8 0 0 1 4 12ZM4 8H9M15 8H20"
      /></svg
    >
  </label>
  <select aria-label="グリッド間隔" title="グリッド間隔" bind:value={gridSize}>
    {#each [5, 10, 20, 50] as size}<option value={size}>{size} unit</option
      >{/each}
  </select>
</div>
<div class="group" role="group" aria-label="キャンバス表示">
  <button
    type="button"
    aria-label="選択ツール"
    title="選択ツール：空白ドラッグで範囲選択（Shiftで追加・Escで取消）"
    aria-pressed={!view.hand && !placing}
    onclick={() => onhand(false)}
    ><svg aria-hidden="true" viewBox="0 0 24 24"
      ><path d="M5 3L19 13L12 14L9 21ZM12 14L16 20" /></svg
    ></button
  >
  <button
    type="button"
    aria-label="パンツール"
    title="パンツール（Space / 中ボタンでもパン）"
    aria-pressed={view.hand}
    onclick={() => onhand(true)}
    ><svg aria-hidden="true" viewBox="0 0 24 24"
      ><path
        d="M8 12V5A2 2 0 0 1 12 5V11M12 5V4A2 2 0 0 1 16 4V12M16 7A2 2 0 0 1 20 7V15C20 20 17 22 13 22C10 22 8 20 6 17L3 12A2 2 0 0 1 6 10L8 12"
      /></svg
    ></button
  >
  <button
    type="button"
    aria-label="連続配置ツール"
    title="連続配置：部品を選び、キャンバスをクリック（Escで終了）"
    aria-pressed={placing}
    onclick={onplacing}
    ><svg aria-hidden="true" viewBox="0 0 24 24"
      ><path d="M8 3H16V11L19 15V18H5V15L8 11ZM4 21H20M11 6H13M12 5V7" /></svg
    ></button
  >
  <button
    type="button"
    aria-label="縮小"
    title="縮小"
    disabled={view.scale <= 0.25}
    onclick={() => onstep(-1)}
    ><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M5 12H19" /></svg
    ></button
  >
  <select
    aria-label="表示倍率"
    title="表示倍率"
    value={view.zoom ?? "fit"}
    onchange={(event) =>
      onzoom(
        event.currentTarget.value === "fit"
          ? null
          : Number(event.currentTarget.value),
      )}
  >
    <option value="fit">全体 ({Math.round(view.fit * 100)}%)</option>
    {#each zoomLevels as level}<option value={level}>{level * 100}%</option
      >{/each}
  </select>
  <button
    type="button"
    aria-label="拡大"
    title="拡大"
    disabled={view.scale >= 4}
    onclick={() => onstep(1)}
    ><svg aria-hidden="true" viewBox="0 0 24 24"
      ><path d="M5 12H19M12 5V19" /></svg
    ></button
  >
  <button
    type="button"
    aria-label="全体表示"
    title="全体表示"
    onclick={() => onzoom(null)}
    ><svg aria-hidden="true" viewBox="0 0 24 24"
      ><path d="M3 8V3H8M16 3H21V8M21 16V21H16M8 21H3V16M8 8H16V16H8Z" /></svg
    ></button
  >
</div>

<style>
  .group {
    display: flex;
    align-items: center;
    gap: 2px;
    padding-right: 6px;
    margin-right: 2px;
    border-right: 1px solid var(--banto-border);
  }
  button,
  .toggle {
    width: 28px;
    height: 32px;
    padding: 5px;
    display: grid;
    place-items: center;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--banto-text);
    cursor: pointer;
    flex-shrink: 0;
  }
  .toggle {
    position: relative;
  }
  .toggle input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  button:hover:not(:disabled),
  .toggle:hover {
    background: var(--banto-surface-hover);
    border-color: var(--banto-border);
  }
  button[aria-pressed="true"],
  .toggle:has(input:checked) {
    color: var(--banto-primary);
    background: var(--banto-surface-hover);
    border-color: var(--banto-primary);
  }
  button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  button:focus-visible,
  select:focus-visible,
  .toggle:has(input:focus-visible) {
    outline: none;
    box-shadow: var(--banto-focus-ring);
  }
  svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  select {
    height: 30px;
    max-width: 112px;
    padding: 3px;
    font: inherit;
    font-size: 12px;
    background: var(--banto-surface);
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    border-radius: 4px;
  }
</style>
