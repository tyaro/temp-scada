<script lang="ts">
  import { untrack } from "svelte";
  import { Modal } from "@banto/ui";
  import type { AlarmSnapshot } from "../alarm-mirror";
  import {
    ALARM_EVENT_KINDS,
    ALARM_HISTORY_PAGE,
    alarmAckRefusalText,
    alarmAckResultText,
    alarmAckTargets,
    alarmBuzzerText,
    alarmHistoryQuery,
    alarmHistoryRow,
    alarmListCurrent,
    alarmRowSelected,
    type AlarmAckSelection,
    type AlarmHistoryRow,
    type AlarmListFilter,
    type AlarmListRow,
  } from "../alarm-list";
  import {
    ProjectFileError,
    type AlarmAckResult,
    type AlarmFeed,
  } from "../project-file-service";

  /**
   * アラーム一覧の窓（「現在」と「履歴」）。運転表示の間はその中に描く。
   * 仕様: docs/design/graphics/alarm-list.md、docs/design/runtime/alarm-stage3-design.md §6・§7。
   * 表示と ACK は Engine の状態を読むだけで、PLC には書かない。
   */
  let {
    open,
    snapshot,
    feed,
    readError = null,
    projectId,
    projectRevision,
    onclose,
    onrefresh,
    focusFallback,
  }: {
    open: boolean;
    snapshot: AlarmSnapshot | null;
    feed?: AlarmFeed;
    readError?: string | null;
    projectId: string;
    projectRevision: number;
    onclose: () => void;
    /** ACK の後に snapshot を取り直させる（「別の回」を最新にする）。 */
    onrefresh: () => void;
    focusFallback?: () => HTMLElement | null | undefined;
  } = $props();

  let tab = $state<"current" | "history">("current");
  let filter = $state<AlarmListFilter>("all");
  /** 選んだ行の回。表示中の回と違えば選んでいない扱い（§6 見ている回を指す）。 */
  let selected = $state.raw<AlarmAckSelection>(new Map());
  let acking = $state(false);
  /** 最後の ACK の結果（condition id ごと。送った時の名前を持つ）。 */
  let results = $state.raw<
    ReadonlyMap<
      string,
      { name: string; kind: AlarmAckResult["result"]["kind"]; text: string }
    >
  >(new Map());
  let ackIssue = $state<string | null>(null);
  let buzzerIssue = $state<string | null>(null);

  let historyFrom = $state(""),
    historyTo = $state(""),
    historyKind = $state("");
  let historyRows = $state.raw<AlarmHistoryRow[]>([]);
  let historyMore = $state(false);
  let historyBusy = $state(false);
  let historyIssue = $state<string | null>(null);
  let historyLoaded = $state(false);
  /** 表示中の行を取った照会の条件。「続きを読む」はこれを使う。 */
  let historySubmitted: { from: string; to: string; kind: string } | null =
    null;
  /**
   * 表示中の履歴の照会先（feed と監視中の Project）。host は監視中の Project の DB を
   * 照会するので、照会先が変われば行・カーソルを捨て、古い照会の応答も採らない。
   */
  type HistoryOwner = { feed: AlarmFeed | undefined; projectId: string | null };
  let historyOwner: HistoryOwner | null = null;
  const currentOwner = $derived<HistoryOwner>({
    feed,
    projectId: snapshot?.monitored?.projectId ?? null,
  });
  function sameOwner(a: HistoryOwner | null, b: HistoryOwner): boolean {
    return !!a && a.feed === b.feed && a.projectId === b.projectId;
  }
  // 照会先が変わったら表示中の行・カーソルを捨てる（取り直しは下の effect）。
  $effect(() => {
    const owner = currentOwner;
    if (!historyLoaded || sameOwner(historyOwner, owner)) return;
    historyRows = [];
    historyMore = false;
    historyLoaded = false;
    historySubmitted = null;
    historyOwner = null;
  });
  /** 自動で照会した照会先。照会先ごとに 1 回だけ自動で照会する（失敗で繰り返さない）。 */
  let historyAutoOwner: HistoryOwner | null = null;
  // 「履歴」タブを開いていて、まだ行の無い照会先なら照会する。前の照会先の照会が
  // 終わるのを待ってから始める（historyBusy が下りると再評価される）。窓を閉じて
  // いる間に照会先が変わった場合も、履歴タブのまま開き直したときに照会する。
  $effect(() => {
    const owner = currentOwner;
    if (!open || tab !== "history" || historyLoaded || historyBusy) return;
    if (sameOwner(historyAutoOwner, owner)) return;
    historyAutoOwner = owner;
    untrack(() => void loadHistory(false));
  });

  const current = $derived(
    alarmListCurrent(
      snapshot,
      { feed: !!feed, readError, projectId, projectRevision },
      filter,
    ),
  );
  const canAck = $derived(current.canAck && !!feed?.ack && !acking);
  const selectedTargets = $derived(alarmAckTargets(current.rows, selected));
  const allTargets = $derived(alarmAckTargets(current.rows));

  // 開くたびに前の選択・結果を捨てる。
  $effect(() => {
    if (!open) return;
    selected = new Map();
    results = new Map();
    ackIssue = null;
  });

  function toggle(row: AlarmListRow, checked: boolean) {
    const next = new Map(selected);
    if (checked && row.occurrence !== null)
      next.set(row.conditionId, {
        occurrence: row.occurrence,
        recurrence: row.recurrence,
      });
    else next.delete(row.conditionId);
    selected = next;
  }

  function reasonOf(error: unknown): string {
    if (error instanceof ProjectFileError) return error.reason;
    if (error instanceof Error) return error.message;
    return String(error);
  }

  async function ack(all: boolean) {
    const items = all ? allTargets : selectedTargets;
    if (!feed?.ack || !items.length || acking) return;
    const names = new Map(
      current.rows.map((row) => [row.conditionId, row.name] as const),
    );
    acking = true;
    ackIssue = null;
    try {
      const answer = await feed.ack(items);
      results = new Map(
        answer.map((row) => [
          row.conditionId,
          {
            name: names.get(row.conditionId) ?? row.conditionId,
            kind: row.result.kind,
            text: alarmAckResultText(row.result),
          },
        ]),
      );
      selected = new Map();
    } catch (error) {
      ackIssue = alarmAckRefusalText(reasonOf(error));
    } finally {
      acking = false;
      // 受理で消えた行・「別の回」の行を最新の snapshot で出し直す。
      onrefresh();
    }
  }

  async function loadHistory(more: boolean) {
    if (!feed?.history || historyBusy) return;
    const before = more ? (historyRows.at(-1)?.seq ?? null) : null;
    // 続きは最後に照会した条件で取る（入力欄を変えただけでは別の照会と混ぜない）。
    const filters =
      more && historySubmitted
        ? historySubmitted
        : { from: historyFrom, to: historyTo, kind: historyKind };
    const built = alarmHistoryQuery(filters, before);
    if ("issue" in built) {
      historyIssue = built.issue;
      return;
    }
    // 続きは同じ照会先でだけ取る（ほかの Project の DB へカーソルを送らない）。
    const owner = currentOwner;
    if (more && !sameOwner(historyOwner, owner)) return;
    historyBusy = true;
    historyIssue = null;
    try {
      const answer = await feed.history(built.query);
      // 照会の間に照会先が変わったら、応答は採らない（新しい照会先で取り直す）。
      if (!sameOwner(owner, currentOwner)) return;
      // 照会先が変わる前に取った行の続きは、捨てた行には足さない。
      if (more && !sameOwner(historyOwner, owner)) return;
      const rows = answer.map(alarmHistoryRow);
      historyRows = more ? [...historyRows, ...rows] : rows;
      historySubmitted = filters;
      historyOwner = owner;
      historyMore = answer.length >= ALARM_HISTORY_PAGE;
      historyLoaded = true;
    } catch (error) {
      if (sameOwner(owner, currentOwner))
        historyIssue = `履歴を取得できません（${reasonOf(error)}）`;
    } finally {
      historyBusy = false;
    }
  }

  /** ブザー停止（§6）。ACK ではないので、ACK の可否・ログインに関わらず押せる。 */
  async function silenceBuzzer() {
    if (!feed?.silenceBuzzer) return;
    buzzerIssue = null;
    try {
      await feed.silenceBuzzer();
    } catch (error) {
      buzzerIssue = `ブザーを止められませんでした（${reasonOf(error)}）`;
    } finally {
      onrefresh();
    }
  }

  function showTab(next: "current" | "history") {
    tab = next;
  }
  function tabKey(event: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = tab === "current" ? "history" : "current";
    showTab(
      event.key === "Home" ? "current" : event.key === "End" ? "history" : next,
    );
    (event.currentTarget as HTMLElement)
      .querySelector<HTMLButtonElement>('[aria-selected="true"]')
      ?.focus();
  }
