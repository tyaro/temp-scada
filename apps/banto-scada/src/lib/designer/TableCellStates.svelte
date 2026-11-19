<script lang="ts">
  import type { TableShape } from "../project";
  import { clearTableGridCell } from "../table";
  import BoolDisplayFields from "./BoolDisplayFields.svelte";
  import {
    tableCellStateCandidates,
    tableCellStateField,
  } from "./forms/table-cell-states";
  // Issue #303 第2段: 表のフォーム（data-editor-form="object"）の中に置く。
  // 選べるセルごとに名前を分けた欄を置き、選んだセルの欄だけを見せる。
  // 値の出し入れは表のフォームの下書き（drafts.track）に任せる。
  let { shape, definition }: { shape: TableShape; definition: boolean } =
    $props();
  const candidates = $derived(tableCellStateCandidates(shape, definition));
  let picked = $state("");
  const key = (cell: { row: number; column: number }) =>
    `${cell.row}:${cell.column}`;
  const current = $derived(
    candidates.find((cell) => key(cell) === picked) ?? candidates[0],
  );

  /** bool の表示を使うにしたら、同じセルの書式を下書きから消す（同時に持てない）。 */
  function clearFormat(
    event: Event & { currentTarget: HTMLSelectElement },
    row: number,
    column: number,
  ) {
    const select = event.currentTarget;
    if (select.value !== "enabled") return;
    const area = select.form?.elements.namedItem("tableFormats");
    if (!(area instanceof HTMLTextAreaElement)) return;
    const next = clearTableGridCell(area.value, row, column);
    if (next === area.value) return;
    area.value = next;
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }
</script>

{#if current}
  <section class="cell-states" aria-label="セルの状態表示">
    <h3>セルの状態表示</h3>
    <label class="banto-field banto-field--stacked"
      ><span class="banto-field-label">セル</span
      ><!-- 選択はフォームの値ではない（下書きにしない）ので、存在しないフォームに属させる。 --><select
        class="banto-field-control"
        form="table-cell-state-picker"
        aria-label="状態表示のセル"
        value={key(current)}
        onchange={(event) => (picked = event.currentTarget.value)}
      >
        {#each candidates as cell (key(cell))}
          <option value={key(cell)}>{cell.label}</option>
        {/each}
      </select></label
    >
    {#each candidates as cell (key(cell))}
      <div
        class="cell"
        hidden={key(cell) !== key(current)}
        data-table-cell-state-editor={key(cell)}
      >
        {#if !definition}
          <BoolDisplayFields
            name={(field) => tableCellStateField(cell.row, cell.column, field)}
            onmodechange={(event) => clearFormat(event, cell.row, cell.column)}
          />
        {/if}
        <label class="banto-field banto-field--stacked target"
          ><span class="banto-field-label">状態の色の使い先</span><select
            class="banto-field-control"
            name={tableCellStateField(cell.row, cell.column, "stateTarget")}
            aria-label="状態の色の使い先"
            ><option value="text">文字</option><option value="fill">塗り</option
            ></select
          ></label
        >
      </div>
    {/each}
    <p>
      {#if definition}
        状態の色の使い先は、セルの取得不能の色を書いたセルでだけ効きます（ないセルでは適用で外します）。
      {:else}
        bool
        の表示を使うにすると、そのセルの書式を消します（同時に持てません）。状態の色の使い先は
        bool の表示を使うセルでだけ効きます。セルのタグを外すと、同じ適用で bool
        の表示も外します。
      {/if}
      「変更を適用」でほかの欄と一緒に確定します。
    </p>
  </section>
{/if}

<style>
  .cell-states {
    display: grid;
    gap: 8px;
  }
  h3 {
    font-size: 13px;
    font-weight: 600;
    margin: 0;
  }
  .target {
    margin-top: 8px;
  }
  p {
    margin: 0;
    color: var(--banto-text-muted);
    font-size: 12px;
    line-height: 1.6;
  }
</style>
