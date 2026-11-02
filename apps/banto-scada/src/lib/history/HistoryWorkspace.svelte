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
    type HistoryPresentation,
  } from "./presentation";
  import TrendView from "./TrendView.svelte";

  let {
    open,
    project,
    generation,
    service,
    onclose,
    focusFallback,
    preset,
    onrelease,
  }: {
    open: boolean;
    project: Project;
    generation: number;
    service?: HistoryService;
    preset?: HistoryPreset;
    onrelease?: () => void;
    onclose: () => void;
    focusFallback?: () => HTMLElement | null | undefined;
  } = $props();
  // This owner remains mounted while the Modal body closes. Abort does not free
  // the physical read slot: the controller waits for the old Promise to settle.
  const controller = createHistoryController();
  let presentation = $state.raw<HistoryPresentation>(controller.state);
  const unsubscribe = controller.subscribe((next) => (presentation = next));
  onDestroy(() => {
    unsubscribe();
    controller.dispose();
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
          期間 {definition?.windowMs} ms · {definition?.mode} · 系列ごとの点数上限
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
          <label
            >系列の絞り込み <input type="search" bind:value={filter} /></label
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
        <div class="conditions">
          <label
            >開始UTC <input
              type="text"
              value={from}
              readonly={!!preset}
              placeholder="2026-11-02T00:00:00.000Z"
              spellcheck="false"
              oninput={(event) => change({ from: event.currentTarget.value })}
            /></label
          >
          <label
            >終了UTC <input
              type="text"
              value={form.to}
              placeholder="2026-11-02T01:00:00.000Z"
              spellcheck="false"
              oninput={(event) => change({ to: event.currentTarget.value })}
            /></label
          >
          <label
            >取得モード <select
              value={definition?.mode ?? form.mode}
              disabled={!!preset}
              onchange={(event) => change({ mode: event.currentTarget.value })}
              ><option value="raw">raw（観測点）</option><option value="minmax"
                >minmax（区間の最小・最大）</option
              ></select
            ></label
          >
          <label
            >系列ごとの点数上限 <input
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
        UTC（末尾Z・ミリ秒3桁）で指定します。終了時刻を含まない1時間以内、各系列2000点・合計8000点まで取得できます。
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