</script>

<Modal {open} title="アラーム一覧" width="1100px" {onclose} {focusFallback}>
  <div class="alarm-list" data-alarm-list>
    <div class="toolbar buzzer">
      <span role="status" data-alarm-buzzer
        >{alarmBuzzerText(snapshot, !!feed?.silenceBuzzer)}</span
      >
      <button
        type="button"
        disabled={!feed?.silenceBuzzer}
        onclick={silenceBuzzer}>ブザー停止</button
      >
    </div>
    {#if buzzerIssue}<p class="notice" role="alert">{buzzerIssue}</p>{/if}
    <div
      role="tablist"
      aria-label="アラーム一覧の表示"
      tabindex="-1"
      onkeydown={tabKey}
    >
      <button
        type="button"
        role="tab"
        id="alarm-list-tab-current"
        aria-controls="alarm-list-panel-current"
        aria-selected={tab === "current"}
        tabindex={tab === "current" ? 0 : -1}
        onclick={() => showTab("current")}>現在</button
      >
      <button
        type="button"
        role="tab"
        id="alarm-list-tab-history"
        aria-controls="alarm-list-panel-history"
        aria-selected={tab === "history"}
        tabindex={tab === "history" ? 0 : -1}
        onclick={() => showTab("history")}>履歴</button
      >
    </div>

    <div
      role="tabpanel"
      id="alarm-list-panel-current"
      aria-labelledby="alarm-list-tab-current"
      hidden={tab !== "current"}
    >
      {#each current.notices as notice (notice)}
        <p class="notice" role="status" data-alarm-list-notice>{notice}</p>
      {/each}
      <div class="toolbar">
        <label class="banto-field"
          ><span class="banto-field-label">表示</span><select
            class="banto-field-control"
            aria-label="アラーム一覧の絞り込み"
            bind:value={filter}
            ><option value="all">すべて</option><option value="unavailable"
              >評価不能だけ</option
            ></select
          ></label
        >
        <button
          type="button"
          disabled={!canAck || !selectedTargets.length}
          onclick={() => ack(false)}>選んだ警報を ACK</button
        >
        <button
          type="button"
          disabled={!canAck || !allTargets.length}
          onclick={() => ack(true)}>すべて ACK</button
        >
      </div>
      {#if ackIssue}<p class="notice" role="alert">{ackIssue}</p>{/if}
      {#if results.size}
        <ul class="results" aria-label="ACK の結果" data-alarm-ack-results>
          {#each [...results] as [id, result] (id)}
            <li data-ack-result={result.kind}>{result.name}: {result.text}</li>
          {/each}
        </ul>
      {/if}
      <div class="table-wrap">
        <table aria-label="現在の警報">
          <thead>
            <tr>
              <th scope="col"><span class="sr-only">選択</span></th>
              <th scope="col">状態</th>
              <th scope="col">重要度</th>
              <th scope="col">発生</th>
              <th scope="col">名前</th>
              <th scope="col">限界</th>
              <th scope="col">メッセージ</th>
              <th scope="col">評価不能</th>
              <th scope="col">ACK の結果</th>
            </tr>
          </thead>
          <tbody>
            {#if current.engineRow}
              <tr class="engine" data-alarm-engine-row>
                <td></td>
                <td colspan="8">{current.engineRow}</td>
              </tr>
            {/if}
            {#each current.rows as row (row.conditionId)}
              <tr
                data-alarm-row={row.conditionId}
                data-alarm-state={row.state}
                class:unacked={row.unacked}
              >
                <td
                  ><input
                    type="checkbox"
                    aria-label={`${row.name} を選ぶ`}
                    disabled={!row.unacked || !canAck}
                    checked={alarmRowSelected(row, selected)}
                    onchange={(event) =>
                      toggle(row, event.currentTarget.checked)}
                  /></td
                >
                <td class="state">{row.stateText}</td>
                <td>{row.severityText}</td>
                <td>{row.time}</td>
                <td>{row.name}</td>
                <td>{row.limitLabel ?? ""}</td>
                <td>{row.message}</td>
                <td>{row.unavailableText}</td>
                <td data-alarm-row-result
                  >{results.get(row.conditionId)?.text ?? ""}</td
                >
              </tr>
            {:else}
              {#if !current.engineRow && !current.notices.length}
                <tr><td colspan="9">出ている警報はありません。</td></tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    </div>

    <div
      role="tabpanel"
      id="alarm-list-panel-history"
      aria-labelledby="alarm-list-tab-history"
      hidden={tab !== "history"}
    >
      {#if !feed?.history}
        <p class="notice" role="status">
          警報の Engine
          がありません（ブラウザ版）。警報の履歴はデスクトップ版で照会できます。
        </p>
      {:else}
        <form
          class="toolbar"
          onsubmit={(event) => {
            event.preventDefault();
            void loadHistory(false);
          }}
        >
          <label class="banto-field banto-field--stacked"
            ><span class="banto-field-label">開始（ローカル時刻）</span><input
              class="banto-field-control"
              type="datetime-local"
              step="1"
              bind:value={historyFrom}
            /></label
          >
          <label class="banto-field banto-field--stacked"
            ><span class="banto-field-label">終了（ローカル時刻）</span><input
              class="banto-field-control"
              type="datetime-local"
              step="1"
              bind:value={historyTo}
            /></label
          >
          <label class="banto-field banto-field--stacked"
            ><span class="banto-field-label">種類</span><select
              class="banto-field-control"
              bind:value={historyKind}
              ><option value="">すべて</option
              >{#each ALARM_EVENT_KINDS as [value, text] (value)}<option {value}
                  >{text}</option
                >{/each}</select
            ></label
          >
          <button type="submit" disabled={historyBusy}>照会</button>
        </form>
        {#if historyIssue}<p class="notice" role="alert">
            {historyIssue}
          </p>{/if}
        <div class="table-wrap">
          <table aria-label="警報の履歴">
            <thead>
              <tr>
                <th scope="col">時刻</th>
                <th scope="col">種類</th>
                <th scope="col">名前</th>
                <th scope="col">限界</th>
                <th scope="col">判定の限界</th>
                <th scope="col">値</th>
                <th scope="col">source timestamp</th>
                <th scope="col">メッセージ</th>
                <th scope="col">備考</th>
              </tr>
            </thead>
            <tbody>
              {#each historyRows as row (row.seq)}
                <tr data-alarm-event={row.seq}>
                  <td>{row.time}</td>
                  <td>{row.kindText}</td>
                  <td>{row.name}</td>
                  <td>{row.limitLabel}</td>
                  <td>{row.limit}</td>
                  <td>{row.value}</td>
                  <td>{row.sourceTime}</td>
                  <td>{row.message}</td>
                  <td>{row.note}</td>
                </tr>
              {:else}
                {#if historyLoaded}
                  <tr
                    ><td colspan="9">該当する警報イベントはありません。</td></tr
                  >
                {/if}
              {/each}
            </tbody>
          </table>
        </div>
        {#if historyMore}
          <button
            type="button"
            disabled={historyBusy}
            onclick={() => loadHistory(true)}>続きを読む</button
          >
        {/if}
      {/if}
    </div>
  </div>
</Modal>

<style>
  .alarm-list {
    display: grid;
    gap: 0.75rem;
    color: var(--banto-text);
  }
  [role="tablist"] {
    display: flex;
    border-bottom: 1px solid var(--banto-border);
  }
  [role="tab"] {
    padding: 0.5rem 1rem;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--banto-text-muted);
    font: inherit;
    cursor: pointer;
  }
  [role="tab"][aria-selected="true"] {
    color: var(--banto-primary);
    border-bottom-color: var(--banto-primary);
  }
  [role="tabpanel"] {
    display: grid;
    gap: 0.5rem;
  }
  [role="tabpanel"][hidden] {
    display: none;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.5rem;
  }
  .toolbar.buzzer {
    align-items: center;
    justify-content: space-between;
  }
  .notice {
    margin: 0;
    padding: 0.4rem 0.6rem;
    border-left: 3px solid var(--banto-warning, #d97706);
    background: var(--banto-surface);
  }
  .results {
    margin: 0;
    padding-left: 1.2rem;
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
  tr.unacked .state {
    font-weight: 700;
    outline: 2px solid currentColor;
    outline-offset: -3px;
  }
  tr.engine td {
    font-weight: 700;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
