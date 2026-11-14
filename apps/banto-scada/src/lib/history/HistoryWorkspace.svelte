<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { Modal } from "@banto/ui";
  import type { Project } from "../project";
  import {
    historyContext,
    historyFormQuery,
    historyPresetDefinition,
    historyPresetQuery,
    type HistoryPreset,
    newHistoryForm,
    type HistoryService,
    type HistoryContextState,
    type HistoryForm,
  } from "./workspace-model";
  import {
    createHistoryController,
    type HistoryController,
    type HistoryPresentation,
  } from "./presentation";
  import TrendView from "./TrendView.svelte";
  import {
    formatDuration,
    formatOffset,
    localInputToUtc,
    localOffsetMinutes,
    recentRange,
    utcToLocalInput,
  } from "./time-input";

  let {
    open,
    project,
    generation,
    service,
    onclose,
    focusFallback,
    preset,
    onrelease,
    controller: shared,
  }: {
    open: boolean;
    project: Project;
    generation: number;
    service?: HistoryService;
    preset?: HistoryPreset;
    onrelease?: () => void;
    onclose: () => void;
    focusFallback?: () => HTMLElement | null | undefined;
    /**
     * 呼び出し側が持つ controller。描き直し（運転表示の出入り）をまたいで読取の枠を
     * 1つに保つために渡す。渡されたものは破棄せず、外れるときは source を外すだけ。
     */
    controller?: HistoryController;
  } = $props();
  // This owner remains mounted while the Modal body closes. Abort does not free
  // the physical read slot: the controller waits for the old Promise to settle.
  const external = untrack(() => shared);
  const controller = external ?? createHistoryController();
  let presentation = $state.raw<HistoryPresentation>(controller.state);
  const unsubscribe = controller.subscribe((next) => (presentation = next));
  onDestroy(() => {
    unsubscribe();
    if (external) controller.setSource(undefined);
    else controller.dispose();
  });
  let owner = $state.raw<{
    project: Project;
    generation: number;
    service?: HistoryService;
    open: boolean;
    preset?: HistoryPreset;
    selection: HistoryContextState;
  }>();
  let form = $state<HistoryForm>(newHistoryForm());
  let filter = $state("");
  let sequence = 0;
  $effect(() => {
    const next = { project, generation, service, open, preset };
    untrack(() => {
      controller.setSource(undefined);
      const selection = historyContext(next.service, next.project);
      owner = { ...next, selection };
      form = newHistoryForm();
      filter = "";
      if (next.open && selection.phase === "ready")
        controller.setSource(next.service?.source);
    });
  });
  // Guard the render and actions before effects flush, including same-ID/revision
  // Project replacement and service changes with the same underlying source.
  const current = $derived(
    open &&
      owner?.open &&
      owner.project === project &&
      owner.generation === generation &&
      owner.service === service &&
      owner.preset === preset,
  );
  const context = $derived(
    current && owner?.selection.phase === "ready"
      ? owner.selection.context
      : undefined,
  );
  const definition = $derived(
    preset
      ? project.trends?.find((row) => row.id === preset.definitionId)
      : undefined,
  );
  const resolved = $derived(
    context && preset
      ? historyPresetDefinition(project, context, preset.definitionId)
      : undefined,
  );
  const draft = $derived(
    context
      ? preset
        ? resolved?.definition
          ? historyPresetQuery(
              context,
              resolved.definition,
              form.to,
              "history-preview",
            )
          : { issue: resolved?.issue ?? "保存トレンドを確認できません" }
        : historyFormQuery(context, form, "history-preview")
      : undefined,
  );
  const from = $derived(
    preset
      ? draft?.query
        ? new Date(draft.query.fromMs).toISOString()
        : ""
      : form.from,
  );

  const visible = $derived(
    current
      ? presentation
      : ({ phase: "offline", waiting: false } as HistoryPresentation),
  );
  const rows = $derived(
    context?.series.filter((row) =>
      `${row.label} ${row.seriesId}`
        .toLocaleLowerCase()
        .includes(filter.toLocaleLowerCase()),
    ) ?? [],
  );
  const connection = $derived(
    !current
      ? "履歴の接続を確認中です"
      : owner?.selection.phase === "offline"
        ? "履歴サービスは未接続です"
        : owner?.selection.phase === "invalid"
          ? "履歴系列一覧を確認できません。接続元の設定を確認してください"
          : owner?.selection.phase === "mismatch"
            ? "履歴系列一覧が現在のProjectと一致しません。接続元の更新が必要です"
            : !context?.series.length
              ? "検索できる履歴系列が提供されていません"
              : "履歴系列一覧を確認しました",
  );
  function change(patch: Partial<HistoryForm>) {
    if (!current) return;
    controller.setSource(undefined);
    if (context) controller.setSource(service?.source);
    form = { ...form, ...patch };
  }
  // Local-time entry is display-only sugar: the UTC text fields stay the source.
  const offset = $derived(localOffsetMinutes(Date.now()));
  function setRecent(durationMs: number) {
    const range = recentRange(Date.now(), durationMs);
    change(preset ? { to: range.to } : range);
  }
  function setLocal(key: "from" | "to", value: string) {
    const utc = localInputToUtc(value, offset);
    if (utc !== undefined) change({ [key]: utc });
  }
  function toggle(id: string, checked: boolean) {
    change({
      selected: checked
        ? [...form.selected, id]
        : form.selected.filter((value) => value !== id),
    });
  }
  function load(event: SubmitEvent) {
    event.preventDefault();
    if (!current || !context) return;
    const requestId = `history:${++sequence}`;
    const latest = preset
      ? historyPresetDefinition(project, context, preset.definitionId)
      : undefined;
    const input = preset
      ? latest?.definition
        ? historyPresetQuery(context, latest.definition, form.to, requestId)
        : undefined
      : historyFormQuery(context, form, requestId);
    if (input?.query) controller.load(input.query);
  }
  function close() {
    // Retire synchronously; don't wait for the parent's open prop/effect.
    controller.setSource(undefined);
    onclose();
  }
