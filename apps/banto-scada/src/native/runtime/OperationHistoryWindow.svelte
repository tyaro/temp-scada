<script lang="ts">
  import { untrack } from "svelte";
  import { Modal } from "@banto/ui";
  import type { Project } from "../../lib/project";
  import { ipcErrorText } from "../../lib/operation-faceplate";
  import {
    HISTORY_OUTCOMES,
    operationHistoryLine,
    operationHistoryQuery,
    type HistoryOutcome,
    type OperationHistoryFilter,
    type OperationHistoryHost,
    type OperationHistoryRow,
  } from "../../lib/operation-history";

  /**
   * 操作履歴の窓（段階3の運転操作 設計 §9 の照会、O4b）。読むだけ。行は host が
   * 適用中の Project の実行記録から新しい順に返す。開くたびに今の絞り込みで
   * 読み直し、「さらに読む」は最後に照会した条件の続きを読む。
   */
  let {
    open,
    host,
    project,
    onclose,
    focusFallback,
  }: {
    open: boolean;
    host: OperationHistoryHost;
    project: Project;
    onclose: () => void;
    focusFallback?: () => HTMLElement | null | undefined;
  } = $props();

  let from = $state(""),
    to = $state(""),
    equipmentId = $state("");
  let outcomes = $state<HistoryOutcome[]>(
    HISTORY_OUTCOMES.map(([outcome]) => outcome),
  );
  let rows = $state.raw<OperationHistoryRow[]>([]);
  let nextBeforeSeq = $state<number | null>(null);
  let loaded = $state(false);
  let busy = $state(false);
  let issue = $state<string | null>(null);
  /** 表示中の行を取った条件。「さらに読む」はこれを使う。 */
  let submitted: OperationHistoryFilter | null = null;
  /** 照会の番号。古い照会の応答は採らない（閉じる・照会し直す）。 */
  let generation = 0;

  const equipment = $derived(project.equipment ?? []);
  const lines = $derived(rows.map((row) => operationHistoryLine(row, project)));

  // 開くたびに今の絞り込みで読み直す（記録は窓の外の書込みで増える）。
  $effect(() => {
    if (!open) {
      generation += 1;
      busy = false;
      return;
    }
    untrack(() => void load(false));
  });

  async function load(more: boolean) {
    const filter: OperationHistoryFilter =
      more && submitted ? submitted : { from, to, equipmentId, outcomes };
    const built = operationHistoryQuery(filter, more ? nextBeforeSeq : null);
    if ("issue" in built) {
      issue = built.issue;
      return;
    }
    const mine = ++generation;
    busy = true;
    issue = null;
    try {
      const answer = await host.history(built.query);
      if (mine !== generation) return;
      rows = more ? [...rows, ...answer.rows] : answer.rows;
      nextBeforeSeq = answer.nextBeforeSeq;
      submitted = { ...filter, outcomes: [...filter.outcomes] };
      loaded = true;
    } catch (error) {
      if (mine === generation)
        issue = `操作履歴を読めません: ${ipcErrorText(error)}`;
    } finally {
      if (mine === generation) busy = false;
    }
  }

  function toggle(outcome: HistoryOutcome, checked: boolean) {
    outcomes = checked
      ? [...outcomes, outcome]
      : outcomes.filter((item) => item !== outcome);
  }
</script>

<Modal {open} title="操作履歴" width="1200px" {onclose} {focusFallback}>
  <div class="operation-history" data-operation-history>
    <form
      class="toolbar"
      onsubmit={(event) => {
        event.preventDefault();
        void load(false);
      }}
    >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">開始（ローカル時刻）</span><input
          class="banto-field-control"
          type="datetime-local"
          step="1"
          bind:value={from}
          data-operation-history-from
        /></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">終了（ローカル時刻）</span><input
          class="banto-field-control"
          type="datetime-local"
          step="1"
          bind:value={to}
          data-operation-history-to
        /></label
      >
      <label class="banto-field banto-field--stacked"
        ><span class="banto-field-label">機器</span><select
          class="banto-field-control"
          bind:value={equipmentId}
          data-operation-history-equipment
          ><option value="">すべて</option
          >{#each equipment as item (item.id)}<option value={item.id}
              >{item.code} {item.name}</option
            >{/each}</select
        ></label
      >
      <fieldset class="outcomes">
        <legend>区分</legend>
        {#each HISTORY_OUTCOMES as [outcome, text] (outcome)}
          <label
            ><input
              type="checkbox"
              checked={outcomes.includes(outcome)}
              onchange={(event) => toggle(outcome, event.currentTarget.checked)}
              data-operation-history-outcome={outcome}
            />{text}</label
          >
        {/each}
      </fieldset>
      <button type="submit" disabled={busy}>照会</button>
    </form>
    {#if issue}<p class="notice" role="alert">{issue}</p>{/if}
    <div class="table-wrap">
      <table aria-label="操作履歴">
        <thead>
          <tr>
            <th scope="col">受付時刻</th>
            <th scope="col">利用者</th>
            <th scope="col">機器</th>
            <th scope="col">操作</th>
            <th scope="col">書こうとした値</th>
            <th scope="col">区分</th>
            <th scope="col">理由</th>
            <th scope="col">回数</th>
            <th scope="col">所要時間</th>
            <th scope="col">監査 id</th>
          </tr>
        </thead>
        <tbody>
          {#each lines as line (line.seq)}
            <tr data-operation-history-row={line.seq}>
              <td>{line.time}</td>
              <td>{line.user}</td>
              <td>{line.equipment}</td>
              <td>{line.operation}</td>
              <td>{line.value}</td>
              <td data-operation-history-outcome-text>{line.outcome}</td>
              <td>{line.reason}</td>
              <td data-operation-history-repeat>{line.repeat}</td>
              <td>{line.duration}</td>
              <td>{line.auditId}</td>
            </tr>
          {:else}
            {#if loaded}
              <tr><td colspan="10">該当する操作はありません。</td></tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
    {#if nextBeforeSeq !== null}
      <button
        type="button"
        disabled={busy}
        onclick={() => load(true)}
        data-operation-history-more>さらに読む</button
      >
    {/if}
  </div>
</Modal>

<style>
  .operation-history {
    display: grid;
    gap: 0.75rem;
    color: var(--banto-text);
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.5rem;
  }
  .outcomes {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    margin: 0;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--banto-border);
    font-size: 0.85rem;
  }
  .outcomes label {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .notice {
    margin: 0;
    padding: 0.4rem 0.6rem;
    border-left: 3px solid var(--banto-warning, #d97706);
    background: var(--banto-surface);
  }
  .table-wrap {
    max-height: 55vh;
    overflow: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  th,
  td {
    border-bottom: 1px solid var(--banto-border);
    padding: 0.3rem 0.4rem;
    text-align: left;
    white-space: nowrap;
  }
  thead th {
    position: sticky;
    top: 0;
    background: var(--banto-surface);
  }
</style>
