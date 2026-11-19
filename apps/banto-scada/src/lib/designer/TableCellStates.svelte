<script lang="ts">
  import type { TableShape } from "../project";
  import { clearTableGridCell } from "../table";
  import BoolDisplayFields from "./BoolDisplayFields.svelte";
  import {
    TABLE_CELL_STATES_FIELD,
    readTableCellStateDraft,
    tableCellStateCandidates,
    tableCellStateField,
  } from "./forms/table-cell-states";
  // Issue #303 第2段: 表のフォーム（data-editor-form="object"）の中に置く。
  // 全セルの値は hidden の入力 1 つ（JSON）に持ち、下書き（drafts.track）は
  // それを保つ。実の欄は選んだセルの分だけ作り、囲むフォームには属させない
  // （存在しないフォームの form 属性）。欄の変更で JSON を書き換えて input を
  // 出し、JSON が外から変わったら（適用・取り消し・別の配置）欄へ写す。
  let { shape, definition }: { shape: TableShape; definition: boolean } =
    $props();
  const DETACHED = "table-cell-state-picker";
  const candidates = $derived(tableCellStateCandidates(shape, definition));
  let picked = $state("");
  const key = (cell: { row: number; column: number }) =>
    `${cell.row}:${cell.column}`;
  const current = $derived(
    candidates.find((cell) => key(cell) === picked) ?? candidates[0],
  );
  let store = $state<HTMLInputElement>();
  let editor = $state<HTMLDivElement>();
  let draft = $state.raw<Record<string, string>>({});

  function load() {
    if (store) draft = readTableCellStateDraft(store.value);
  }
  // hidden の入力の value は value 属性を映すので、drafts の書き込み（update・
  // restore）を属性の変化で拾う。
  $effect(() => {
    if (!store) return;
    load();
    const observer = new MutationObserver(load);
    observer.observe(store, { attributes: true, attributeFilter: ["value"] });
    return () => observer.disconnect();
  });
  // 下書きを見える欄へ写す（選んだセルが変わったときも）。
  $effect(() => {
    const values = draft;
    void current;
    if (!editor) return;
    for (const control of editor.querySelectorAll<
      HTMLInputElement | HTMLSelectElement
    >("input[name], select[name]")) {
      const value = values[control.name];
      if (value !== undefined && control.value !== value) control.value = value;
    }
  });

  /** 見える欄の変更を JSON へ書き、フォームの下書きへ知らせる。 */
  function edit(event: Event) {
    const control = event.target;
    if (
      !store ||
      !(
        control instanceof HTMLInputElement ||
        control instanceof HTMLSelectElement
      ) ||
      !(control.name in draft) ||
      draft[control.name] === control.value
    )
      return;
    draft = { ...draft, [control.name]: control.value };
    store.value = JSON.stringify(draft);
    store.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** bool の表示を使うにしたら、同じセルの書式を下書きから消す（同時に持てない）。 */
  function clearFormat(
    event: Event & { currentTarget: HTMLSelectElement },
    row: number,
    column: number,
  ) {
    if (event.currentTarget.value !== "enabled") return;
    const area = store?.form?.elements.namedItem("tableFormats");
    if (!(area instanceof HTMLTextAreaElement)) return;
    const next = clearTableGridCell(area.value, row, column);
    if (next === area.value) return;
    area.value = next;
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }
</script>

<input type="hidden" name={TABLE_CELL_STATES_FIELD} bind:this={store} />
{#if current}
  <section class="cell-states" aria-label="セルの状態表示">
    <h3>セルの状態表示</h3>
    <label class="banto-field banto-field--stacked"
      ><span class="banto-field-label">セル</span
      ><!-- 選択はフォームの値ではない（下書きにしない）ので、存在しないフォームに属させる。 --><select
        class="banto-field-control"
        form={DETACHED}
        aria-label="状態表示のセル"
        value={key(current)}
        onchange={(event) => (picked = event.currentTarget.value)}
      >
        {#each candidates as cell (key(cell))}
          <option value={key(cell)}>{cell.label}</option>
        {/each}
      </select></label
    >
    <div
      class="cell"
      bind:this={editor}
      data-table-cell-state-editor={key(current)}
      oninput={edit}
      onchange={edit}
    >
      {#if !definition}
        <BoolDisplayFields
          form={DETACHED}
          name={(field) =>
            tableCellStateField(current.row, current.column, field)}
          onmodechange={(event) =>
            clearFormat(event, current.row, current.column)}
        />
      {/if}
      <label class="banto-field banto-field--stacked target"
        ><span class="banto-field-label">状態の色の使い先</span><select
          class="banto-field-control"
          form={DETACHED}
          name={tableCellStateField(current.row, current.column, "stateTarget")}
          aria-label="状態の色の使い先"
          ><option value="text">文字</option><option value="fill">塗り</option
          ></select
        ></label
      >
    </div>
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