</script>

<Modal
  {open}
  title="履歴トレンド"
  width="1000px"
  onclose={close}
  {focusFallback}
>
  <div class="history-workspace">
    <p role="status">{connection}</p>
    {#if current && owner?.selection.phase === "offline"}
      <p class="hint" data-history-offline-guide>
        履歴を見るには、Hub に接続し、記録を開始している必要があります。Hub
        の接続状態を確認し、「記録計画の操作」から記録を開始してください。
      </p>
    {/if}
    {#if preset}
      <section aria-label="保存トレンドの設定">
        <strong>{definition?.name ?? "保存トレンド"}</strong>
        <p>namespace: {definition?.historianNamespace ?? "不明"}</p>
        {#each definition?.pens ?? [] as pen (pen.id)}<p>
            {pen.label !== undefined
              ? `別名: ${pen.label} · `
              : ""}{pen.seriesId} · {pen.color}
          </p>{/each}
        <p>
          期間 {definition ? formatDuration(definition.windowMs) : "不明"} · {definition?.mode}
          · 系列ごとの点数上限
          {definition?.maxPointsPerSeries}
        </p>
        <p>系列一覧の一致は記録済み・保持中であることを保証しません。</p>
        {#if resolved?.issue}<p role="status">{resolved.issue}</p>{/if}
        <button
          type="button"
          onclick={() => {
            controller.setSource(undefined);
            onrelease?.();
          }}>保存トレンドを解除して手動検索</button
        >
      </section>
    {/if}
    <form onsubmit={load}>
      <fieldset disabled={!context}>
        <legend>検索条件</legend>
        {#if !preset}
          <label class="banto-field banto-field--stacked"
            ><span class="banto-field-label">系列の絞り込み </span><input
              class="banto-field-control"
              type="search"
              bind:value={filter}
            /></label
          >
          <div class="series-list" role="group" aria-label="検索する履歴系列">
            {#each rows as row (row.seriesId)}
              <label class="series-row">
                <input
                  type="checkbox"
                  checked={form.selected.includes(row.seriesId)}
                  disabled={!form.selected.includes(row.seriesId) &&
                    form.selected.length >= 8}
                  onchange={(event) =>
                    toggle(row.seriesId, event.currentTarget.checked)}
                />
                <span>{row.label} <small>{row.seriesId}</small></span>
              </label>
            {/each}
            {#if context?.series.length && !rows.length}<p>
                一致する系列はありません
              </p>{/if}
          </div>
          <p>選択 {form.selected.length} / 8系列</p>
        {/if}
        <div class="quick" role="group" aria-label="期間の指定">
          {#if preset}
            <button type="button" onclick={() => setRecent(0)}
              >いまを終了にする</button
            >
          {:else}
            <button type="button" onclick={() => setRecent(600_000)}
              >直近10分</button
            >
            <button type="button" onclick={() => setRecent(3_600_000)}
              >直近1時間</button
            >
          {/if}
          <small
            >ローカル時刻は {formatOffset(offset)} として UTC に変換します</small
          >
        </div>
        <div class="conditions">
          <label class="banto-field banto-field--stacked"
            ><span class="banto-field-label">開始（ローカル時刻） </span><input
              class="banto-field-control"
              type="datetime-local"
              step="1"
              value={utcToLocalInput(from, offset)}
              readonly={!!preset}
              onchange={(event) => setLocal("from", event.currentTarget.value)}
            /></label
          >
          <label class="banto-field banto-field--stacked"
            ><span class="banto-field-label">終了（ローカル時刻） </span><input
              class="banto-field-control"
              type="datetime-local"
              step="1"
              value={utcToLocalInput(form.to, offset)}
              onchange={(event) => setLocal("to", event.currentTarget.value)}
            /></label
          >
          <label class="banto-field banto-field--stacked"
            ><span class="banto-field-label">開始UTC </span><input
              class="banto-field-control"
              type="text"
              value={from}
              readonly={!!preset}
              placeholder="2026-11-02T00:00:00.000Z"
              spellcheck="false"
              oninput={(event) => change({ from: event.currentTarget.value })}
            /></label
          >
          <label class="banto-field banto-field--stacked"
            ><span class="banto-field-label">終了UTC </span><input
              class="banto-field-control"
              type="text"
              value={form.to}
              placeholder="2026-11-02T01:00:00.000Z"
              spellcheck="false"
              oninput={(event) => change({ to: event.currentTarget.value })}
            /></label
          >
          <label class="banto-field banto-field--stacked"
            ><span class="banto-field-label">取得モード </span><select
              class="banto-field-control"
              value={definition?.mode ?? form.mode}
              disabled={!!preset}
              onchange={(event) => change({ mode: event.currentTarget.value })}
              ><option value="raw">raw（観測点）</option><option value="minmax"
                >minmax（区間の最小・最大）</option
              ></select
            ></label
          >
          <label class="banto-field banto-field--stacked"
            ><span class="banto-field-label">系列ごとの点数上限 </span><input
              class="banto-field-control"
              type="text"
              inputmode="numeric"
              value={definition?.maxPointsPerSeries ?? form.points}
              readonly={!!preset}
              oninput={(event) => change({ points: event.currentTarget.value })}
            /></label
          >
        </div>
      </fieldset>
      <p class="hint">
        ローカル時刻の入力は UTC
        に変換して下のUTC欄へ反映されます。UTC欄は直接入力もできます（末尾Z・ミリ秒3桁）。終了時刻を含まない1時間以内、各系列2000点・合計8000点まで取得できます。
      </p>
      {#if draft?.issue}<p class="hint" role="status">{draft.issue}</p>{/if}
      <div class="actions">
        <button type="submit" disabled={!draft?.query}>取得</button>
        <button
          type="button"
          disabled={!current || presentation.phase !== "loading"}
          onclick={() => {
            if (current) controller.cancel();
          }}>取消</button
        >
        <button type="button" onclick={close}>閉じる</button>
      </div>
    </form>
    <TrendView
      state={visible}
      pens={current && preset ? resolved?.definition?.pens : undefined}
    />
  </div>
</Modal>

<style>
  .history-workspace {
    display: grid;
    gap: 0.75rem;
    color: var(--banto-text);
  }
  p {
    margin: 0 0 0.5rem;
  }
  fieldset {
    border: 1px solid var(--banto-border);
    border-radius: 0.4rem;
    padding: 0.75rem;
  }
  label {
    display: grid;
    gap: 0.3rem;
  }
  input[type="text"],
  input[type="search"],
  select {
    width: 100%;
    min-width: 0;
    background: var(--banto-surface);
    color: var(--banto-text);
    border: 1px solid var(--banto-border);
    border-radius: 0.25rem;
    padding: 0.4rem;
  }
  .series-list {
    max-height: 10rem;
    overflow: auto;
    margin: 0.75rem 0;
  }
  .series-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.2rem;
  }
  small {
    margin-left: 0.5rem;
    color: var(--banto-text-muted);
    overflow-wrap: anywhere;
  }
  .conditions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
  }
  .quick {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0.5rem 0;
  }
  .hint {
    font-size: 0.85rem;
    color: var(--banto-text-muted);
    margin-top: 0.5rem;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    margin: 0.75rem 0;
  }
  @media (max-width: 600px) {
    .conditions {
      grid-template-columns: 1fr;
    }
  }
</style>
